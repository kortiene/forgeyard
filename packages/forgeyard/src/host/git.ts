import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readlink, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AttemptId,
  ChangedFile,
  GitEvidencePayload,
  GitFingerprint,
  RawWorkspaceManifest,
  RepositorySnapshot,
  WorkspaceManifestEntry,
} from '../types.ts'
import { canonicalJson, sha256 } from './hash.ts'
import { bounded, type ProcessResult, type ProcessRunner } from './process.ts'

export type { RawWorkspaceManifest, WorkspaceManifestEntry } from '../types.ts'

/**
 * A promotion output that is present but provably not what its record claims —
 * a symbolic ref, an unreadable object graph, an invalid object name. It will
 * not resolve by looking again, so it is reported and settled rather than
 * retried like an I/O failure.
 */
export class PromotionRefDisagreement extends Error {}

/**
 * The repository at the recorded path is not the one a record refers to. Also
 * definitive, but it is not a statement about the ref: the recorded output may
 * still exist in the original repository, wherever that now is.
 */
export class RepositoryIdentityMismatch extends Error {}

export interface GitAuthorityConfig {
  allowedRepositoryRoots: readonly string[]
  worktreeRoot: string
  commandTimeoutMs: number
  captureBytes: number
  spillBytes: number
  reviewDiffBytes: number
}

export interface CanonicalRepository {
  path: string
  gitDir: string
  commonDir: string
  device: bigint
  inode: bigint
  gitDirDevice: bigint
  gitDirInode: bigint
  commonDirDevice: bigint
  commonDirInode: bigint
  ownerUid: bigint | null
}

export interface PreparedWorktree {
  path: string
  repository: CanonicalRepository
  baseCommit: string
  device: bigint
  inode: bigint
  baselineManifest: RawWorkspaceManifest
}

/** Git's own view of the reviewed worktree, used to prove the promotion projection. */
export interface PromotionGitView {
  fingerprint: GitFingerprint
  manifest: RawWorkspaceManifest
  headCommit: string
  objectFormat: 'sha1' | 'sha256'
  tracked: string[]
  untracked: string[]
  ignored: string[]
}

export interface PromotionTreeEntry {
  mode: string
  oid: string
  path: string
}

export interface PromotionIdentity {
  name: string
  email: string
  /** Whole seconds since the epoch; the timezone is always `+0000`. */
  epochSeconds: number
}

export interface RawWorkspaceManifestDelta {
  changedPaths: string[]
  preview: string
  previewBytes: number
  truncated: boolean
  complete: boolean
  reason: string | null
}

interface Snapshot {
  payload: GitEvidencePayload
  complete: boolean
}

interface AdditionalFilesSnapshot {
  hash: string
  preview: string
  contentBytes: number
  truncated: boolean
}

interface RawWorkspaceSnapshot {
  hash: string
  emptyDirectories: string[]
  manifest: RawWorkspaceManifest
}

export function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function cleanLine(text: string): string {
  return text.trimEnd()
}

function assertUtf8Paths(text: string): void {
  if (text.includes('\uFFFD')) throw new Error('Git emitted a filename that is not valid UTF-8; Milestone 1 fails closed')
}

function assertReviewablePath(path: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error('Git path contains control characters that cannot be reviewed safely in Milestone 1')
  }
}

function sameManifestIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function manifestCore(manifest: RawWorkspaceManifest): {
  version: 1
  rootPath: '.'
  entries: WorkspaceManifestEntry[]
} {
  return { version: manifest.version, rootPath: manifest.rootPath, entries: manifest.entries }
}

function validateManifest(manifest: RawWorkspaceManifest): string | null {
  if (manifest.version !== 1 || manifest.rootPath !== '.') return 'unsupported raw workspace manifest version or root'
  const expectedCanonical = canonicalJson(manifestCore(manifest))
  if (manifest.canonical !== expectedCanonical
    || manifest.hash !== sha256(expectedCanonical)) {
    return 'raw workspace manifest canonical form or hash is invalid'
  }
  let previous: string | null = null
  for (const entry of manifest.entries) {
    try {
      assertReviewablePath(entry.path)
    } catch {
      return 'raw workspace manifest contains an unreviewable path'
    }
    if (entry.path === '' || entry.path === '..' || entry.path.startsWith('/') || entry.path.startsWith('../')
      || entry.path.includes('/../') || entry.path.endsWith('/..') || entry.path.includes('/./')
      || entry.path.endsWith('/.') || entry.path.includes('//')) {
      return 'raw workspace manifest contains a non-canonical path'
    }
    if (!['directory', 'file', 'symlink'].includes(entry.type)) {
      return 'raw workspace manifest contains an unsupported entry type'
    }
    if (![entry.mode, entry.uid, entry.gid, entry.device, entry.inode, entry.nlink, entry.size,
      entry.mtimeNs, entry.ctimeNs].every(value => /^(?:0|[1-9][0-9]*)$/u.test(value))) {
      return 'raw workspace manifest contains invalid numeric metadata'
    }
    const hash = /^[0-9a-f]{64}$/u
    if ((entry.type === 'file' && (!(typeof entry.contentHash === 'string' && hash.test(entry.contentHash)) || entry.linkHash !== null))
      || (entry.type === 'symlink' && (!(typeof entry.linkHash === 'string' && hash.test(entry.linkHash)) || entry.contentHash !== null))
      || (entry.type === 'directory' && (entry.contentHash !== null || entry.linkHash !== null))) {
      return 'raw workspace manifest contains an invalid content/link hash representation'
    }
    if (previous !== null && compareUtf8(previous, entry.path) >= 0) {
      return 'raw workspace manifest paths are duplicated or not sorted'
    }
    previous = entry.path
  }
  if (manifest.entries[0]?.path !== '.' || manifest.entries[0]?.type !== 'directory') {
    return 'raw workspace manifest does not contain a directory root entry'
  }
  return null
}

/**
 * Render a bounded, deterministic metadata/content-hash delta. Invalid or
 * truncated input is explicitly incomplete so a caller can fail closed.
 */
export function compareRawWorkspaceManifests(
  baseline: RawWorkspaceManifest,
  current: RawWorkspaceManifest,
  maxBytes: number,
): RawWorkspaceManifestDelta {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : 0
  const validationError = validateManifest(baseline) ?? validateManifest(current)
  if (validationError !== null) {
    const display = bounded(`diff --forgeyard raw-workspace\n! ${validationError}\n`, limit)
    return {
      changedPaths: [],
      preview: display.text,
      previewBytes: Buffer.byteLength(display.text),
      truncated: display.truncated,
      complete: false,
      reason: validationError,
    }
  }
  const before = new Map(baseline.entries.map(entry => [entry.path, entry] as const))
  const after = new Map(current.entries.map(entry => [entry.path, entry] as const))
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8)
  const changedPaths: string[] = []
  const fragments: string[] = []
  for (const path of paths) {
    const oldEntry = before.get(path)
    const newEntry = after.get(path)
    if (canonicalJson(oldEntry ?? null) === canonicalJson(newEntry ?? null)) continue
    changedPaths.push(path)
    fragments.push(
      `diff --forgeyard raw-workspace ${JSON.stringify(path)}\n`
      + `-${oldEntry === undefined ? '<absent>' : canonicalJson(oldEntry)}\n`
      + `+${newEntry === undefined ? '<absent>' : canonicalJson(newEntry)}\n`,
    )
  }
  const full = fragments.join('')
  const display = bounded(full, limit)
  return {
    changedPaths,
    preview: display.text,
    previewBytes: Buffer.byteLength(full),
    truncated: display.truncated,
    complete: !display.truncated,
    reason: display.truncated ? 'raw workspace delta exceeded the review byte budget' : null,
  }
}

function nulFields(text: string): string[] {
  assertUtf8Paths(text)
  const fields = text.split('\0')
  if (fields.at(-1) === '') fields.pop()
  return fields
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

/** Git isolation and evidence authority. All commands route through DSH subprocess. */
export class GitAuthority {
  private readonly allowedRoots: Promise<string[]>
  private readonly managedRoot: Promise<string>
  private readonly hooksRoot: Promise<string>

  constructor(private readonly runner: ProcessRunner, readonly config: GitAuthorityConfig) {
    this.allowedRoots = Promise.all(config.allowedRepositoryRoots.map(async root => realpath(root)))
    this.managedRoot = this.prepareDirectory(config.worktreeRoot, false)
    this.hooksRoot = this.managedRoot.then(async root => this.prepareDirectory(join(root, '.empty-hooks'), true))
    // These are eager readiness promises consumed lazily by the first Git call.
    // Register passive rejection handlers so that, if the owning context is
    // disposed before any caller awaits them (e.g. a short-lived instance whose
    // managed root is removed during teardown), the deferred rejection does not
    // surface as a process-level unhandledRejection. Real callers still await
    // these exact promises and still observe the rejection.
    this.allowedRoots.catch(() => {})
    this.managedRoot.catch(() => {})
    this.hooksRoot.catch(() => {})
  }

  private async assertPrivateDirectory(path: string, requireEmpty: boolean): Promise<string> {
    const expected = resolve(path)
    const before = await lstat(expected, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`Forgeyard managed directory is not a real directory: ${expected}`)
    }
    const canonical = await realpath(expected)
    if (canonical !== expected) throw new Error(`Forgeyard managed directory traverses a symlink: ${expected}`)
    const operatorUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
    if (operatorUid !== null && before.uid !== operatorUid) {
      throw new Error(`Forgeyard managed directory is not owned by the Host operator: ${expected}`)
    }
    if ((before.mode & 0o077n) !== 0n) {
      throw new Error(`Forgeyard managed directory must not be accessible by group or other users: ${expected}`)
    }
    if (requireEmpty && (await readdir(expected)).length !== 0) {
      throw new Error(`Forgeyard hooks directory must remain empty: ${expected}`)
    }
    const after = await lstat(expected, { bigint: true })
    if (!sameManifestIdentity(before, after)) throw new Error(`Forgeyard managed directory changed during validation: ${expected}`)
    return canonical
  }

  private async prepareDirectory(path: string, requireEmpty: boolean): Promise<string> {
    const expected = resolve(path)
    const missing: string[] = []
    let cursor = expected
    for (;;) {
      try {
        const existing = await lstat(cursor, { bigint: true })
        if (!existing.isDirectory() || existing.isSymbolicLink() || await realpath(cursor) !== cursor) {
          throw new Error(`Forgeyard managed directory path traverses a symlink or non-directory: ${cursor}`)
        }
        break
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        missing.unshift(cursor)
        const parent = dirname(cursor)
        if (parent === cursor) throw new Error(`Forgeyard could not find a safe parent for managed directory: ${expected}`)
        cursor = parent
      }
    }
    for (const directory of missing) {
      try {
        await mkdir(directory, { mode: 0o700 })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      const created = await lstat(directory, { bigint: true })
      if (!created.isDirectory() || created.isSymbolicLink() || await realpath(directory) !== directory) {
        throw new Error(`Forgeyard managed directory creation was redirected: ${directory}`)
      }
    }
    return this.assertPrivateDirectory(expected, requireEmpty)
  }

  private async invoke(
    cwd: string,
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>> = {},
  ): Promise<ProcessResult> {
    const hooks = await this.hooksRoot
    await this.assertPrivateDirectory(hooks, true)
    const env: NodeJS.ProcessEnv = {}
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith('GIT_')) env[key] = undefined
    }
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      LC_ALL: 'C',
      LANG: 'C',
    })
    // Explicit Forgeyard-owned Git variables (scratch index, literal pathspecs,
    // and the deterministic promotion identity) are applied after the ambient
    // GIT_* scrub so no operator environment can redirect them.
    for (const [key, value] of Object.entries(extraEnv)) {
      if (!/^GIT_[A-Z0-9_]+$/u.test(key)) throw new Error(`unsupported Forgeyard Git environment name: ${key}`)
      env[key] = value
    }
    return this.runner.run({
      argv: [
        'git', '--no-pager', '--no-replace-objects',
        '-c', 'core.quotePath=false',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.autocrlf=false',
        '-c', 'core.eol=lf',
        '-c', 'core.fileMode=true',
        '-c', 'core.symlinks=true',
        '-c', 'core.ignoreCase=false',
        '-c', 'core.protectHFS=true',
        '-c', 'core.protectNTFS=true',
        '-c', `core.attributesFile=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        '-c', `core.hooksPath=${hooks}`,
        ...args,
      ],
      cwd,
      timeoutMs: this.config.commandTimeoutMs,
      memoryLimitBytes: this.config.captureBytes,
      spillLimitBytes: this.config.spillBytes,
      env,
    })
  }

  private async checked(
    cwd: string,
    args: readonly string[],
    extraEnv: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    const result = await this.invoke(cwd, args, extraEnv)
    if (result.spawnError !== null || result.exitCode !== 0 || !result.stdout.complete || !result.stderr.complete) {
      const detail = result.spawnError ?? (result.stderr.text.trim() || `exit ${String(result.exitCode)}`)
      throw new Error(`git ${args[0] ?? ''} failed: ${detail}`)
    }
    return result.stdout.text
  }

  private async assertAbsentOrEmptyRegularFile(path: string, label: string): Promise<void> {
    try {
      const before = await lstat(path, { bigint: true })
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error(`${label} must be absent or an exact zero-byte regular file`)
      }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile() || !sameManifestIdentity(before, opened)) {
          throw new Error(`${label} changed identity during audit`)
        }
        if (opened.size !== 0n) throw new Error(`${label} must be empty`)
      } finally {
        await handle.close()
      }
      const after = await lstat(path, { bigint: true })
      if (!sameManifestIdentity(before, after)) throw new Error(`${label} changed during audit`)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
  }

  /** Reject Git features that can make status/diff differ from verifier-visible bytes. */
  private async assertTransparentGitView(cwd: string, commonDir: string): Promise<void> {
    const gitDir = cleanLine(await this.checked(cwd, ['rev-parse', '--path-format=absolute', '--absolute-git-dir']))
    const config = await this.invoke(cwd, ['config', '--local', '--no-includes', '--name-only', '--get-regexp', '.*'])
    if (config.spawnError !== null || ![0, 1].includes(config.exitCode ?? -1)
      || !config.stdout.complete || !config.stderr.complete) {
      throw new Error('Git local configuration could not be audited completely')
    }
    const unsafeConfig = config.stdout.text.split(/\r?\n/u).filter(Boolean).find(key => {
      const normalized = key.toLowerCase()
      return normalized.startsWith('filter.') || normalized === 'include.path'
        || normalized.startsWith('includeif.') || normalized === 'core.attributesfile'
        || normalized === 'core.worktree' || normalized.startsWith('core.sparsecheckout')
        || normalized === 'extensions.worktreeconfig'
    })
    if (unsafeConfig !== undefined) throw new Error(`unsupported Git interpretation setting: ${unsafeConfig}`)
    for (const [key, expected] of [
      ['core.filemode', 'true'],
      ['core.symlinks', 'true'],
      ['core.ignorecase', 'false'],
      ['core.protecthfs', 'true'],
      ['core.protectntfs', 'true'],
    ] as const) {
      const value = await this.invoke(cwd, ['config', '--local', '--get', key])
      if (value.spawnError !== null || ![0, 1].includes(value.exitCode ?? -1)
        || !value.stdout.complete || !value.stderr.complete) {
        throw new Error(`Git ${key} configuration could not be audited completely`)
      }
      if (value.exitCode === 0 && value.stdout.text.trim().toLowerCase() !== expected) {
        throw new Error(`unsupported Git interpretation setting: ${key}=${value.stdout.text.trim()}`)
      }
    }

    const [flags, stages, tracked, untracked, ignored, replacements] = await Promise.all([
      this.checked(cwd, ['ls-files', '-v', '-z', '--']),
      this.checked(cwd, ['ls-files', '--stage', '-z', '--']),
      this.checked(cwd, ['ls-files', '-z', '--']),
      this.checked(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
      this.checked(cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--']),
      this.checked(cwd, ['for-each-ref', '--format=%(refname)', 'refs/replace/']),
    ])
    const hidden = nulFields(flags).find(entry => entry[0] !== 'H')
    if (hidden !== undefined) throw new Error(`Git index visibility flag is not allowed: ${hidden.slice(0, 1)}`)
    if (nulFields(stages).some(entry => entry.startsWith('160000 '))) {
      throw new Error('Gitlink/submodule entries are outside the Milestone 1 evidence model')
    }
    const trackedPaths = nulFields(tracked)
    const untrackedPaths = nulFields(untracked)
    const ignoredPaths = nulFields(ignored)
    for (const path of [...trackedPaths, ...untrackedPaths, ...ignoredPaths]) assertReviewablePath(path)
    const attributePath = [...trackedPaths, ...untrackedPaths, ...ignoredPaths]
      .find(path => path.toLowerCase() === '.gitattributes' || path.toLowerCase().endsWith('/.gitattributes'))
    if (attributePath !== undefined) {
      throw new Error(`Git attributes are outside the Milestone 1 raw-byte evidence model: ${attributePath}`)
    }
    if (replacements.trim().length > 0) throw new Error('Git replace refs are not allowed')
    await this.assertAbsentOrEmptyRegularFile(join(gitDir, 'info', 'attributes'), 'Git info/attributes')
    if (gitDir !== commonDir) {
      await this.assertAbsentOrEmptyRegularFile(join(commonDir, 'info', 'attributes'), 'Git common info/attributes')
    }
    await this.assertAbsentOrEmptyRegularFile(join(commonDir, 'objects', 'info', 'alternates'), 'Git object alternates')
  }

  async canonicalize(candidate: string): Promise<CanonicalRepository> {
    const selected = await realpath(resolve(candidate))
    const [inside, bare, topText, gitText, commonText] = await Promise.all([
      this.checked(selected, ['rev-parse', '--is-inside-work-tree']),
      this.checked(selected, ['rev-parse', '--is-bare-repository']),
      this.checked(selected, ['rev-parse', '--path-format=absolute', '--show-toplevel']),
      this.checked(selected, ['rev-parse', '--path-format=absolute', '--absolute-git-dir']),
      this.checked(selected, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
    if (cleanLine(inside) !== 'true' || cleanLine(bare) !== 'false') throw new Error('selected repository must be a non-bare Git worktree')
    const [top, gitDir, commonDir] = await Promise.all([
      realpath(cleanLine(topText)), realpath(cleanLine(gitText)), realpath(cleanLine(commonText)),
    ])
    if (!isContained(top, selected)) throw new Error('selected path is not contained by its canonical Git root')
    if (!isContained(top, commonDir) || !isContained(top, gitDir)) {
      throw new Error('linked worktrees and submodules must be registered as an explicit base checkout in a future version')
    }
    const roots = await this.allowedRoots
    const managedRoot = await this.managedRoot
    await this.assertPrivateDirectory(managedRoot, false)
    if (roots.some(root => isContained(root, managedRoot) || isContained(managedRoot, root))) {
      throw new Error('managed worktree root must not overlap an authorized repository root')
    }
    if (!roots.some(root => isContained(root, top))) throw new Error('canonical repository is outside the operator allowlist')
    const [identity, gitIdentity, commonIdentity] = await Promise.all([
      stat(top, { bigint: true }), stat(gitDir, { bigint: true }), stat(commonDir, { bigint: true }),
    ])
    const ownerUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
    if (ownerUid !== null && [identity.uid, gitIdentity.uid, commonIdentity.uid].some(uid => uid !== ownerUid)) {
      throw new Error('canonical repository is not owned by the Forgeyard Host operator')
    }
    await this.assertTransparentGitView(top, commonDir)
    return {
      path: top,
      gitDir,
      commonDir,
      device: identity.dev,
      inode: identity.ino,
      gitDirDevice: gitIdentity.dev,
      gitDirInode: gitIdentity.ino,
      commonDirDevice: commonIdentity.dev,
      commonDirInode: commonIdentity.ino,
      ownerUid,
    }
  }

  async assertIdentity(repository: CanonicalRepository): Promise<void> {
    const current = await this.canonicalize(repository.path)
    if (current.path !== repository.path || current.commonDir !== repository.commonDir
      || current.gitDir !== repository.gitDir || current.device !== repository.device || current.inode !== repository.inode
      || current.gitDirDevice !== repository.gitDirDevice || current.gitDirInode !== repository.gitDirInode
      || current.commonDirDevice !== repository.commonDirDevice || current.commonDirInode !== repository.commonDirInode
      || current.ownerUid !== repository.ownerUid) {
      throw new Error('repository identity changed after it was authorized')
    }
  }

  private repositoryIdentitySnapshot(repository: CanonicalRepository, baseRef: string): Omit<RepositorySnapshot, 'checkoutHead' | 'checkoutStatusHash'> {
    return {
      path: repository.path,
      baseRef,
      gitDir: repository.gitDir,
      gitCommonDir: repository.commonDir,
      pathDevice: String(repository.device),
      pathInode: String(repository.inode),
      gitDirDevice: String(repository.gitDirDevice),
      gitDirInode: String(repository.gitDirInode),
      gitCommonDirDevice: String(repository.commonDirDevice),
      gitCommonDirInode: String(repository.commonDirInode),
      ownerUid: repository.ownerUid === null ? null : String(repository.ownerUid),
    }
  }

  /** Freeze the operator's clean base-checkout state, not merely repository identity. */
  async repositorySnapshot(repository: CanonicalRepository, baseRef: string): Promise<RepositorySnapshot> {
    await this.assertIdentity(repository)
    const [checkoutHead, status] = await Promise.all([
      this.checked(repository.path, ['rev-parse', 'HEAD']).then(cleanLine),
      this.checked(repository.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    ])
    if (status.length !== 0) throw new Error('base checkout is dirty; Forgeyard refuses to snapshot it')
    return {
      ...this.repositoryIdentitySnapshot(repository, baseRef),
      checkoutHead,
      checkoutStatusHash: sha256(status),
    }
  }

  /**
   * Re-prove that a canonicalized repository is still the same object on disk,
   * from filesystem identity alone.
   *
   * `canonicalize` re-runs the whole transparency audit — six `rev-parse`, six
   * `config`, five `ls-files`, a `for-each-ref` — which is right when admitting
   * a repository and wrong inside the promotion lease, where every Git command
   * is separately timeout-bounded and the lease has to budget for all of them.
   * What the write path guards against is the repository being *replaced*, and
   * device/inode identity settles that with no subprocess at all.
   */
  async assertRepositoryUnmoved(repository: CanonicalRepository): Promise<void> {
    const [top, gitDir, commonDir] = await Promise.all([
      lstat(repository.path, { bigint: true }),
      lstat(repository.gitDir, { bigint: true }),
      lstat(repository.commonDir, { bigint: true }),
    ])
    if (top.dev !== repository.device || top.ino !== repository.inode
      || gitDir.dev !== repository.gitDirDevice || gitDir.ino !== repository.gitDirInode
      || commonDir.dev !== repository.commonDirDevice || commonDir.ino !== repository.commonDirInode) {
      throw new RepositoryIdentityMismatch('repository identity on disk differs from the canonicalized repository')
    }
  }

  assertRepositorySnapshot(repository: CanonicalRepository, snapshot: RepositorySnapshot): void {
    const current = this.repositoryIdentitySnapshot(repository, snapshot.baseRef)
    const { checkoutHead: _head, checkoutStatusHash: _status, ...identity } = snapshot
    if (canonicalJson(current) !== canonicalJson(identity)) {
      throw new RepositoryIdentityMismatch('repository identity differs from the durable Mission snapshot')
    }
  }

  /** Approval-time proof that the original checkout still matches the Attempt baseline. */
  async assertBaseCheckoutSnapshot(repository: CanonicalRepository, snapshot: RepositorySnapshot): Promise<void> {
    this.assertRepositorySnapshot(repository, snapshot)
    const [head, status] = await Promise.all([
      this.checked(repository.path, ['rev-parse', 'HEAD']).then(cleanLine),
      this.checked(repository.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    ])
    if (head !== snapshot.checkoutHead || sha256(status) !== snapshot.checkoutStatusHash) {
      throw new Error('base checkout HEAD or working state changed after the Attempt snapshot')
    }
  }

  async assertClean(repository: CanonicalRepository): Promise<void> {
    await this.assertIdentity(repository)
    await this.assertTransparentGitView(repository.path, repository.commonDir)
    const status = await this.checked(repository.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])
    if (status.length !== 0) throw new Error('base checkout is dirty; Forgeyard refuses to prepare an Attempt')
  }

  async resolveBase(repository: CanonicalRepository, baseRef: string): Promise<string> {
    if (baseRef.trim().length === 0 || baseRef.startsWith('-')) throw new Error('base reference is invalid')
    await this.assertIdentity(repository)
    const oid = cleanLine(await this.checked(repository.path, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]))
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) throw new Error('Git returned a non-object base commit')
    return oid
  }

  async deterministicWorktreePath(repository: CanonicalRepository, attemptId: AttemptId): Promise<string> {
    if (!/^attempt_[0-9a-f-]+$/u.test(attemptId)) throw new Error('Attempt ID cannot be used for a managed worktree path')
    const root = await this.managedRoot
    await this.assertPrivateDirectory(root, false)
    const bucket = sha256(repository.commonDir).slice(0, 12)
    const parent = join(root, bucket)
    const canonicalParent = await this.prepareDirectory(parent, false)
    if (!isContained(root, canonicalParent)) throw new Error('managed worktree container escaped its configured root')
    return join(canonicalParent, attemptId)
  }

  async createWorktree(repository: CanonicalRepository, baseCommit: string, attemptId: AttemptId): Promise<PreparedWorktree> {
    await this.assertClean(repository)
    const baseCheckoutHead = cleanLine(await this.checked(repository.path, ['rev-parse', 'HEAD']))
    const target = await this.deterministicWorktreePath(repository, attemptId)
    try {
      await lstat(target)
      throw new Error('deterministic Attempt worktree path already exists; it will not be reused')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await this.checked(repository.path, [
      'worktree', 'add', '--detach', '--lock', `--reason=forgeyard:${attemptId}`, target, baseCommit,
    ])
    const canonicalTarget = await realpath(target)
    if (canonicalTarget !== target) throw new Error('Git created a worktree at an unexpected canonical path')
    const [top, common, head] = await Promise.all([
      this.checked(target, ['rev-parse', '--path-format=absolute', '--show-toplevel']).then(cleanLine).then(realpath),
      this.checked(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(cleanLine).then(realpath),
      this.checked(target, ['rev-parse', 'HEAD']).then(cleanLine),
    ])
    if (top !== target || common !== repository.commonDir || head !== baseCommit) {
      throw new Error('new worktree failed repository/common-dir/base identity validation; it is quarantined in place')
    }
    await this.assertIdentity(repository)
    const [afterHead, afterStatus] = await Promise.all([
      this.checked(repository.path, ['rev-parse', 'HEAD']).then(cleanLine),
      this.checked(repository.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    ])
    if (afterHead !== baseCheckoutHead || afterStatus.length !== 0) {
      throw new Error('base checkout changed while preparing the Attempt; worktree retained for review')
    }
    const targetIdentity = await stat(target, { bigint: true })
    const baselineManifest = await this.collectWorkspaceManifest(target)
    return {
      path: target,
      repository,
      baseCommit,
      device: targetIdentity.dev,
      inode: targetIdentity.ino,
      baselineManifest,
    }
  }

  async assertWorktree(prepared: PreparedWorktree): Promise<void> {
    const [target, top, common, identity] = await Promise.all([
      realpath(prepared.path),
      this.checked(prepared.path, ['rev-parse', '--path-format=absolute', '--show-toplevel']).then(cleanLine).then(realpath),
      this.checked(prepared.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then(cleanLine).then(realpath),
      stat(prepared.path, { bigint: true }),
    ])
    if (target !== prepared.path || top !== prepared.path || common !== prepared.repository.commonDir
      || identity.dev !== prepared.device || identity.ino !== prepared.inode) {
      throw new Error('Attempt worktree identity no longer matches its immutable binding')
    }
  }

  /**
   * Collect the verifier-visible workspace itself, including ignored files,
   * empty directories, root metadata, links, and file bytes.
   */
  async collectWorkspaceManifest(worktree: string): Promise<RawWorkspaceManifest> {
    const root = await realpath(worktree)
    if (root !== worktree) throw new Error('Attempt worktree changed canonical identity during raw Evidence collection')
    const entries: WorkspaceManifestEntry[] = []
    let contentBytes = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })

    const consume = (bytes: number): void => {
      contentBytes += bytes
      if (contentBytes > this.config.spillBytes) {
        throw new Error('raw workspace content exceeds the trusted collection byte budget')
      }
    }

    const entryOf = (
      path: string,
      type: WorkspaceManifestEntry['type'],
      metadata: BigIntStats,
      contentHash: string | null,
      linkHash: string | null,
    ): WorkspaceManifestEntry => ({
      path,
      type,
      mode: String(metadata.mode),
      uid: String(metadata.uid),
      gid: String(metadata.gid),
      device: String(metadata.dev),
      inode: String(metadata.ino),
      nlink: String(metadata.nlink),
      size: String(metadata.size),
      mtimeNs: String(metadata.mtimeNs),
      ctimeNs: String(metadata.ctimeNs),
      contentHash,
      linkHash,
    })

    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const beforeDirectory = await lstat(directory, { bigint: true })
      if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) {
        throw new Error(`raw workspace directory changed type: ${relativeDirectory || '.'}`)
      }
      entries.push(entryOf(relativeDirectory || '.', 'directory', beforeDirectory, null, null))
      const directoryEntries = await readdir(directory, { withFileTypes: true, encoding: 'buffer' })
      directoryEntries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
      for (const entry of directoryEntries) {
        let name: string
        try {
          name = decoder.decode(Buffer.from(entry.name))
        } catch {
          throw new Error('workspace contains a filename that is not valid UTF-8; Milestone 1 fails closed')
        }
        assertReviewablePath(name)
        if (name === '.' || name === '..' || name.includes(sep)) throw new Error('workspace emitted an invalid directory entry')
        const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`
        assertReviewablePath(relativePath)
        const target = join(directory, name)
        const before = await lstat(target, { bigint: true })
        if (before.isSymbolicLink()) {
          const link = Buffer.from(await readlink(target, { encoding: 'buffer' }))
          consume(link.length)
          const after = await lstat(target, { bigint: true })
          if (!sameManifestIdentity(before, after)) throw new Error(`symlink changed while collecting Evidence: ${relativePath}`)
          entries.push(entryOf(relativePath, 'symlink', before, null, sha256(link)))
          continue
        }
        if (before.isDirectory()) {
          await walk(target, relativePath)
          continue
        }
        if (!before.isFile()) throw new Error(`unsupported workspace file type: ${relativePath}`)
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const contentHash = createHash('sha256')
        let bytes = 0n
        try {
          const opened = await handle.stat({ bigint: true })
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new Error(`workspace file changed identity while collecting Evidence: ${relativePath}`)
          }
          for await (const value of handle.createReadStream({ autoClose: false })) {
            const chunk = value as Buffer
            bytes += BigInt(chunk.length)
            consume(chunk.length)
            contentHash.update(chunk)
          }
          const afterOpen = await handle.stat({ bigint: true })
          if (!sameManifestIdentity(opened, afterOpen)) throw new Error(`workspace file changed while collecting Evidence: ${relativePath}`)
        } finally {
          await handle.close()
        }
        const after = await lstat(target, { bigint: true })
        if (!sameManifestIdentity(before, after) || bytes !== before.size) {
          throw new Error(`workspace file changed while collecting Evidence: ${relativePath}`)
        }
        entries.push(entryOf(relativePath, 'file', before, contentHash.digest('hex'), null))
      }
      const afterDirectory = await lstat(directory, { bigint: true })
      if (!sameManifestIdentity(beforeDirectory, afterDirectory)) {
        throw new Error(`directory changed while collecting Evidence: ${relativeDirectory || '.'}`)
      }
    }

    await walk(root, '')
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    const core = { version: 1 as const, rootPath: '.' as const, entries }
    const canonical = canonicalJson(core)
    return { ...core, canonical, hash: sha256(canonical) }
  }

  /** Compare a previously persisted baseline with the current raw workspace. */
  async compareWorkspaceToBaseline(
    worktree: string,
    baseline: RawWorkspaceManifest,
  ): Promise<{ current: RawWorkspaceManifest; delta: RawWorkspaceManifestDelta }> {
    const current = await this.collectWorkspaceManifest(worktree)
    return { current, delta: compareRawWorkspaceManifests(baseline, current, this.config.reviewDiffBytes) }
  }

  private async rawWorkspace(worktree: string): Promise<RawWorkspaceSnapshot> {
    const manifest = await this.collectWorkspaceManifest(worktree)
    const directories = manifest.entries.filter(entry => entry.type === 'directory' && entry.path !== '.')
    const emptyDirectories = directories
      .filter(directory => !manifest.entries.some(entry => entry.path.startsWith(`${directory.path}/`)))
      .map(directory => directory.path)
    return { hash: manifest.hash, emptyDirectories, manifest }
  }

  private async hashAdditional(
    worktree: string,
    entries: readonly { path: string; status: '?' | '!' }[],
  ): Promise<AdditionalFilesSnapshot> {
    const hash = createHash('sha256').update('forgeyard.untracked.v1\0')
    let preview = ''
    let previewBytes = 0
    let contentBytes = 0
    let truncated = false
    const appendPreview = (value: string): void => {
      const bytes = Buffer.from(value)
      const remaining = Math.max(0, this.config.reviewDiffBytes - previewBytes)
      if (bytes.length > remaining) truncated = true
      if (remaining > 0) {
        const kept = bytes.subarray(0, remaining)
        preview += kept.toString('utf8')
        previewBytes += kept.length
      }
    }
    for (const { path: name, status } of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
      assertReviewablePath(name)
      const target = resolve(worktree, name)
      if (!isContained(worktree, target)) throw new Error('untracked Git path escaped the Attempt worktree')
      const before = await lstat(target, { bigint: true })
      hash.update(status).update('\0').update(name).update('\0').update(String(before.mode)).update('\0').update(String(before.size)).update('\0')
      const fileHash = createHash('sha256')
      const retained: Buffer[] = []
      let retainedBytes = 0
      let sawNul = false
      if (before.isSymbolicLink()) {
        const link = Buffer.from(await readlink(target, { encoding: 'buffer' }))
        hash.update('symlink\0').update(link).update('\0')
        fileHash.update(link)
        contentBytes += link.length
        let targetDescription: string
        try {
          targetDescription = JSON.stringify(new TextDecoder('utf-8', { fatal: true }).decode(link))
        } catch {
          targetDescription = `sha256=${fileHash.digest('hex')} bytes=${String(link.length)}`
          truncated = true
        }
        appendPreview(`diff --forgeyard ${status === '!' ? 'ignored' : 'untracked'} ${JSON.stringify(name)}\n+symlink ${targetDescription}\n`)
        continue
      }
      if (!before.isFile()) throw new Error(`unsupported untracked file type: ${name}`)
      const handle = await open(target, 'r')
      try {
        const opened = await handle.stat({ bigint: true })
        if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
          throw new Error(`untracked file changed identity while collecting Evidence: ${name}`)
        }
        for await (const value of handle.createReadStream({ autoClose: false })) {
          const chunk = value as Buffer
          contentBytes += chunk.length
          if (contentBytes > this.config.spillBytes) {
            throw new Error('untracked and ignored file content exceeds the trusted collection byte budget')
          }
          hash.update(chunk)
          fileHash.update(chunk)
          if (chunk.includes(0)) sawNul = true
          const remaining = Math.max(0, this.config.reviewDiffBytes - previewBytes - retainedBytes)
          if (remaining > 0) {
            const kept = chunk.subarray(0, remaining)
            retained.push(kept)
            retainedBytes += kept.length
          }
        }
      } finally {
        await handle.close()
      }
      hash.update('\0')
      const digest = fileHash.digest('hex')
      const header = `diff --forgeyard ${status === '!' ? 'ignored' : 'untracked'} ${JSON.stringify(name)}\n`
      appendPreview(header)
      const retainedContent = Buffer.concat(retained)
      if (sawNul) {
        appendPreview(`binary sha256=${digest} bytes=${String(before.size)}\n`)
        truncated = true
      } else {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(retainedContent)
          appendPreview(text.split('\n').map(line => `+${line}`).join('\n'))
          appendPreview('\n')
          if (BigInt(retainedBytes) < before.size) truncated = true
        } catch {
          appendPreview(`non-UTF-8 sha256=${digest} bytes=${String(before.size)}\n`)
          truncated = true
        }
      }
    }
    return { hash: hash.digest('hex'), preview, contentBytes, truncated }
  }

  private async snapshot(prepared: PreparedWorktree): Promise<Snapshot> {
    await this.assertWorktree(prepared)
    await this.assertTransparentGitView(prepared.path, prepared.repository.commonDir)
    const [headResult, statusResult, namesResult, untrackedResult, ignoredResult, baseDirectoriesResult, diffResult, raw] = await Promise.all([
      this.invoke(prepared.path, ['rev-parse', 'HEAD']),
      this.invoke(prepared.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      this.invoke(prepared.path, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', prepared.baseCommit, '--']),
      this.invoke(prepared.path, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
      this.invoke(prepared.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--']),
      this.invoke(prepared.path, ['ls-tree', '-d', '-r', '--name-only', '-z', prepared.baseCommit, '--']),
      this.invoke(prepared.path, ['diff', '--binary', '--full-index', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', prepared.baseCommit, '--']),
      this.rawWorkspace(prepared.path),
    ])
    const results = [headResult, statusResult, namesResult, untrackedResult, ignoredResult, baseDirectoriesResult, diffResult]
    if (results.some(result => result.spawnError !== null || result.exitCode !== 0)) throw new Error('Git Evidence collection command failed')
    const complete = results.every(result => result.stdout.complete && result.stderr.complete)
    const rawDelta = compareRawWorkspaceManifests(prepared.baselineManifest, raw.manifest, this.config.reviewDiffBytes)
    const headCommit = cleanLine(headResult.stdout.text)
    const nameFields = nulFields(namesResult.stdout.text)
    if (nameFields.length % 2 !== 0) throw new Error('unexpected NUL-delimited git diff --name-status output')
    const changedFiles: ChangedFile[] = []
    for (let index = 0; index < nameFields.length; index += 2) {
      assertReviewablePath(nameFields[index + 1] as string)
      changedFiles.push({ status: nameFields[index] as string, path: nameFields[index + 1] as string })
    }
    const untracked = nulFields(untrackedResult.stdout.text)
    for (const path of untracked) assertReviewablePath(path)
    for (const path of untracked) changedFiles.push({ status: '?', path })
    const ignored = nulFields(ignoredResult.stdout.text)
    for (const path of ignored) assertReviewablePath(path)
    for (const path of ignored) changedFiles.push({ status: '!', path })
    const baseDirectories = new Set(nulFields(baseDirectoriesResult.stdout.text))
    const emptyDirectoryPreview: string[] = []
    for (const path of raw.emptyDirectories) {
      if (baseDirectories.has(path)) continue
      changedFiles.push({ status: '?d', path })
      emptyDirectoryPreview.push(`diff --forgeyard empty-directory ${JSON.stringify(path)}\n`)
    }
    const knownChangedPaths = new Set(changedFiles.map(file => file.path))
    for (const path of rawDelta.changedPaths) {
      if (path !== '.' && !knownChangedPaths.has(path)) changedFiles.push({ status: '~', path })
    }
    changedFiles.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status))
    const additional = await this.hashAdditional(prepared.path, [
      ...untracked.map(path => ({ path, status: '?' as const })),
      ...ignored.map(path => ({ path, status: '!' as const })),
    ])
    const fingerprint: GitFingerprint = {
      baseCommit: prepared.baseCommit,
      headCommit,
      statusHash: statusResult.stdout.hash,
      diffHash: diffResult.stdout.hash,
      untrackedHash: additional.hash,
      workspaceHash: raw.hash,
      digest: '',
    }
    fingerprint.digest = sha256(canonicalJson({ ...fingerprint, digest: undefined }))
    const display = bounded(
      [diffResult.stdout.text, additional.preview, emptyDirectoryPreview.join(''), rawDelta.preview].filter(Boolean).join('\n'),
      this.config.reviewDiffBytes,
    )
    const diffTruncated = display.truncated || diffResult.stdout.truncated || additional.truncated || rawDelta.truncated
    return {
      complete: complete && rawDelta.complete && !diffTruncated,
      payload: {
        kind: 'git',
        baseCommit: prepared.baseCommit,
        headCommit,
        fingerprint,
        changedFiles,
        diff: display.text,
        diffBytes: diffResult.stdout.bytes + additional.contentBytes + rawDelta.previewBytes,
        diffTruncated,
        ignoredFilesExcluded: false,
      },
    }
  }

  async collect(prepared: PreparedWorktree): Promise<{ payload: GitEvidencePayload; completeness: 'COMPLETE' | 'INCOMPLETE' }> {
    const first = await this.snapshot(prepared)
    const second = await this.snapshot(prepared)
    if (first.payload.fingerprint.digest !== second.payload.fingerprint.digest) {
      throw new Error('Attempt worktree changed while Git Evidence was being collected')
    }
    return { payload: first.payload, completeness: first.complete && second.complete ? 'COMPLETE' : 'INCOMPLETE' }
  }

  async liveFingerprint(prepared: PreparedWorktree): Promise<GitFingerprint> {
    const first = await this.snapshot(prepared)
    const second = await this.snapshot(prepared)
    if (!first.complete || !second.complete) throw new Error('live Git fingerprint collection was incomplete')
    if (first.payload.fingerprint.digest !== second.payload.fingerprint.digest) {
      throw new Error('Attempt worktree changed while its live Git fingerprint was being collected')
    }
    return first.payload.fingerprint
  }

  /**
   * Read Git's complete view of the reviewed worktree twice and refuse a view
   * that moved between reads. The manifest is the same trusted raw-workspace
   * collection the Evidence fingerprint is built from, so a caller can bind
   * the projection to the exact reviewed `workspaceHash`.
   */
  async promotionView(prepared: PreparedWorktree): Promise<PromotionGitView> {
    const first = await this.readPromotionView(prepared)
    const second = await this.readPromotionView(prepared)
    if (canonicalJson(first) !== canonicalJson(second)) {
      throw new Error('Attempt worktree changed while its promotion projection was being read')
    }
    return first
  }

  private async readPromotionView(prepared: PreparedWorktree): Promise<PromotionGitView> {
    await this.assertWorktree(prepared)
    await this.assertTransparentGitView(prepared.path, prepared.repository.commonDir)
    const [format, head, tracked, untracked, ignored] = await Promise.all([
      this.checked(prepared.path, ['rev-parse', '--show-object-format']).then(cleanLine),
      this.checked(prepared.path, ['rev-parse', 'HEAD']).then(cleanLine),
      this.checked(prepared.path, ['ls-files', '-z', '--']),
      this.checked(prepared.path, ['ls-files', '--others', '--exclude-standard', '-z', '--']),
      this.checked(prepared.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--']),
    ])
    if (format !== 'sha1' && format !== 'sha256') {
      throw new Error(`unsupported Git object format for promotion: ${format}`)
    }
    const fingerprint = await this.liveFingerprint(prepared)
    const manifest = await this.collectWorkspaceManifest(prepared.path)
    if (manifest.hash !== fingerprint.workspaceHash) {
      throw new Error('the raw workspace changed between its fingerprint and its promotion manifest')
    }
    const collect = (text: string): string[] => {
      const paths = nulFields(text)
      for (const path of paths) assertReviewablePath(path)
      return [...paths].sort(compareUtf8)
    }
    return {
      fingerprint,
      manifest,
      headCommit: head,
      objectFormat: format,
      tracked: collect(tracked),
      untracked: collect(untracked),
      ignored: collect(ignored),
    }
  }

  /** A private mode-`0700` directory for promotion scratch index/pathspec files. */
  private async promotionScratch(): Promise<string> {
    const root = await this.managedRoot
    return this.prepareDirectory(join(root, '.promotion'), false)
  }

  /**
   * Build the promoted tree from an explicit path list in a scratch index.
   *
   * The Attempt worktree's own index, working tree, and HEAD are untouched:
   * `GIT_INDEX_FILE` redirects every index write, and `git add` never writes
   * working-tree bytes. `GIT_LITERAL_PATHSPECS` stops a path that contains
   * glob characters from matching anything but itself, and `-f` is deliberately
   * not passed so a listed path Git considers ignored fails the promotion.
   */
  async writePromotionTree(
    prepared: PreparedWorktree,
    attemptId: AttemptId,
    promotedPaths: readonly string[],
  ): Promise<{ tree: string; entries: PromotionTreeEntry[] }> {
    if (!/^attempt_[0-9a-f-]+$/u.test(attemptId)) throw new Error('Attempt ID cannot be used for a promotion scratch file')
    for (const path of promotedPaths) assertReviewablePath(path)
    await this.assertWorktree(prepared)
    // One exclusively created directory per invocation. Neither the Attempt ID
    // nor the process ID identifies a call: two Engines in one process, or two
    // containers sharing a PID value, can promote one Attempt at the same
    // moment, and the tree is built before any row claims the uniqueness
    // constraint. Sharing these paths would let one call delete the other's
    // index mid-flight and fail both requests.
    const workspace = await mkdtemp(join(await this.promotionScratch(), `${attemptId}-`))
    const indexPath = join(workspace, 'promotion.index')
    const listPath = join(workspace, 'promotion.pathspec')
    try {
      const env = { GIT_INDEX_FILE: indexPath }
      await this.checked(prepared.path, ['read-tree', '--empty'], env)
      if (promotedPaths.length > 0) {
        await writeFile(listPath, `${promotedPaths.join('\0')}\0`, { mode: 0o600 })
        await this.checked(prepared.path, [
          'add', '--pathspec-from-file', listPath, '--pathspec-file-nul', '--',
        ], { ...env, GIT_LITERAL_PATHSPECS: '1' })
      }
      const tree = cleanLine(await this.checked(prepared.path, ['write-tree'], env))
      const staged = nulFields(await this.checked(prepared.path, ['ls-files', '--stage', '-z'], env))
      const entries: PromotionTreeEntry[] = []
      for (const record of staged) {
        const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t(.*)$/su.exec(record)
        if (match === null) throw new Error('unexpected git ls-files --stage output while building the promoted tree')
        if (match[3] !== '0') throw new Error('the promoted index contains an unmerged entry')
        assertReviewablePath(match[4] as string)
        entries.push({ mode: match[1] as string, oid: match[2] as string, path: match[4] as string })
      }
      return { tree, entries }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  /** Flatten a written tree back to its exact blob entries for correspondence proof. */
  async readTreeEntries(prepared: PreparedWorktree, tree: string): Promise<PromotionTreeEntry[]> {
    if (!/^[0-9a-f]{40,64}$/u.test(tree)) throw new Error('invalid promoted tree object name')
    const listing = nulFields(await this.checked(prepared.path, ['ls-tree', '-r', '-z', '--full-tree', tree]))
    return listing.map((record) => {
      const match = /^([0-7]{6}) (blob|tree|commit|tag) ([0-9a-f]{40,64})\t(.*)$/su.exec(record)
      if (match === null) throw new Error('unexpected git ls-tree output for the promoted tree')
      if (match[2] !== 'blob') throw new Error(`the promoted tree contains a non-blob ${match[2] as string} entry`)
      assertReviewablePath(match[4] as string)
      return { mode: match[1] as string, oid: match[3] as string, path: match[4] as string }
    })
  }

  /**
   * Create the promotion commit object with a fully pinned identity so the same
   * approved deliverable always yields the same commit name. No ref is moved.
   */
  async createPromotionCommit(
    prepared: PreparedWorktree,
    tree: string,
    parent: string,
    message: string,
    identity: PromotionIdentity,
  ): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/u.test(tree) || !/^[0-9a-f]{40,64}$/u.test(parent)) {
      throw new Error('invalid promotion tree or parent object name')
    }
    if (!Number.isSafeInteger(identity.epochSeconds) || identity.epochSeconds < 0) {
      throw new Error('promotion identity requires a whole non-negative epoch second')
    }
    if (/[<>\n\0]/u.test(identity.name) || /[<>\n\0]/u.test(identity.email)) {
      throw new Error('promotion identity name and email must not contain Git delimiter characters')
    }
    const date = `${String(identity.epochSeconds)} +0000`
    const env = {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_COMMITTER_DATE: date,
    }
    const commit = cleanLine(await this.checked(prepared.path, [
      // Signing would make the commit name depend on a key and a clock, so the
      // deterministic promotion identity is the only authorship claim made.
      '-c', 'commit.gpgsign=false',
      // A repository-local `i18n.commitEncoding` adds an `encoding` header and
      // changes the commit's object name for the same tree, parent, message,
      // identity, and date. Ambient configuration must not decide what a
      // promotion is called: the whole recovery story depends on a retry
      // recomputing the same commit as the attempt that preceded it.
      '-c', 'i18n.commitEncoding=UTF-8',
      'commit-tree', tree, '-p', parent, '-m', message,
    ], env))
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error('Git returned an invalid promotion commit object name')
    return commit
  }

  /** Read the tree a promotion commit carries, without moving any ref. */
  async readCommitTree(prepared: PreparedWorktree, commit: string): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error('invalid promotion commit object name')
    const tree = cleanLine(await this.checked(prepared.path, ['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]))
    if (!/^[0-9a-f]{40,64}$/u.test(tree)) throw new Error('Git returned an invalid promoted tree object name')
    return tree
  }

  /** Reference name for the one Forgeyard-owned promotion output of an Attempt. */
  static promotionRef(attemptId: AttemptId): string {
    if (!/^attempt_[0-9a-f-]+$/u.test(attemptId)) throw new Error('Attempt ID cannot be used for a Forgeyard promotion ref')
    return `refs/forgeyard/promotions/${attemptId}`
  }

  private assertPromotionRef(ref: string): void {
    if (!/^refs\/forgeyard\/promotions\/attempt_[0-9a-f-]+$/u.test(ref)) {
      throw new Error(`Forgeyard only writes refs under refs/forgeyard/promotions/: ${ref}`)
    }
  }

  /**
   * The target this promotion name points at, or null when it is an ordinary
   * ref. Git dereferences symbolic refs recursively by default, so the resolved
   * object name alone cannot tell a Forgeyard-owned ref from a symref aimed
   * somewhere else that happens to resolve to the same commit today.
   */
  async promotionSymrefTarget(cwd: string, ref: string): Promise<string | null> {
    this.assertPromotionRef(ref)
    const result = await this.invoke(cwd, ['symbolic-ref', '--quiet', '--', ref])
    if (result.spawnError !== null || !result.stdout.complete) {
      throw new Error('the Forgeyard promotion ref could not be inspected for a symbolic ref')
    }
    return result.exitCode === 0 ? cleanLine(result.stdout.text) : null
  }

  /** Read a Forgeyard promotion ref without creating it. */
  async readPromotionRef(cwd: string, ref: string): Promise<string | null> {
    this.assertPromotionRef(ref)
    // A promotion output is one Forgeyard-owned ref naming one fixed commit.
    // A symref that resolves to the recorded commit today is a moving target
    // pointing outside that namespace — the branch it names can advance and
    // silently change what the promotion claims to have delivered. Forgeyard
    // never creates one, so finding one is a disagreement, not an output.
    const symbolic = await this.promotionSymrefTarget(cwd, ref)
    if (symbolic !== null) {
      throw new PromotionRefDisagreement(
        `${ref} is a symbolic ref to ${symbolic}; Forgeyard never creates one and will not read through it`,
      )
    }
    const result = await this.invoke(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
    if (result.spawnError !== null || !result.stdout.complete || !result.stderr.complete) {
      throw new Error('the Forgeyard promotion ref could not be read completely')
    }
    if (result.exitCode === 1 && result.stdout.text.trim() === '') return null
    if (result.exitCode !== 0) throw new Error(`git rev-parse failed for ${ref}: ${result.stderr.text.trim()}`)
    const oid = cleanLine(result.stdout.text)
    if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
      throw new PromotionRefDisagreement(`Git returned an invalid object name for ${ref}`)
    }
    // `rev-parse --verify` answers from the ref's text alone: a ref left behind
    // by a damaged or pruned object database still reports its recorded object
    // name. A promoted output nothing can check out is not a durable output.
    //
    // `cat-file -e` proves only that the commit object itself is present; it
    // does not traverse the tree, so a pruned blob would pass it. `rev-list
    // --objects` walks the commit's whole object graph in one command and fails
    // if any of it is missing, peels a non-commit, and with `--quiet` prints
    // nothing, so a large deliverable cannot overrun the capture limit.
    const object = await this.invoke(cwd, ['rev-list', '--objects', '--no-walk', '--quiet', `${oid}^{commit}`])
    if (object.spawnError !== null || !object.stderr.complete) {
      throw new Error('the Forgeyard promotion commit could not be inspected completely')
    }
    if (object.exitCode !== 0) {
      throw new PromotionRefDisagreement(
        `${ref} names ${oid}, but that commit and its promoted objects are not all readable in this repository`,
      )
    }
    return oid
  }

  /**
   * Create the Forgeyard promotion ref with Git's own compare-and-swap. An
   * empty expected value means "must not exist", so a colliding ref (another
   * Forgeyard process, or an operator-created name) loses atomically inside
   * Git's ref transaction instead of being silently overwritten.
   *
   * `--no-deref` makes that compare-and-swap apply to this ref name itself. Git
   * otherwise follows a symbolic ref, so a `refs/forgeyard/promotions/<attempt>`
   * pre-created as a symref to `refs/heads/<anything>` would satisfy the
   * must-not-exist check at its *target* and make Forgeyard create that branch —
   * a write outside `refs/forgeyard/`, which Forgeyard guarantees it never does.
   * `--no-deref` alone is not enough: a symref whose target does not exist has
   * no object value, so the must-not-exist check passes and Git silently
   * replaces the symref. A promotion name that is already symbolic is therefore
   * rejected outright, because Forgeyard never overwrites a ref it did not create.
   */
  async createPromotionRef(cwd: string, ref: string, commit: string): Promise<void> {
    this.assertPromotionRef(ref)
    if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error('invalid promotion commit object name')
    const symbolic = await this.promotionSymrefTarget(cwd, ref)
    if (symbolic !== null) {
      throw new Error(`${ref} is a symbolic ref to ${symbolic}; Forgeyard will not write through it`)
    }
    const result = await this.invoke(cwd, ['update-ref', '--no-deref', '--create-reflog', '--end-of-options', ref, commit, ''])
    if (result.spawnError !== null || result.exitCode !== 0) {
      const detail = result.spawnError ?? (result.stderr.text.trim() || `exit ${String(result.exitCode)}`)
      throw new Error(`the Forgeyard promotion ref could not be created: ${detail}`)
    }
  }

  /**
   * Explicit, fingerprint-authorized cleanup. Unknown or changed worktrees are
   * renamed into quarantine and retained; Forgeyard never guesses that they are disposable.
   */
  async cleanup(prepared: PreparedWorktree, authorizedFingerprint: string): Promise<'removed' | 'quarantined'> {
    try {
      const current = await this.liveFingerprint(prepared)
      if (current.digest !== authorizedFingerprint) throw new Error('fingerprint changed')
      await this.assertWorktree(prepared)
      await this.checked(prepared.repository.path, ['worktree', 'unlock', prepared.path])
      await this.assertWorktree(prepared)
      await this.checked(prepared.repository.path, ['worktree', 'remove', '--force', prepared.path])
      return 'removed'
    } catch {
      const root = await this.managedRoot
      await this.assertPrivateDirectory(root, false)
      const entryPath = resolve(prepared.path)
      if (entryPath !== prepared.path || entryPath === root || !isContained(root, entryPath)) {
        throw new Error('uncertain worktree is not an exact child of the managed root; cleanup refused')
      }
      const lexicalParent = dirname(entryPath)
      const canonicalParent = await realpath(lexicalParent)
      if (canonicalParent !== lexicalParent || !isContained(root, canonicalParent)) {
        throw new Error('uncertain worktree parent changed identity; cleanup refused')
      }
      const entry = await lstat(entryPath, { bigint: true })
      if (!entry.isSymbolicLink()
        && (!entry.isDirectory() || entry.dev !== prepared.device || entry.ino !== prepared.inode)) {
        throw new Error('uncertain worktree entry was replaced; cleanup refused without touching it')
      }
      const quarantine = `${entryPath}.quarantine-${Date.now()}-${String(process.pid)}`
      // rename(2) operates on the exact directory entry and does not follow a
      // substituted symlink, so a hostile link target cannot be moved.
      await rename(entryPath, quarantine)
      return 'quarantined'
    }
  }
}
