import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const face = process.argv[2]
if (face !== 'host' && face !== 'client') throw new Error('build face must be host or client')
const root = resolve(import.meta.dirname, '..')
const result = spawnSync(process.execPath, [
  resolve(root, 'node_modules/tsdown/dist/run.mjs'),
  '--config', resolve(root, 'tsdown.config.ts'),
], {
  cwd: root,
  env: { ...process.env, FORGEYARD_BUILD_FACE: face },
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
