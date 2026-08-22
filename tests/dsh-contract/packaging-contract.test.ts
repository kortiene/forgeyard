import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '../..')
const packageRoot = join(root, 'packages/forgeyard')

describe('out-of-tree static dual-face packaging', () => {
  it('declares one bundle row and the exact Web client graph', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string }; client: { platform: string; inject: string[] } }
    }
    expect(manifest.name).toBe('forgeyard')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.client.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-api-gateway',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-slots',
    ]))
    const patch = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('name: forgeyard')
    expect(patch).toContain("dshHomePath('forgeyard.sqlite')")
  })

  it('ships the exact classic lazy-CJS client wrapper and generated Typert endpoints', async () => {
    const source = await readFile(join(packageRoot, 'lib/client.js'), 'utf8')
    let registration: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined
    runInNewContext(source, {
      window: { __ModuleLoader__: { load(value: typeof registration) { registration = value } } },
    })
    expect(registration?.id).toBe('forgeyard')
    expect(registration?.factory).toBeTypeOf('function')
    const typert = await readFile(join(packageRoot, 'lib/typert.host.js'), 'utf8')
    for (const method of ['snapshot', 'createMission', 'startAttempt', 'verifyAttempt', 'decide', 'retry', 'attemptForSession']) {
      expect(typert).toContain(`id: 'forgeyard#forgeyard/${method}'`)
    }
  })

  it('composes one local Web profile without a DSH fork', async () => {
    const profile = JSON.parse(await readFile(join(root, 'profiles/local/package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(profile.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'forgeyard',
    ])
    expect(profile.dependencies.forgeyard).toBe('link:../../packages/forgeyard')
  })

  it('documents and contains the rc.2 out-of-tree generator defect', async () => {
    const adr = await readFile(join(root, 'docs/adr/0002-rc2-out-of-tree-typert-generation.md'), 'utf8')
    const mirror = await readFile(join(packageRoot, 'src/host/typert-protocol-meta.d.ts'), 'utf8')
    expect(adr).toContain('narrow upstream fix')
    expect(mirror).toContain("declare module '@deepseek-ai/dsh-typert-protocol'")
    expect(mirror).toMatch(/compile-time-only/i)
  })
})
