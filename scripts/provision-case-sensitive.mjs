// Operator utility: provision or tear down a case-sensitive APFS volume for the
// Forgeyard gate on a case-insensitive host (macOS default). Reproducible and
// privilege-free. See docs/milestone-1-acceptance.md.
//
//   MP=$(node scripts/provision-case-sensitive.mjs mount)
//   TMPDIR="$MP/tmp" pnpm check
//   node scripts/provision-case-sensitive.mjs unmount "$MP"

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isCaseSensitive, mountCaseSensitiveVolume, unmountCaseSensitiveVolume } from './harness/case-sensitive-workspace.mjs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const [command, argument] = process.argv.slice(2)

if (command === 'mount') {
  const canonicalTmp = await realpath(tmpdir())
  if (await isCaseSensitive(canonicalTmp)) {
    // Already case-sensitive: expose a canonical scratch dir; nothing to unmount.
    const dir = join(canonicalTmp, `forgeyard-cs-${randomUUID().slice(0, 8)}`)
    await mkdir(join(dir, 'tmp'), { recursive: true })
    process.stdout.write(`${dir}\n`)
  } else {
    const mountpoint = join(homedir(), `.forgeyard-cs-${argument ?? 'gate'}-${randomUUID().slice(0, 8)}`)
    const base = await mountCaseSensitiveVolume(mountpoint)
    await mkdir(join(base, 'tmp'), { recursive: true })
    process.stdout.write(`${base}\n`)
  }
} else if (command === 'unmount') {
  if (!argument) throw new Error('unmount requires the mountpoint path')
  await unmountCaseSensitiveVolume(argument)
  process.stdout.write(`unmounted ${argument}\n`)
} else {
  process.stderr.write('usage: node scripts/provision-case-sensitive.mjs <mount|unmount> [arg]\n')
  process.exitCode = 2
}
