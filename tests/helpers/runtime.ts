import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DshProcessRunner, type ProcessResult } from '../../packages/forgeyard/src/host/process.ts'

export interface TestRuntime {
  ctx: Context
  runner: DshProcessRunner
  dispose(): Promise<void>
}

export async function testRuntime(): Promise<TestRuntime> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalSubprocessRuntime)
  await fiber.await()
  return { ctx, runner: new DshProcessRunner(ctx.subprocess), dispose: () => fiber.dispose() }
}

export async function run(
  runner: DshProcessRunner,
  cwd: string,
  argv: readonly string[],
  allowFailure = false,
): Promise<ProcessResult> {
  const result = await runner.run({
    argv,
    cwd,
    timeoutMs: 20_000,
    memoryLimitBytes: 1024 * 1024,
    spillLimitBytes: 16 * 1024 * 1024,
  })
  if (!allowFailure && (result.spawnError !== null || result.exitCode !== 0)) {
    throw new Error(`${argv.join(' ')} failed: ${result.spawnError ?? result.stderr.text}`)
  }
  return result
}

export async function seedRepository(runner: DshProcessRunner, root: string): Promise<string> {
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await run(runner, repo, ['git', 'init', '-b', 'main'])
  await run(runner, repo, ['git', 'config', 'user.email', 'forgeyard@example.invalid'])
  await run(runner, repo, ['git', 'config', 'user.name', 'Forgeyard Tests'])
  await writeFile(join(repo, 'source.txt'), 'base\n')
  await writeFile(join(repo, 'verify.mjs'), [
    "import { readFile } from 'node:fs/promises'",
    "const value = await readFile(new URL('./result.txt', import.meta.url), 'utf8').catch(() => '')",
    "if (value.trim() !== 'fixed') { console.error('expected fixed result'); process.exitCode = 1 }",
    '',
  ].join('\n'))
  await run(runner, repo, ['git', 'add', '--', 'source.txt', 'verify.mjs'])
  await run(runner, repo, ['git', 'commit', '-m', 'base'])
  return repo
}
