import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareRawWorkspaceManifests,
  GitAuthority,
  isContained,
} from '../../packages/forgeyard/src/host/git.ts'
import { makeCanonicalTempDir, run, seedRepository, testRuntime, type TestRuntime } from '../helpers/runtime.ts'

const ATTEMPT_1 = 'attempt_00000000-0000-4000-8000-000000000001'
const ATTEMPT_2 = 'attempt_00000000-0000-4000-8000-000000000002'

describe('real Git isolation authority', () => {
  let root: string
  let runtime: TestRuntime
  let repositoryPath: string
  let git: GitAuthority

  beforeEach(async () => {
    root = await makeCanonicalTempDir('forgeyard-real-git-')
    runtime = await testRuntime()
    repositoryPath = await seedRepository(runtime.runner, root)
    git = new GitAuthority(runtime.runner, {
      allowedRepositoryRoots: [repositoryPath],
      worktreeRoot: join(root, 'attempt-worktrees'),
      commandTimeoutMs: 20_000,
      captureBytes: 2 * 1024 * 1024,
      spillBytes: 8 * 1024 * 1024,
      reviewDiffBytes: 256 * 1024,
    })
  })

  afterEach(async () => {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('canonicalizes, resolves an immutable base, isolates changes, and creates unique retry worktrees', async () => {
    const nested = join(repositoryPath, 'nested')
    await mkdir(nested)
    const repository = await git.canonicalize(nested)
    expect(repository.path).toBe(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    expect(baseCommit).toMatch(/^[0-9a-f]{40}$/u)

    const first = await git.createWorktree(repository, baseCommit, ATTEMPT_1)
    expect(isContained(repositoryPath, first.path)).toBe(false)
    await writeFile(join(first.path, 'source.txt'), 'attempt one\n')
    await writeFile(join(first.path, 'new-file.txt'), 'trusted untracked content\n')

    const collected = await git.collect(first)
    expect(collected.completeness).toBe('COMPLETE')
    expect(collected.payload.baseCommit).toBe(baseCommit)
    expect(collected.payload.changedFiles).toEqual([
      { status: '?', path: 'new-file.txt' },
      { status: 'M', path: 'source.txt' },
    ])
    expect(collected.payload.diff).toContain('attempt one')

    const baseSource = await readFile(join(repositoryPath, 'source.txt'), 'utf8')
    expect(baseSource).toBe('base\n')
    const baseStatus = await run(runtime.runner, repositoryPath, ['git', 'status', '--porcelain=v2', '-z', '--untracked-files=all'])
    expect(baseStatus.stdout.text).toBe('')

    const second = await git.createWorktree(repository, baseCommit, ATTEMPT_2)
    expect(second.path).not.toBe(first.path)
    expect(await readFile(join(second.path, 'source.txt'), 'utf8')).toBe('base\n')
    expect(await git.cleanup(second, (await git.liveFingerprint(second)).digest)).toBe('removed')
  })

  it('fails closed for an outside allowlist, a dirty base, and a conflicting deterministic path', async () => {
    const outsideRoot = await makeCanonicalTempDir('forgeyard-outside-git-')
    try {
      const outsideRepository = await seedRepository(runtime.runner, outsideRoot)
      await expect(git.canonicalize(outsideRepository)).rejects.toThrow(/allowlist/u)

      const repository = await git.canonicalize(repositoryPath)
      const baseCommit = await git.resolveBase(repository, 'main')
      await writeFile(join(repositoryPath, 'source.txt'), 'dirty\n')
      await expect(git.assertClean(repository)).rejects.toThrow(/dirty/u)
      await writeFile(join(repositoryPath, 'source.txt'), 'base\n')
      await expect(git.assertClean(repository)).resolves.toBeUndefined()

      const target = await git.deterministicWorktreePath(repository, ATTEMPT_1)
      await mkdir(target)
      await expect(git.createWorktree(repository, baseCommit, ATTEMPT_1)).rejects.toThrow(/already exists/u)
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('resolves symlinks before containment and quarantines a changed worktree instead of deleting it', async () => {
    const repository = await git.canonicalize(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    const prepared = await git.createWorktree(repository, baseCommit, ATTEMPT_1)
    const authorized = (await git.liveFingerprint(prepared)).digest
    await writeFile(join(prepared.path, 'late-change.txt'), 'changed after review\n')

    expect(await git.cleanup(prepared, authorized)).toBe('quarantined')
    const bucket = prepared.path.slice(0, prepared.path.lastIndexOf('/'))
    expect((await readdir(bucket)).some(name => name.startsWith(`${ATTEMPT_1}.quarantine-`))).toBe(true)

    const outsideRoot = await makeCanonicalTempDir('forgeyard-symlink-target-')
    try {
      const outsideRepository = await seedRepository(runtime.runner, outsideRoot)
      const link = join(repositoryPath, 'outside-link')
      await symlink(outsideRepository, link)
      await expect(git.canonicalize(link)).rejects.toThrow(/allowlist/u)
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects local content filters and repository .gitattributes files', async () => {
    await run(runtime.runner, repositoryPath, ['git', 'config', '--local', 'filter.forgeyard.clean', 'cat'])
    await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/filter\.forgeyard\.clean/u)

    await run(runtime.runner, repositoryPath, ['git', 'config', '--local', '--unset-all', 'filter.forgeyard.clean'])
    await writeFile(join(repositoryPath, '.gitattributes'), '* filter=forgeyard\n')
    await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/Git attributes/u)
  })

  it('rejects assume-unchanged and skip-worktree index visibility flags', async () => {
    await run(runtime.runner, repositoryPath, ['git', 'update-index', '--assume-unchanged', '--', 'source.txt'])
    await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/index visibility flag/u)

    await run(runtime.runner, repositoryPath, ['git', 'update-index', '--no-assume-unchanged', '--', 'source.txt'])
    await run(runtime.runner, repositoryPath, ['git', 'update-index', '--skip-worktree', '--', 'source.txt'])
    await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/index visibility flag/u)
  })

  it('rejects Git replace refs', async () => {
    const original = (await run(runtime.runner, repositoryPath, ['git', 'rev-parse', 'HEAD'])).stdout.text.trim()
    const tree = (await run(runtime.runner, repositoryPath, ['git', 'rev-parse', 'HEAD^{tree}'])).stdout.text.trim()
    const replacement = (await run(runtime.runner, repositoryPath, ['git', 'commit-tree', tree, '-m', 'replacement'])).stdout.text.trim()
    await run(runtime.runner, repositoryPath, ['git', 'replace', original, replacement])

    await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/replace refs/u)
  })

  it('rejects staged gitlinks', async () => {
    const commit = (await run(runtime.runner, repositoryPath, ['git', 'rev-parse', 'HEAD'])).stdout.text.trim()
    await run(runtime.runner, repositoryPath, [
      'git', 'update-index', '--add', '--cacheinfo', '160000', commit, 'vendor/submodule',
    ])

    await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/Gitlink\/submodule/u)
  })

  it('marks ignored binary content as incomplete Evidence', async () => {
    await writeFile(join(repositoryPath, '.gitignore'), 'ignored.bin\n')
    await run(runtime.runner, repositoryPath, ['git', 'add', '--', '.gitignore'])
    await run(runtime.runner, repositoryPath, ['git', 'commit', '-m', 'ignore binary fixture'])
    const repository = await git.canonicalize(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    const prepared = await git.createWorktree(repository, baseCommit, ATTEMPT_1)

    await writeFile(join(prepared.path, 'ignored.bin'), Buffer.from([0, 1, 2, 3]))
    const collected = await git.collect(prepared)

    expect(collected.completeness).toBe('INCOMPLETE')
    expect(collected.payload.diffTruncated).toBe(true)
    expect(collected.payload.changedFiles).toContainEqual({ status: '!', path: 'ignored.bin' })
    expect(collected.payload.diff).toContain('binary sha256=')
  })

  it('fingerprints a new empty directory and exposes it as reviewable ?d state', async () => {
    const repository = await git.canonicalize(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    const prepared = await git.createWorktree(repository, baseCommit, ATTEMPT_1)
    const before = await git.liveFingerprint(prepared)

    await mkdir(join(prepared.path, 'empty-review-dir'))
    const collected = await git.collect(prepared)

    expect(collected.completeness).toBe('COMPLETE')
    expect(collected.payload.fingerprint.digest).not.toBe(before.digest)
    expect(collected.payload.changedFiles).toContainEqual({ status: '?d', path: 'empty-review-dir' })
    expect(collected.payload.diff).toContain('diff --forgeyard empty-directory "empty-review-dir"')
  })

  it('collects a canonical root-inclusive raw manifest and renders metadata-only deltas', async () => {
    const repository = await git.canonicalize(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    const prepared = await git.createWorktree(repository, baseCommit, ATTEMPT_1)
    const baseline = prepared.baselineManifest

    expect(baseline.version).toBe(1)
    expect(baseline.rootPath).toBe('.')
    expect(baseline.hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(baseline.canonical).toContain('"rootPath":"."')
    expect(baseline.entries[0]).toMatchObject({ path: '.', type: 'directory' })
    const source = baseline.entries.find(entry => entry.path === 'source.txt')
    expect(source).toMatchObject({ type: 'file', contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u), linkHash: null })
    for (const field of ['mode', 'uid', 'gid', 'device', 'inode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) {
      expect(source?.[field]).toMatch(/^(?:0|[1-9][0-9]*)$/u)
    }

    const future = new Date(Date.now() + 10_000)
    await utimes(join(prepared.path, 'source.txt'), future, future)
    const { current, delta } = await git.compareWorkspaceToBaseline(prepared.path, baseline)

    expect(current.hash).not.toBe(baseline.hash)
    expect(delta.complete).toBe(true)
    expect(delta.changedPaths).toEqual(['source.txt'])
    expect(delta.preview).toContain('diff --forgeyard raw-workspace "source.txt"')
    expect(delta.preview).toContain('mtimeNs')

    const bounded = compareRawWorkspaceManifests(baseline, current, 24)
    expect(bounded.complete).toBe(false)
    expect(bounded.truncated).toBe(true)
    expect(bounded.previewBytes).toBeGreaterThan(Buffer.byteLength(bounded.preview))

    const corrupt = { ...current, canonical: '{}' }
    const invalid = compareRawWorkspaceManifests(baseline, corrupt, 1024)
    expect(invalid.complete).toBe(false)
    expect(invalid.reason).toMatch(/canonical form or hash/u)
  })

  it('rejects newline and other control characters in worktree paths', async () => {
    const repository = await git.canonicalize(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    const prepared = await git.createWorktree(repository, baseCommit, ATTEMPT_1)
    const newlinePath = join(prepared.path, 'line\nbreak.txt')

    await writeFile(newlinePath, 'not safely reviewable\n')
    await expect(git.collect(prepared)).rejects.toThrow(/control characters/u)
    await rm(newlinePath, { force: true })

    await writeFile(join(prepared.path, 'unit\u0001separator.txt'), 'not safely reviewable\n')
    await expect(git.collect(prepared)).rejects.toThrow(/control characters/u)
  })

  it('rejects unsafe local filesystem interpretation settings', async () => {
    const unsafeSettings = [
      ['core.fileMode', 'false', 'true'],
      ['core.symlinks', 'false', 'true'],
      ['core.ignoreCase', 'true', 'false'],
      ['core.protectHFS', 'false', 'true'],
      ['core.protectNTFS', 'false', 'true'],
    ] as const

    for (const [key, unsafe, safe] of unsafeSettings) {
      await run(runtime.runner, repositoryPath, ['git', 'config', '--local', key, unsafe])
      await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/unsupported Git interpretation setting/u)
      await run(runtime.runner, repositoryPath, ['git', 'config', '--local', key, safe])
    }
  })

  it('requires private real managed directories and an empty hooks directory', async () => {
    const permissiveRoot = join(root, 'permissive-worktrees')
    await mkdir(permissiveRoot, { mode: 0o755 })
    await chmod(permissiveRoot, 0o755)
    const permissive = new GitAuthority(runtime.runner, {
      ...git.config,
      worktreeRoot: permissiveRoot,
    })
    await expect(permissive.canonicalize(repositoryPath)).rejects.toThrow(/group or other users/u)

    const linkTarget = join(root, 'managed-link-target')
    const linkRoot = join(root, 'managed-link')
    await mkdir(linkTarget, { mode: 0o700 })
    await symlink(linkTarget, linkRoot)
    const linked = new GitAuthority(runtime.runner, {
      ...git.config,
      worktreeRoot: join(linkRoot, 'must-not-create'),
    })
    await expect(linked.canonicalize(repositoryPath)).rejects.toThrow(/traverses a symlink|redirected/u)
    await expect(lstat(join(linkTarget, 'must-not-create'))).rejects.toMatchObject({ code: 'ENOENT' })

    const repository = await git.canonicalize(repositoryPath)
    await writeFile(join(root, 'attempt-worktrees', '.empty-hooks', 'unexpected-hook'), '#!/bin/sh\n')
    await expect(git.resolveBase(repository, 'main')).rejects.toThrow(/hooks directory must remain empty/u)
  })

  it('audits Git metadata files without following links and rejects special entries', async () => {
    const attributes = join(repositoryPath, '.git', 'info', 'attributes')
    await writeFile(attributes, '')
    await expect(git.canonicalize(repositoryPath)).resolves.toMatchObject({ path: repositoryPath })

    await rm(attributes)
    const externalEmpty = join(root, 'external-empty-attributes')
    await writeFile(externalEmpty, '')
    await symlink(externalEmpty, attributes)
    await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/must be absent or an exact zero-byte regular file/u)

    await rm(attributes)
    const alternates = join(repositoryPath, '.git', 'objects', 'info', 'alternates')
    await mkdir(alternates)
    await expect(git.canonicalize(repositoryPath)).rejects.toThrow(/must be absent or an exact zero-byte regular file/u)
  })

  it('quarantines a substituted symlink entry without moving its target', async () => {
    const repository = await git.canonicalize(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    const prepared = await git.createWorktree(repository, baseCommit, ATTEMPT_1)
    const authorized = (await git.liveFingerprint(prepared)).digest
    const displaced = `${prepared.path}.displaced`
    await rename(prepared.path, displaced)
    const target = join(root, 'must-not-move')
    await mkdir(target)
    await writeFile(join(target, 'sentinel.txt'), 'still here\n')
    await symlink(target, prepared.path)

    await expect(git.cleanup(prepared, authorized)).resolves.toBe('quarantined')
    expect(await readFile(join(target, 'sentinel.txt'), 'utf8')).toBe('still here\n')
    const bucket = prepared.path.slice(0, prepared.path.lastIndexOf('/'))
    const quarantined = (await readdir(bucket)).find(name => name.startsWith(`${ATTEMPT_1}.quarantine-`))
    expect(quarantined).toBeDefined()
    expect((await lstat(join(bucket, quarantined as string))).isSymbolicLink()).toBe(true)
  })

  it('refuses to move a replacement directory with the wrong bound identity', async () => {
    const repository = await git.canonicalize(repositoryPath)
    const baseCommit = await git.resolveBase(repository, 'main')
    const prepared = await git.createWorktree(repository, baseCommit, ATTEMPT_1)
    const authorized = (await git.liveFingerprint(prepared)).digest
    await rename(prepared.path, `${prepared.path}.displaced`)
    await mkdir(prepared.path, { mode: 0o700 })
    await writeFile(join(prepared.path, 'do-not-move.txt'), 'unrelated replacement\n')

    await expect(git.cleanup(prepared, authorized)).rejects.toThrow(/entry was replaced/u)
    expect(await readFile(join(prepared.path, 'do-not-move.txt'), 'utf8')).toBe('unrelated replacement\n')
  })

  it('rejects a managed worktree root that overlaps an authorized repository', async () => {
    const overlapping = new GitAuthority(runtime.runner, {
      allowedRepositoryRoots: [repositoryPath],
      worktreeRoot: join(repositoryPath, '.forgeyard-worktrees'),
      commandTimeoutMs: 20_000,
      captureBytes: 2 * 1024 * 1024,
      spillBytes: 8 * 1024 * 1024,
      reviewDiffBytes: 256 * 1024,
    })

    await expect(overlapping.canonicalize(repositoryPath)).rejects.toThrow(/must not overlap/u)
  })
})
