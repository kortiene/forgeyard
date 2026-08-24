import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, open, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ExcludedEntry,
  PromotedEntry,
  PromotionLedgerSection,
  PromotionOutcome,
  PromotionProjection,
  UnrepresentableMode,
  WorkspaceManifestEntry,
} from '../types.ts'
import type { PromotionGitView, PromotionTreeEntry } from './git.ts'
import { canonicalJson, sha256 } from './hash.ts'

export const PROJECTOR_ID = 'forgeyard.promotion-projection'
export const PROJECTOR_VERSION = '1.0.0'

/**
 * The reviewed facts a Git tree structurally cannot carry.
 *
 * This list is part of the hashed projection so a promotion can never be read
 * as a claim that the whole reviewed workspace was delivered.
 */
export const NOT_CARRIED: readonly string[] = [
  'Git-ignored files and directories',
  'directories with no promoted descendant, including empty directories',
  'the linked-worktree .git administrative entry',
  'file permission bits other than the single Git executable bit',
  'symbolic-link permission bits',
  'owner and group identity',
  'access, modification, and change timestamps',
  'device, inode, and hard-link identity',
]

export type ExclusionReason = Exclude<PromotionOutcome, 'promoted'>

export interface PromotionProjectionResult {
  projection: PromotionProjection
  /** The exact worktree-relative paths that must appear in the promoted tree. */
  promotedPaths: string[]
  promotedEntries: PromotedEntry[]
}

export interface PromotionProjectorConfig {
  /** Byte budget for each bounded ledger preview; never affects a section hash. */
  previewBytes: number
  /** Total reviewed content Forgeyard will read while computing object names. */
  spillBytes: number
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function matchesManifest(entry: WorkspaceManifestEntry, stats: BigIntStats): boolean {
  return entry.mode === String(stats.mode) && entry.uid === String(stats.uid) && entry.gid === String(stats.gid)
    && entry.device === String(stats.dev) && entry.inode === String(stats.ino)
    && entry.nlink === String(stats.nlink) && entry.size === String(stats.size)
    && entry.mtimeNs === String(stats.mtimeNs) && entry.ctimeNs === String(stats.ctimeNs)
}

/** The permission bits each Git file mode canonically denotes. */
const CANONICAL_MODE = { '100644': 0o644, '100755': 0o755 } as const

function isGitAdmin(path: string): boolean {
  return path === '.git' || path.startsWith('.git/')
}

/** The one Git mode that carries this reviewed entry; `null` when Git cannot. */
function gitModeFor(entry: WorkspaceManifestEntry): '100644' | '100755' | '120000' | null {
  if (entry.type === 'symlink') return '120000'
  if (entry.type !== 'file') return null
  return (BigInt(entry.mode) & 0o100n) === 0n ? '100644' : '100755'
}

function section<T>(items: readonly T[], previewBytes: number): PromotionLedgerSection<T> {
  const preview: T[] = []
  let used = 0
  let truncated = false
  for (const item of items) {
    const size = Buffer.byteLength(canonicalJson(item))
    if (used + size > previewBytes) {
      truncated = true
      break
    }
    preview.push(item)
    used += size
  }
  return { count: items.length, hash: sha256(canonicalJson(items)), preview, previewTruncated: truncated }
}

/**
 * Project one reviewed raw workspace onto the Git-representable deliverable.
 *
 * The projection is total: every entry of the reviewed manifest receives
 * exactly one outcome, and a manifest entry that Git's own view does not
 * explain fails the promotion closed instead of being silently dropped.
 */
export class PromotionProjector {
  constructor(private readonly config: PromotionProjectorConfig) {}

  async project(worktree: string, view: PromotionGitView): Promise<PromotionProjectionResult> {
    const manifest = view.manifest
    const tracked = new Set(view.tracked)
    const untracked = new Set(view.untracked)
    const ignored = new Set(view.ignored)
    for (const path of tracked) {
      if (untracked.has(path) || ignored.has(path)) {
        throw new Error(`Git reported ${path} in more than one visibility class; promotion failed closed`)
      }
    }
    for (const path of untracked) {
      if (ignored.has(path)) {
        throw new Error(`Git reported ${path} as both untracked and ignored; promotion failed closed`)
      }
    }

    const byPath = new Map(manifest.entries.map(entry => [entry.path, entry] as const))
    // Git's own view must be explained by the reviewed raw workspace. A tracked
    // path may legitimately be absent (the deliverable deleted it), but any
    // other disagreement means the Git diff and the reviewed bytes are not the
    // same object and the promotion cannot be proven.
    for (const path of tracked) {
      const entry = byPath.get(path)
      if (entry !== undefined && entry.type === 'directory') {
        throw new Error(`Git tracks ${path} as a file while the reviewed workspace holds a directory`)
      }
    }
    for (const [label, paths] of [['untracked', untracked], ['ignored', ignored]] as const) {
      for (const path of paths) {
        const entry = byPath.get(path)
        if (entry === undefined || entry.type === 'directory') {
          throw new Error(`Git reports ${label} path ${path}, which the reviewed workspace does not hold as a file or symlink`)
        }
      }
    }

    const promoted: PromotedEntry[] = []
    const excluded: ExcludedEntry[] = []
    const unrepresentable: UnrepresentableMode[] = []
    const directories: WorkspaceManifestEntry[] = []
    let readBytes = 0

    for (const entry of manifest.entries) {
      if (isGitAdmin(entry.path)) {
        excluded.push({ path: entry.path, type: entry.type, reason: 'git-admin' })
        continue
      }
      if (entry.type === 'directory') {
        directories.push(entry)
        continue
      }
      if (ignored.has(entry.path)) {
        excluded.push({ path: entry.path, type: entry.type, reason: 'ignored' })
        continue
      }
      if (!tracked.has(entry.path) && !untracked.has(entry.path)) {
        throw new Error(
          `the reviewed workspace holds ${entry.path}, which Git reports as neither tracked, untracked, nor ignored;`
          + ' promotion failed closed rather than guessing whether it is part of the deliverable',
        )
      }
      const gitMode = gitModeFor(entry)
      if (gitMode === null) throw new Error(`the reviewed workspace entry ${entry.path} has no Git representation`)
      const read = await this.readPromotedBytes(worktree, entry, view.objectFormat)
      readBytes += read.bytes
      if (readBytes > this.config.spillBytes) {
        throw new Error('the promoted deliverable exceeds the trusted collection byte budget')
      }
      promoted.push({
        path: entry.path,
        type: entry.type,
        gitMode,
        mode: entry.mode,
        sizeBytes: String(read.bytes),
        contentHash: read.contentHash,
        blobOid: read.blobOid,
      })
      if (gitMode !== '120000') {
        // Git carries exactly one permission bit. Every other reviewed mode
        // difference is recorded here instead of being silently normalized.
        const canonical = CANONICAL_MODE[gitMode]
        if (Number(BigInt(entry.mode) & 0o7777n) !== canonical) {
          unrepresentable.push({ path: entry.path, mode: entry.mode, gitMode, canonicalMode: String(canonical) })
        }
      }
    }

    const promotedPaths = promoted.map(entry => entry.path).sort(compareUtf8)
    // A directory only survives when Git can imply it from a promoted path.
    const carriedDirectories = new Set<string>()
    for (const path of promotedPaths) {
      const segments = path.split('/')
      for (let index = 1; index < segments.length; index += 1) {
        carriedDirectories.add(segments.slice(0, index).join('/'))
      }
    }
    for (const directory of directories) {
      const carried = directory.path === '.'
        ? promotedPaths.length > 0
        : carriedDirectories.has(directory.path)
      excluded.push({
        path: directory.path,
        type: 'directory',
        reason: carried ? 'directory-implied' : 'directory-dropped',
      })
    }

    promoted.sort((left, right) => compareUtf8(left.path, right.path))
    excluded.sort((left, right) => compareUtf8(left.path, right.path) || left.reason.localeCompare(right.reason))
    unrepresentable.sort((left, right) => compareUtf8(left.path, right.path))
    if (promoted.length + excluded.length !== manifest.entries.length) {
      throw new Error('the promotion projection did not classify every reviewed workspace entry')
    }

    const reasons: ExclusionReason[] = ['git-admin', 'ignored', 'directory-implied', 'directory-dropped']
    const core = {
      version: 1 as const,
      projector: PROJECTOR_ID,
      projectorVersion: PROJECTOR_VERSION,
      workspaceHash: manifest.hash,
      manifestEntryCount: manifest.entries.length,
      promoted: section(promoted, this.config.previewBytes),
      excluded: section(excluded, this.config.previewBytes),
      excludedByReason: reasons.map((reason) => {
        const matching = excluded.filter(entry => entry.reason === reason)
        return { reason, count: matching.length, hash: sha256(canonicalJson(matching)) }
      }),
      unrepresentableModes: section(unrepresentable, this.config.previewBytes),
      notCarried: [...NOT_CARRIED],
    }
    const canonical = canonicalJson(core)
    return {
      projection: { ...core, canonical, hash: sha256(canonical) },
      promotedPaths,
      promotedEntries: promoted,
    }
  }

  /**
   * Read one reviewed entry once, computing both the SHA-256 the trusted
   * manifest recorded and the Git object name for the same bytes. The read is
   * accepted only when the entry's complete filesystem identity is unchanged
   * before and after and the SHA-256 matches the reviewed manifest exactly.
   */
  private async readPromotedBytes(
    worktree: string,
    entry: WorkspaceManifestEntry,
    objectFormat: 'sha1' | 'sha256',
  ): Promise<{ contentHash: string; blobOid: string; bytes: number }> {
    const target = join(worktree, entry.path)
    const before = await lstat(target, { bigint: true })
    if (!matchesManifest(entry, before)) {
      throw new Error(`the reviewed workspace entry ${entry.path} changed before its promotion object was computed`)
    }
    const content = createHash('sha256')
    const object = createHash(objectFormat === 'sha1' ? 'sha1' : 'sha256')
    let bytes = 0

    if (entry.type === 'symlink') {
      if (!before.isSymbolicLink()) throw new Error(`the reviewed symlink ${entry.path} is no longer a symlink`)
      const link = Buffer.from(await readlink(target, { encoding: 'buffer' }))
      bytes = link.length
      object.update(`blob ${String(bytes)}\0`).update(link)
      content.update(link)
      const after = await lstat(target, { bigint: true })
      if (!sameIdentity(before, after)) throw new Error(`the reviewed symlink ${entry.path} changed while it was promoted`)
      const linkHash = content.digest('hex')
      if (entry.linkHash === null || linkHash !== entry.linkHash) {
        throw new Error(`the reviewed symlink ${entry.path} no longer holds its recorded target bytes`)
      }
      return { contentHash: linkHash, blobOid: object.digest('hex'), bytes }
    }

    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`the reviewed file ${entry.path} is no longer a regular file`)
    // The Git blob header commits to the exact byte length, so the recorded
    // size is authoritative and a file that grows mid-read fails the identity
    // recheck rather than producing a valid object name for different bytes.
    object.update(`blob ${entry.size}\0`)
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !sameIdentity(before, opened)) {
        throw new Error(`the reviewed file ${entry.path} changed identity while it was promoted`)
      }
      for await (const value of handle.createReadStream({ autoClose: false })) {
        const chunk = value as Buffer
        bytes += chunk.length
        object.update(chunk)
        content.update(chunk)
      }
      const afterOpen = await handle.stat({ bigint: true })
      if (!sameIdentity(opened, afterOpen)) throw new Error(`the reviewed file ${entry.path} changed while it was promoted`)
    } finally {
      await handle.close()
    }
    const after = await lstat(target, { bigint: true })
    if (!sameIdentity(before, after) || String(bytes) !== entry.size) {
      throw new Error(`the reviewed file ${entry.path} changed while it was promoted`)
    }
    const contentHash = content.digest('hex')
    if (entry.contentHash === null || contentHash !== entry.contentHash) {
      throw new Error(`the reviewed file ${entry.path} no longer holds its recorded content bytes`)
    }
    return { contentHash, blobOid: object.digest('hex'), bytes }
  }
}

/**
 * Prove that the tree Git wrote is exactly the declared projection: the same
 * paths, the same Git modes, and the same object names Forgeyard computed from
 * the reviewed bytes it verified against the trusted manifest.
 */
export function assertTreeMatchesProjection(
  promoted: readonly PromotedEntry[],
  entries: readonly PromotionTreeEntry[],
): void {
  if (entries.length !== promoted.length) {
    throw new Error(`the promoted tree holds ${String(entries.length)} entries but the projection declares ${String(promoted.length)}`)
  }
  const actual = new Map<string, PromotionTreeEntry>()
  for (const entry of entries) {
    if (actual.has(entry.path)) throw new Error(`the promoted tree lists ${entry.path} more than once`)
    actual.set(entry.path, entry)
  }
  for (const entry of promoted) {
    const written = actual.get(entry.path)
    if (written === undefined) throw new Error(`the promoted tree is missing the declared deliverable path ${entry.path}`)
    if (written.mode !== entry.gitMode) {
      throw new Error(`the promoted tree recorded mode ${written.mode} for ${entry.path}; the projection declares ${entry.gitMode}`)
    }
    if (written.oid !== entry.blobOid) {
      throw new Error(`the promoted tree recorded a different object for ${entry.path} than the reviewed bytes produced`)
    }
  }
}
