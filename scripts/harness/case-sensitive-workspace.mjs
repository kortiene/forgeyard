import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, rmdir, stat, writeFile, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Probe whether `dir` lives on a case-sensitive filesystem.
 *
 * Forgeyard's transparent Git byte-view fails closed on a case-insensitive
 * volume: Git records `core.ignorecase=true` and Forgeyard rejects it. macOS
 * default (APFS/HFS+) volumes are case-insensitive, so acceptance work must run
 * on a dedicated case-sensitive volume.
 */
export async function isCaseSensitive(dir) {
  const probe = await mkdtemp(join(dir, 'fy-case-probe-'))
  try {
    await writeFile(join(probe, 'CaseProbe'), '')
    try {
      await stat(join(probe, 'caseprobe'))
      return false
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return true
      throw error
    }
  } finally {
    await rm(probe, { recursive: true, force: true })
  }
}

/**
 * Detach a mounted image, retrying with a forced detach. Throws when the volume
 * is still mounted after the final attempt so callers never delete the backing
 * image, or report cleanup success, while the volume is still attached.
 */
async function detach(mountpoint) {
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await execFileAsync('hdiutil', ['detach', mountpoint])
      return
    } catch (error) {
      lastError = error
    }
    try {
      await execFileAsync('hdiutil', ['detach', mountpoint, '-force'])
      return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`failed to detach the case-sensitive volume at ${mountpoint} after 6 attempts: ${lastError?.stderr ?? lastError?.message ?? String(lastError)}`)
}

/** Derive the sparse-image path used by mountCaseSensitiveVolume for a mountpoint. */
export function imagePathFor(mountpoint) {
  return `${mountpoint}.sparseimage`
}

/**
 * Create and mount a dedicated case-sensitive APFS sparse image (no privileges
 * required). Returns the canonical mountpoint. Fails closed if the mounted
 * volume does not actually report case sensitivity.
 */
export async function mountCaseSensitiveVolume(mountpoint, { sizeGb = 4 } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error(`case-sensitive volume provisioning is only implemented for darwin, not ${process.platform}`)
  }
  const image = imagePathFor(mountpoint)
  const volname = `FY-${randomUUID().slice(0, 8)}`
  await rm(image, { force: true })
  await execFileAsync('hdiutil', [
    'create', '-size', `${sizeGb}g`, '-fs', 'Case-sensitive APFS',
    '-volname', volname, '-type', 'SPARSE', '-layout', 'GPTSPUD', image,
  ])
  await mkdir(mountpoint, { recursive: true })
  await execFileAsync('hdiutil', ['attach', image, '-mountpoint', mountpoint, '-nobrowse', '-owners', 'on'])
  const base = await realpath(mountpoint)
  if (!(await isCaseSensitive(base))) {
    // Surface a cleanup failure without masking the reason we are bailing out.
    await unmountCaseSensitiveVolume(mountpoint).catch((cleanupError) => {
      process.stderr.write(`warning: could not release ${mountpoint}: ${cleanupError?.message ?? String(cleanupError)}\n`)
    })
    throw new Error('provisioned volume did not report case sensitivity; refusing to proceed')
  }
  return base
}

/**
 * Detach a mounted case-sensitive volume and delete its backing image. Throws
 * when the volume could not be detached; the image is then left in place rather
 * than deleted out from under a still-mounted volume.
 */
export async function unmountCaseSensitiveVolume(mountpoint) {
  await detach(mountpoint)
  await rm(imagePathFor(mountpoint), { force: true })
  await rmdir(mountpoint).catch(() => {})
}

/**
 * Provision a canonical, case-sensitive base directory for acceptance work.
 *
 * On a case-sensitive host (Linux, or a case-sensitive macOS volume) this simply
 * returns a canonical temporary directory. On a case-insensitive macOS volume it
 * mounts a dedicated case-sensitive APFS sparse image. The returned `cleanup`
 * fully reverses whatever was provisioned. Fails closed on any other
 * case-insensitive platform rather than running Forgeyard on an unsupported
 * filesystem.
 */
export async function provisionCaseSensitiveBase(label = 'forgeyard') {
  const canonicalTmp = await realpath(tmpdir())
  if (await isCaseSensitive(canonicalTmp)) {
    const base = await realpath(await mkdtemp(join(canonicalTmp, `${label}-`)))
    return {
      base,
      backend: 'tmpdir',
      async cleanup() { await rm(base, { recursive: true, force: true }) },
    }
  }
  if (process.platform !== 'darwin') {
    throw new Error(
      `MISSING CAPABILITY: the temporary filesystem at ${canonicalTmp} is case-insensitive and no `
      + `case-sensitive provisioner exists for ${process.platform}. Forgeyard requires a case-sensitive, `
      + 'symlink-free workspace; point TMPDIR at a case-sensitive volume.',
    )
  }
  const mountpoint = join(homedir(), `.forgeyard-cs-${label}-${randomUUID().slice(0, 8)}`)
  const base = await mountCaseSensitiveVolume(mountpoint)
  return {
    base,
    backend: 'apfs-case-sensitive-image',
    mountpoint,
    async cleanup() { await unmountCaseSensitiveVolume(mountpoint) },
  }
}
