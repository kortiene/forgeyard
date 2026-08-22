import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

export interface ProcessRequest {
  argv: readonly string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Cancels the managed DSH subprocess when its owning maintenance phase is cancelled. */
  signal?: AbortSignal
  timeoutMs: number
  memoryLimitBytes: number
  spillLimitBytes: number
}

export interface ProcessOutput {
  text: string
  bytes: number
  hash: string
  truncated: boolean
  complete: boolean
}

export interface ProcessResult {
  exitCode: number | null
  signal: string | null
  durationMs: number
  timedOut: boolean
  spawnError: string | null
  stdout: ProcessOutput
  stderr: ProcessOutput
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>
}

async function outputOf(
  read: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } } | undefined,
): Promise<ProcessOutput> {
  if (read === undefined) return { text: '', bytes: 0, hash: createHash('sha256').digest('hex'), truncated: false, complete: true }
  const captured = read.readFrom(0)
  let full: Buffer | undefined
  if (captured.lossy && captured.spillPath !== undefined) {
    try {
      full = await readFile(captured.spillPath)
    } catch {
      full = undefined
    }
  }
  const retained = Buffer.from(captured.text)
  const source = full ?? retained
  return {
    text: source.toString('utf8'),
    bytes: captured.nextOffset,
    hash: createHash('sha256').update(source).digest('hex'),
    truncated: captured.lossy,
    complete: !captured.lossy || full !== undefined,
  }
}

/** Managed DSH subprocess adapter. No command is interpreted by a shell. */
export class DshProcessRunner implements ProcessRunner {
  constructor(private readonly subprocess: SubprocessRuntime) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(request.signal?.reason)
    if (request.signal?.aborted === true) onAbort()
    else request.signal?.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('Forgeyard process deadline exceeded'))
    }, request.timeoutMs)
    const started = performance.now()
    try {
      const handle = this.subprocess.spawn({
        argv: request.argv,
        cwd: request.cwd,
        env: request.env,
        signal: controller.signal,
        graceMs: 2_000,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: request.memoryLimitBytes, spill: { maxBytes: request.spillLimitBytes } },
          stderr: { maxBytes: request.memoryLimitBytes, spill: { maxBytes: request.spillLimitBytes } },
        },
      })
      try {
        const outcome = await handle.done
        await handle.waitForExit()
        return {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          durationMs: Math.round(performance.now() - started),
          timedOut,
          spawnError: null,
          stdout: await outputOf(handle.collected.stdout),
          stderr: await outputOf(handle.collected.stderr),
        }
      } catch (error) {
        return {
          exitCode: null,
          signal: null,
          durationMs: Math.round(performance.now() - started),
          timedOut,
          spawnError: error instanceof Error ? error.message : String(error),
          stdout: await outputOf(handle.collected.stdout),
          stderr: await outputOf(handle.collected.stderr),
        }
      }
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }
}

export function bounded(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return { text, truncated: false }
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}
