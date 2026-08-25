import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExcludedEntry, PromotedEntry } from '../../packages/forgeyard/src/types.ts'
import { GitAuthority, type PreparedWorktree } from '../../packages/forgeyard/src/host/git.ts'
import {
  assertTreeMatchesProjection,
  NOT_CARRIED,
  PromotionProjector,
} from '../../packages/forgeyard/src/host/promotion.ts'
import { makeCanonicalTempDir, run, seedRepository, testRuntime, type TestRuntime } from '../helpers/runtime.ts'

const ATTEMPT = 'attempt_00000000-0000-4000-8000-0000000000a1'
const OTHER = 'attempt_00000000-0000-4000-8000-0000000000a2'
const IDENTITY = { name: 'Forgeyard', email: 'forgeyard@promotion.invalid', epochSeconds: 1_700_000_000 }

describe('real Git promotion projection', () => {
  let root: string
  let runtime: TestRuntime
  let repositoryPath: string
  let git: GitAuthority
  let projector: PromotionProjector

  beforeEach(async () => {
    root = await makeCanonicalTempDir('forgeyard-promotion-')
    runtime = await testRuntime()
    repositoryPath = await seedRepository(runtime.runner, root)
    await writeFile(join(repositoryPath, '.gitignore'), 'build/\n*.log\n')
    await run(runtime.runner, repositoryPath, ['git', 'add', '--', '.gitignore'])
    await run(runtime.runner, repositoryPath, ['git', 'commit', '-m', 'ignore build output'])
    git = new GitAuthority(runtime.runner, {
      allowedRepositoryRoots: [repositoryPath],
      worktreeRoot: join(root, 'attempt-worktrees'),
      commandTimeoutMs: 20_000,
      captureBytes: 2 * 1024 * 1024,
      spillBytes: 8 * 1024 * 1024,
      reviewDiffBytes: 256 * 1024,
    })
    projector = new PromotionProjector({ previewBytes: 256 * 1024, spillBytes: 8 * 1024 * 1024 })
    // The GitAuthority prepares its managed directories eagerly, and one test
    // here never issues a Git command. Settle that readiness now, or those
    // mkdirs land inside the temp root while `afterEach` is removing it.
    await git.canonicalize(repositoryPath)
  })

  afterEach(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  async function preparedWorktree(attemptId = ATTEMPT): Promise<PreparedWorktree> {
    const repository = await git.canonicalize(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    return git.createWorktree(repository, baseCommit, attemptId)
  }

  /**
   * Build a workspace that exercises every case the projection must decide:
   * a modified tracked file, a deleted tracked file, an untracked file, an
   * executable, an owner-only file, a symlink, an ignored file, an ignored
   * directory, and an empty directory.
   */
  async function populate(prepared: PreparedWorktree): Promise<void> {
    await writeFile(join(prepared.path, 'source.txt'), 'promoted content\n')
    await rm(join(prepared.path, 'verify.mjs'))
    await writeFile(join(prepared.path, 'added.txt'), 'untracked deliverable\n')
    await writeFile(join(prepared.path, 'run.sh'), '#!/bin/sh\necho promoted\n')
    await chmod(join(prepared.path, 'run.sh'), 0o755)
    await writeFile(join(prepared.path, 'secret.env'), 'TOKEN=local\n')
    await chmod(join(prepared.path, 'secret.env'), 0o600)
    await symlink('source.txt', join(prepared.path, 'link.txt'))
    await writeFile(join(prepared.path, 'debug.log'), 'ignored verifier noise\n')
    await mkdir(join(prepared.path, 'build'))
    await writeFile(join(prepared.path, 'build', 'artifact.txt'), 'ignored build output\n')
    await mkdir(join(prepared.path, 'empty-dir'))
  }

  it('classifies every reviewed entry and carries only the Git-representable deliverable', async () => {
    const prepared = await preparedWorktree()
    await populate(prepared)

    const view = await git.promotionView(prepared)
    const projected = await projector.project(prepared.path, view)
    const promoted = new Map(projected.promotedEntries.map(entry => [entry.path, entry] as const))
    const excluded = new Map(projected.projection.excluded.preview.map(entry => [entry.path, entry] as const))

    expect(projected.promotedPaths).toEqual([
      '.gitignore', 'added.txt', 'link.txt', 'run.sh', 'secret.env', 'source.txt',
    ])
    expect(promoted.get('source.txt')).toMatchObject({ type: 'file', gitMode: '100644' })
    expect(promoted.get('run.sh')).toMatchObject({ type: 'file', gitMode: '100755' })
    expect(promoted.get('link.txt')).toMatchObject({ type: 'symlink', gitMode: '120000' })
    // A deleted tracked file is part of the deliverable precisely by being absent.
    expect(projected.promotedPaths).not.toContain('verify.mjs')

    expect(excluded.get('.git')).toMatchObject({ reason: 'git-admin' })
    expect(excluded.get('debug.log')).toMatchObject({ reason: 'ignored', type: 'file' })
    expect(excluded.get('build/artifact.txt')).toMatchObject({ reason: 'ignored', type: 'file' })
    expect(excluded.get('build')).toMatchObject({ reason: 'directory-dropped', type: 'directory' })
    expect(excluded.get('empty-dir')).toMatchObject({ reason: 'directory-dropped', type: 'directory' })
    expect(excluded.get('.')).toMatchObject({ reason: 'directory-implied', type: 'directory' })

    // The projection is total: nothing in the reviewed manifest is unaccounted for.
    const projection = projected.projection
    expect(projection.manifestEntryCount).toBe(view.manifest.entries.length)
    expect(projection.promoted.count + projection.excluded.count).toBe(projection.manifestEntryCount)
    expect(projection.workspaceHash).toBe(view.fingerprint.workspaceHash)
    expect(projection.notCarried).toEqual([...NOT_CARRIED])
    expect(projection.hash).toMatch(/^[0-9a-f]{64}$/u)

    // An owner-only file is carried as content, but its restriction is not.
    expect(projection.unrepresentableModes.preview.map(entry => entry.path)).toContain('secret.env')
  })

  it('writes a tree whose every entry is the exact reviewed bytes, and a deterministic commit', async () => {
    const prepared = await preparedWorktree()
    await populate(prepared)
    const view = await git.promotionView(prepared)
    const projected = await projector.project(prepared.path, view)

    const written = await git.writePromotionTree(prepared, ATTEMPT, projected.promotedPaths)
    assertTreeMatchesProjection(projected.promotedEntries, written.entries)
    const listed = await git.readTreeEntries(prepared, written.tree)
    assertTreeMatchesProjection(projected.promotedEntries, listed)
    expect(listed.map(entry => entry.path).sort()).toEqual([...projected.promotedPaths].sort())

    // Independent byte-for-byte proof: read each promoted blob back out of Git.
    for (const entry of projected.promotedEntries) {
      const shown = await run(runtime.runner, prepared.path, ['git', 'cat-file', 'blob', entry.blobOid])
      const expectedBytes = entry.type === 'symlink'
        ? Buffer.from('source.txt')
        : await readFile(join(prepared.path, entry.path))
      expect(shown.stdout.text).toBe(expectedBytes.toString('utf8'))
    }

    const first = await git.createPromotionCommit(prepared, written.tree, prepared.baseCommit, 'forgeyard: promote\n', IDENTITY)
    const second = await git.createPromotionCommit(prepared, written.tree, prepared.baseCommit, 'forgeyard: promote\n', IDENTITY)
    expect(second).toBe(first)

    // Ambient repository configuration must not decide what a promotion is
    // called. `i18n.commitEncoding` adds an `encoding` header and changes the
    // object name for the same tree, parent, message, identity, and date, which
    // would break the retry-recomputes-the-same-commit recovery story.
    await run(runtime.runner, prepared.repository.path, ['git', 'config', '--local', 'i18n.commitEncoding', 'ISO-8859-1'])
    try {
      const encoded = await git.createPromotionCommit(
        prepared, written.tree, prepared.baseCommit, 'forgeyard: promote\n', IDENTITY,
      )
      expect(encoded).toBe(first)
    } finally {
      await run(runtime.runner, prepared.repository.path, ['git', 'config', '--local', '--unset', 'i18n.commitEncoding'])
    }
    expect(await git.readCommitTree(prepared, first)).toBe(written.tree)

    // Rebuilding the same reviewed state must reproduce the identical objects.
    const rebuilt = await git.writePromotionTree(prepared, ATTEMPT, projected.promotedPaths)
    expect(rebuilt.tree).toBe(written.tree)

    // The Attempt worktree and its index are untouched by the promotion.
    expect((await git.liveFingerprint(prepared)).digest).toBe(view.fingerprint.digest)
    const status = await run(runtime.runner, prepared.path, ['git', 'status', '--porcelain=v2', '-z', '--untracked-files=all'])
    expect(status.stdout.text).toContain('source.txt')
    expect(status.stdout.text).not.toContain('1 M.')
  })

  it('creates a Forgeyard-namespaced ref exactly once and never overwrites a colliding one', async () => {
    const prepared = await preparedWorktree()
    await populate(prepared)
    const view = await git.promotionView(prepared)
    const projected = await projector.project(prepared.path, view)
    const written = await git.writePromotionTree(prepared, ATTEMPT, projected.promotedPaths)
    const commit = await git.createPromotionCommit(prepared, written.tree, prepared.baseCommit, 'forgeyard: promote\n', IDENTITY)
    const ref = GitAuthority.promotionRef(ATTEMPT)
    expect(ref).toBe(`refs/forgeyard/promotions/${ATTEMPT}`)

    expect(await git.readPromotionRef(repositoryPath, ref)).toBeNull()
    await git.createPromotionRef(prepared.repository.path, ref, commit)
    expect(await git.readPromotionRef(repositoryPath, ref)).toBe(commit)
    await expect(git.createPromotionRef(prepared.repository.path, ref, commit))
      .rejects.toThrow(/could not be created/u)

    const collided = GitAuthority.promotionRef(OTHER)
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', collided, prepared.baseCommit])
    await expect(git.createPromotionRef(prepared.repository.path, collided, commit))
      .rejects.toThrow(/could not be created/u)
    expect(await git.readPromotionRef(repositoryPath, collided)).toBe(prepared.baseCommit)

    // Forgeyard refuses to write anything outside its own namespace.
    await expect(git.createPromotionRef(prepared.repository.path, 'refs/heads/main', commit))
      .rejects.toThrow(/only writes refs under/u)

    // The operator checkout keeps its branch, HEAD, and clean working tree.
    const branches = await run(runtime.runner, repositoryPath, ['git', 'for-each-ref', '--format=%(refname)', 'refs/heads/'])
    expect(branches.stdout.text.trim()).toBe('refs/heads/main')
    const baseStatus = await run(runtime.runner, repositoryPath, ['git', 'status', '--porcelain=v2', '-z', '--untracked-files=all'])
    expect(baseStatus.stdout.text).toBe('')
    expect(await readFile(join(repositoryPath, 'source.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(join(repositoryPath, 'verify.mjs'), 'utf8')).toContain('expected fixed result')
  })

  it('fails closed when Git and the reviewed raw workspace disagree about a path', async () => {
    const prepared = await preparedWorktree()
    await writeFile(join(prepared.path, 'added.txt'), 'deliverable\n')
    const view = await git.promotionView(prepared)
    // Model a stale Git view that no longer explains a reviewed workspace entry.
    const hidden = { ...view, untracked: view.untracked.filter(path => path !== 'added.txt') }
    await expect(projector.project(prepared.path, hidden))
      .rejects.toThrow(/neither tracked, untracked, nor ignored/u)

    const doubled = { ...view, ignored: [...view.ignored, 'added.txt'].sort() }
    await expect(projector.project(prepared.path, doubled))
      .rejects.toThrow(/both untracked and ignored/u)

    const phantom = { ...view, untracked: [...view.untracked, 'never-existed.txt'].sort() }
    await expect(projector.project(prepared.path, phantom))
      .rejects.toThrow(/does not hold as a file or symlink/u)
  })

  it('fails closed on an embedded repository rather than promoting part of it', async () => {
    const prepared = await preparedWorktree()
    const embedded = join(prepared.path, 'vendor')
    await mkdir(embedded)
    await run(runtime.runner, embedded, ['git', 'init', '-q', '-b', 'main'])
    await writeFile(join(embedded, 'inner.txt'), 'another repository\n')

    // Git reports an embedded repository as the directory `vendor/`, which the
    // reviewed raw workspace holds as a directory, not a file or symlink. Both
    // the trusted collector and the projection refuse it.
    await expect(git.promotionView(prepared)).rejects.toThrow(/unsupported untracked file type: vendor\//u)
    const manifest = await git.collectWorkspaceManifest(prepared.path)
    await expect(projector.project(prepared.path, {
      fingerprint: {
        baseCommit: prepared.baseCommit, headCommit: prepared.baseCommit, statusHash: '', diffHash: '',
        untrackedHash: '', workspaceHash: manifest.hash, digest: '',
      },
      manifest,
      headCommit: prepared.baseCommit,
      objectFormat: 'sha1',
      tracked: ['.gitignore', 'source.txt', 'verify.mjs'],
      untracked: ['vendor/'],
      ignored: [],
    })).rejects.toThrow(/does not hold as a file or symlink/u)
  })

  it('rejects a promoted tree that does not match the declared projection', async () => {
    const promoted: PromotedEntry[] = [{
      path: 'source.txt', type: 'file', gitMode: '100644', mode: '33188',
      sizeBytes: '5', contentHash: 'a'.repeat(64), blobOid: 'b'.repeat(40),
    }]
    expect(() => assertTreeMatchesProjection(promoted, [])).toThrow(/0 entries but the projection declares 1/u)
    expect(() => assertTreeMatchesProjection(promoted, [{ mode: '100644', oid: 'b'.repeat(40), path: 'other.txt' }]))
      .toThrow(/missing the declared deliverable path/u)
    expect(() => assertTreeMatchesProjection(promoted, [{ mode: '100755', oid: 'b'.repeat(40), path: 'source.txt' }]))
      .toThrow(/recorded mode 100755/u)
    expect(() => assertTreeMatchesProjection(promoted, [{ mode: '100644', oid: 'c'.repeat(40), path: 'source.txt' }]))
      .toThrow(/different object/u)
  })

  it('projects an all-ignored workspace to an empty tree without inventing content', async () => {
    // Ignore through the shared repository exclude file so the deliverable can
    // legitimately delete every tracked path, including .gitignore itself.
    await writeFile(join(repositoryPath, '.git', 'info', 'exclude'), '*.log\n')
    const prepared = await preparedWorktree()
    for (const path of ['source.txt', 'verify.mjs', '.gitignore']) await rm(join(prepared.path, path))
    await writeFile(join(prepared.path, 'debug.log'), 'only ignored state remains\n')
    await mkdir(join(prepared.path, 'empty-dir'))

    const view = await git.promotionView(prepared)
    const projected = await projector.project(prepared.path, view)
    expect(projected.promotedPaths).toEqual([])
    const reasons = new Set<ExcludedEntry['reason']>(
      projected.projection.excluded.preview.map(entry => entry.reason),
    )
    expect(reasons).toContain('directory-dropped')

    const written = await git.writePromotionTree(prepared, ATTEMPT, [])
    expect(written.entries).toEqual([])
    // Git's canonical empty tree; the deliverable is an explicit empty result.
    expect(await git.readTreeEntries(prepared, written.tree)).toEqual([])
    const commit = await git.createPromotionCommit(prepared, written.tree, prepared.baseCommit, 'forgeyard: promote\n', IDENTITY)
    expect(await git.readCommitTree(prepared, commit)).toBe(written.tree)
  })
})
