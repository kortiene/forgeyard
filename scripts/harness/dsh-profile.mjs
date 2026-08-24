import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
export const dshBinary = join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
export const localProfile = join(repositoryRoot, 'profiles', 'local')

const OPERATOR_CONFIG_FILES = ['settings.yaml', '.credentials.yaml', '.anonymous-user-id']

/**
 * Drop settings that only make sense inside the operator's own DSH profile.
 *
 * `agent-presets.default` names a preset from the operator's profile: its
 * definition lives outside settings.yaml and it may mount plugins the pinned
 * Forgeyard profile does not ship, so inheriting it fails every Attempt with
 * `agent-presets: preset "<name>" not found` or a loader-entry import error.
 * Removing the block lets the pinned profile's own roster default apply, which
 * is the preset the acceptance run is supposed to exercise anyway. Provider
 * routing, credentials, and the default model are untouched.
 */
export function withoutProfileScopedSettings(settingsYaml) {
  return settingsYaml.replace(/^agent-presets:[ \t]*\r?\n(?:[ \t]+.*\r?\n|[ \t]*\r?\n(?=[ \t]+\S))*/mu, '')
}

/** Resolve the operator's real DSH home that actually holds provider credentials. */
export function operatorDshHome() {
  const candidates = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.credentials.yaml')) || existsSync(join(candidate, 'settings.yaml'))) return candidate
  }
  return candidates[candidates.length - 1] ?? join(homedir(), '.dsh')
}

function unquote(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Parse the non-secret `agent-default-model` block from an operator settings.yaml. */
export function parseDefaultModel(settingsYaml) {
  const block = settingsYaml.match(/^agent-default-model:\n((?: {2}.*\n?)*)/m)?.[1] ?? ''
  const provider = block.match(/^ {2}provider:\s*(.+)$/m)?.[1]
  const model = block.match(/^ {2}model:\s*(.+)$/m)?.[1]
  const reasoningEffort = block.match(/^ {2}reasoningEffort:\s*(.+)$/m)?.[1]
  return {
    provider: provider === undefined ? null : unquote(provider),
    model: model === undefined ? null : unquote(model),
    reasoningEffort: reasoningEffort === undefined ? null : unquote(reasoningEffort),
  }
}

/**
 * Materialize an isolated DSH home under `base` that reuses the operator's real
 * provider configuration and credentials, links the local Forgeyard profile, and
 * reports the operator's configured default model. Never invents credentials.
 */
export async function prepareOperatorDshHome(base) {
  const source = operatorDshHome()
  const dshHome = join(base, 'dsh-home')
  await mkdir(join(dshHome, 'profiles'), { recursive: true })
  await symlink(localProfile, join(dshHome, 'profiles', 'local'), process.platform === 'win32' ? 'junction' : 'dir')

  const copied = []
  for (const file of OPERATOR_CONFIG_FILES) {
    const from = join(source, file)
    if (!existsSync(from)) continue
    const to = join(dshHome, file)
    if (file === 'settings.yaml') await writeFile(to, withoutProfileScopedSettings(await readFile(from, 'utf8')))
    else await copyFile(from, to)
    if (file.startsWith('.')) await chmod(to, 0o600).catch(() => {})
    copied.push(file)
  }

  const settingsPath = join(dshHome, 'settings.yaml')
  const defaultModel = existsSync(settingsPath)
    ? parseDefaultModel(await readFile(settingsPath, 'utf8'))
    : { provider: null, model: null, reasoningEffort: null }
  const hasCredentials = existsSync(join(dshHome, '.credentials.yaml'))
  const hasProvider = hasCredentials && defaultModel.provider !== null && defaultModel.model !== null

  return { dshHome, source, copied, defaultModel, hasCredentials, hasProvider }
}

/**
 * Boot the real pinned DSH Web profile and resolve its listening URL.
 * Returns the URL, the child process, and a stop() that terminates it cleanly.
 */
export async function bootProfile({ dshHome, repositoryRoot: allowlistRoot, readyTimeoutMs = 30_000, extraEnv = {} }) {
  let output = ''
  let resolveUrl
  let rejectUrl
  const ready = new Promise((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject })
  const deadline = setTimeout(() => rejectUrl(new Error(`DSH Web did not start within ${readyTimeoutMs} ms.\n${output}`)), readyTimeoutMs)

  const child = spawn(dshBinary, ['--profile', 'local', '--no-open', '--port', '0'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      FORGEYARD_REPOSITORY_ROOT: allowlistRoot,
      DSH_TELEMETRY_MODE: 'DISABLED',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const inspect = (chunk) => {
    output += chunk.toString()
    const match = output.match(/dsh web: (http:\/\/[^\s]+)/u)
    if (match?.[1] !== undefined) resolveUrl(match[1])
  }
  child.stdout.on('data', inspect)
  child.stderr.on('data', inspect)
  child.once('error', rejectUrl)
  const onExit = (code, signal) => rejectUrl(new Error(`DSH Web exited before readiness (${String(code)}/${String(signal)}).\n${output}`))
  child.once('exit', onExit)

  try {
    const url = await ready
    clearTimeout(deadline)
    child.off('exit', onExit)
    return {
      url,
      child,
      getOutput: () => output,
      async stop() {
        if (child.exitCode !== null) return
        child.kill('SIGTERM')
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(undefined) }, 8_000)),
        ])
      },
    }
  } catch (error) {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill('SIGKILL')
    throw error
  }
}

/**
 * Build a public DSH Host API client bound to a booted profile URL. It posts to
 * `/api/<method>` exactly as the browser carrier does and returns the raw
 * `result` slot (`{ ok, value } | { ok:false, error }`) so callers can inspect
 * business failures (used for the public `session.history` diagnostic).
 */
export function makeDshApiClient(url) {
  let sequence = 0
  return async (method, payload) => {
    const rpcId = `forgeyard-dsh-api-${Date.now()}-${String(++sequence)}`
    const response = await fetch(new URL(`/api/${method}`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    const envelope = await response.json()
    if (!response.ok || envelope?.rpcId !== rpcId || envelope?.result === undefined) {
      throw new Error(`DSH ${method} transport failed: ${JSON.stringify(envelope)}`)
    }
    return envelope.result
  }
}

/**
 * Read the latest `turn/end` reason for a Session through the public
 * `session.history` API. Returns a structured diagnostic used to distinguish a
 * provider/model error (kind:'error') from a completed turn that made no edit.
 */
export async function latestTurnEnd(dshApi, sessionId) {
  const result = await dshApi('session.history', { sessionId, maxMessages: 100 })
  if (!result?.ok) return { available: false, error: result?.error ?? null }
  const events = result.value?.events ?? []
  const ends = events.filter((entry) => entry?.event?.type === 'turn/end')
  const last = ends[ends.length - 1]?.event
  return { available: true, turnEndCount: ends.length, reason: last?.data?.reason ?? null }
}

/** Build a Forgeyard Typert Remote client bound to a booted profile URL. */
export function makeRemoteClient(url) {
  let sequence = 0
  const invokeRemote = async (method, args) => {
    const rpcId = `forgeyard-harness-${Date.now()}-${String(++sequence)}`
    const response = await fetch(new URL(`/api/forgeyard/${method}`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: `forgeyard/${method}`, payload: { args } }),
    })
    const envelope = await response.json()
    if (!response.ok || envelope?.rpcId !== rpcId || envelope?.result?.ok !== true) {
      throw new Error(`Forgeyard Typert ${method} Remote transport failed: ${JSON.stringify(envelope)}`)
    }
    return envelope.result.value
  }
  const remote = async (method, args) => {
    const result = await invokeRemote(method, args)
    if (result?.ok !== true) throw new Error(`Forgeyard ${method} domain operation failed: ${JSON.stringify(result)}`)
    return result.value
  }
  return { invokeRemote, remote }
}
