import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- the repository gate is plain ESM JavaScript outside a tsconfig project.
import { checkMjsSyntax, discoverMjsFiles, main } from '../../scripts/check-mjs-syntax.mjs'

const execFileAsync = promisify(execFile)
const checker = join(import.meta.dirname, '../../scripts/check-mjs-syntax.mjs')
const roots: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeyard-mjs-syntax-'))
  roots.push(root)
  return root
}

function shown(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('credential-free MJS syntax gate', () => {
  it('discovers exact lowercase .mjs files recursively in deterministic lexical order', async () => {
    const root = await fixture()
    await mkdir(join(root, 'a', 'deeper'), { recursive: true })
    await mkdir(join(root, 'z'), { recursive: true })
    await Promise.all([
      writeFile(join(root, 'z-last.mjs'), 'export const last = true\n'),
      writeFile(join(root, 'a', 'second.mjs'), 'export const second = true\n'),
      writeFile(join(root, 'a', 'deeper', 'first.mjs'), 'export const first = true\n'),
      writeFile(join(root, 'z', 'ignored.js'), 'this is intentionally not parsed\n'),
      writeFile(join(root, 'README.md'), '# not executable\n'),
      // Extension matching is deliberately case-sensitive: the repository contract is scripts/**/*.mjs.
      writeFile(join(root, 'UPPER.MJS'), 'export const upper = true\n'),
    ])

    const files = await discoverMjsFiles(root)
    expect(files.map(path => shown(root, path))).toEqual([
      'a/deeper/first.mjs',
      'a/second.mjs',
      'z-last.mjs',
    ])
    await expect(checkMjsSyntax(root)).resolves.toEqual({
      root,
      files: ['a/deeper/first.mjs', 'a/second.mjs', 'z-last.mjs'],
    })
  })

  it('aggregates every parser failure while retaining valid files in the count', async () => {
    const root = await fixture()
    await mkdir(join(root, 'nested'), { recursive: true })
    await Promise.all([
      writeFile(join(root, 'broken-a.mjs'), 'export const = 1\n'),
      writeFile(join(root, 'nested', 'broken-b.mjs'), 'if (true {\n'),
      writeFile(join(root, 'valid.mjs'), 'export const valid = true\n'),
    ])

    let message = ''
    try {
      await checkMjsSyntax(root)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('MJS syntax check failed for 2 of 3 file(s)')
    expect(message).toContain('--- broken-a.mjs ---')
    expect(message).toContain('--- nested/broken-b.mjs ---')
    expect(message).toContain('SyntaxError')
    expect(message).not.toContain('--- valid.mjs ---')
  })

  it('does not follow file or directory symlinks outside the reviewed scripts tree', async () => {
    const root = await fixture()
    const outside = await fixture()
    await writeFile(join(root, 'local.mjs'), 'export const local = true\n')
    await writeFile(join(outside, 'broken.mjs'), 'export const = 1\n')
    await symlink(join(outside, 'broken.mjs'), join(root, 'linked-file.mjs'))
    await symlink(outside, join(root, 'linked-directory'), 'dir')
    await symlink(root, join(root, 'cycle'), 'dir')

    await expect(checkMjsSyntax(root)).resolves.toEqual({ root, files: ['local.mjs'] })
  })

  it('fails closed for a missing or empty root instead of passing a misconfigured gate', async () => {
    const root = await fixture()
    await expect(checkMjsSyntax(root)).rejects.toThrow(/No .mjs files found/u)
    await expect(discoverMjsFiles(join(root, 'missing'))).rejects.toThrow(
      /Cannot read MJS syntax-check directory .*missing below root .*missing/u,
    )
  })

  it('fails closed when the configured Node executable cannot be started', async () => {
    const root = await fixture()
    await writeFile(join(root, 'valid.mjs'), 'export const valid = true\n')
    const missingNode = join(root, 'missing-node')

    await expect(checkMjsSyntax(root, { nodePath: missingNode })).rejects.toThrow(
      `Cannot execute Node syntax checker at ${missingNode}`,
    )
  })

  it('exits non-zero with the relative path and parser diagnostic at the real CLI boundary', async () => {
    const root = await fixture()
    await writeFile(join(root, 'operator-harness.mjs'), 'export const = 1\n')

    let exitCode: string | number | undefined
    let stderr = ''
    try {
      await execFileAsync(process.execPath, [checker, root], { encoding: 'utf8' })
    } catch (error) {
      const failure = error as Error & { code?: string | number; stderr?: string }
      exitCode = failure.code
      stderr = failure.stderr ?? ''
    }
    expect(exitCode).toBe(1)
    expect(stderr).toContain('MJS syntax check failed for 1 of 1 file(s)')
    expect(stderr).toContain('--- operator-harness.mjs ---')
    expect(stderr).toContain('SyntaxError')
  })

  it('rejects extra CLI arguments before inspecting the filesystem', async () => {
    await expect(main(['first', 'second'])).rejects.toThrow(
      'Usage: node scripts/check-mjs-syntax.mjs [scripts-directory]',
    )
  })
})
