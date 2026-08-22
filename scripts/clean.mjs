import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

await rm(resolve(root, 'packages/forgeyard/lib'), { recursive: true, force: true })
