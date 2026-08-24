import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

// Playwright's cache layout is revision- and architecture-dependent
// (`chromium-<rev>/chrome-linux/chrome`,
// `chromium_headless_shell-<rev>/chrome-headless-shell-mac-arm64/…`,
// `chromium-<rev>/chrome-mac/Chromium.app/…`), so the cache is *discovered*
// rather than enumerated as fixed paths: any revision installed by the
// documented `npx playwright install chromium` is found on every platform.
const PLAYWRIGHT_INSTALL_DIR = /^chromium(_headless_shell)?-(\d+)$/u
const PLAYWRIGHT_EXECUTABLES = [
  'chrome-headless-shell',
  'chrome-headless-shell.exe',
  'chrome',
  'chrome.exe',
  'Chromium.app/Contents/MacOS/Chromium',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
]

const PATH_EXECUTABLES = process.platform === 'win32'
  ? ['chrome.exe']
  : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome']

const SYSTEM_CANDIDATES = process.platform === 'darwin'
  ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  : process.platform === 'win32'
    ? [
        join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']

/** Every directory Playwright may have installed a browser revision into. */
export function playwrightCacheRoots() {
  const roots = []
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH
  // `0` is Playwright's opt-out: browsers live beside the installed package.
  if (typeof configured === 'string' && configured.length > 0 && configured !== '0') roots.push(configured)
  if (process.platform === 'darwin') roots.push(join(homedir(), 'Library', 'Caches', 'ms-playwright'))
  else if (process.platform === 'win32') roots.push(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright'))
  else roots.push(join(homedir(), '.cache', 'ms-playwright'))
  roots.push(join(workspaceRoot, 'node_modules', 'playwright-core', '.local-browsers'))
  return roots
}

function readDirectories(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
  } catch {
    return []
  }
}

/** Discover installed Playwright Chromium revisions, newest usable one first. */
function playwrightChromiumCandidates() {
  const found = []
  for (const root of playwrightCacheRoots()) {
    for (const install of readDirectories(root)) {
      const parsed = PLAYWRIGHT_INSTALL_DIR.exec(install.name)
      if (parsed === null) continue
      const installDir = join(root, install.name)
      for (const variant of readDirectories(installDir)) {
        for (const relative of PLAYWRIGHT_EXECUTABLES) {
          const candidate = join(installDir, variant.name, relative)
          if (existsSync(candidate)) {
            found.push({ path: candidate, revision: Number(parsed[2]), headlessShell: parsed[1] !== undefined })
          }
        }
      }
    }
  }
  // Newest revision first; at equal revisions a headless shell boots faster.
  found.sort((left, right) => right.revision - left.revision || Number(right.headlessShell) - Number(left.headlessShell))
  return found.map((entry) => entry.path)
}

/** Chromium-family executables reachable through PATH. */
function pathChromiumCandidates() {
  const found = []
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0)) {
    for (const name of PATH_EXECUTABLES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) found.push(candidate)
    }
  }
  return found
}

/** Every Chromium-family executable this host can offer, in preference order. */
export function chromiumCandidates() {
  const explicit = process.env.FORGEYARD_CHROMIUM
  const ordered = [
    ...(typeof explicit === 'string' && explicit.length > 0 ? [explicit] : []),
    ...playwrightChromiumCandidates(),
    ...pathChromiumCandidates(),
    ...SYSTEM_CANDIDATES,
  ]
  return [...new Set(ordered)].filter((candidate) => existsSync(candidate))
}

/** Resolve the first usable Chromium-family executable, or null when none exist. */
export function findChromium() {
  return chromiumCandidates()[0] ?? null
}

/** Launch a headless Chromium and resolve its DevTools browser WebSocket URL. */
export async function launchChromium({ userDataDir, executablePath, timeoutMs = 20_000 }) {
  const exe = executablePath ?? findChromium()
  if (exe === null) throw new Error('no Chromium-family browser executable was found for browser automation')
  const isHeadlessShell = /chrome-headless-shell/.test(exe)
  // Chromium's own sandbox stays on by default. Some hosts (Ubuntu 23.10+ and
  // other distros that restrict unprivileged user namespaces through AppArmor)
  // cannot start it at all; disabling it is an explicit operator opt-in, never a
  // silent fallback.
  const noSandbox = process.env.FORGEYARD_CHROMIUM_NO_SANDBOX === '1'
  const args = [
    ...(isHeadlessShell ? [] : ['--headless=new']),
    ...(noSandbox ? ['--no-sandbox'] : []),
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--window-size=1440,1000',
    'about:blank',
  ]
  let stderr = ''
  let resolveWs
  let rejectWs
  const ready = new Promise((resolve, reject) => { resolveWs = resolve; rejectWs = reject })
  const deadline = setTimeout(() => rejectWs(new Error(`Chromium did not expose a DevTools endpoint within ${timeoutMs} ms.\n${stderr}`)), timeoutMs)
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const inspect = (chunk) => {
    stderr += chunk.toString()
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u)
    if (match?.[1] !== undefined) resolveWs(match[1])
  }
  child.stdout.on('data', inspect)
  child.stderr.on('data', inspect)
  child.once('error', rejectWs)
  const onExit = (code, signal) => rejectWs(new Error(`Chromium exited before readiness (${String(code)}/${String(signal)}).\n${stderr}`))
  child.once('exit', onExit)
  try {
    const wsUrl = await ready
    clearTimeout(deadline)
    child.off('exit', onExit)
    return {
      wsUrl,
      executablePath: exe,
      child,
      async stop() {
        if (child.exitCode !== null) return
        child.kill('SIGTERM')
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(undefined) }, 5_000)),
        ])
      },
    }
  } catch (error) {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill('SIGKILL')
    if (/No usable sandbox/u.test(stderr)) {
      throw new Error(
        'MISSING CAPABILITY: this host cannot start Chromium\u2019s own sandbox (it restricts unprivileged '
        + 'user namespaces, typically Ubuntu 23.10+ with AppArmor). Allow them '
        + '(sysctl -w kernel.apparmor_restrict_unprivileged_userns=0), or rerun with '
        + 'FORGEYARD_CHROMIUM_NO_SANDBOX=1 to accept an unsandboxed browser for this run.',
      )
    }
    throw error
  }
}

/**
 * Minimal Chrome DevTools Protocol page session over Node's built-in WebSocket.
 * No third-party browser-automation dependency is used.
 *
 * Fails closed on disconnection: if Chromium crashes or the DevTools socket
 * closes, every outstanding command and load waiter is rejected and all later
 * commands reject immediately, so the acceptance run reports the lost browser
 * instead of hanging forever.
 */
export class CdpPage {
  #ws
  #nextId = 1
  #pending = new Map()
  #sessionId
  #loadWaiters = []
  #failure = null

  constructor(ws, sessionId) {
    this.#ws = ws
    this.#sessionId = sessionId
    ws.addEventListener('message', (event) => this.#onMessage(event))
    ws.addEventListener('close', (event) => {
      this.#fail(new Error(`DevTools connection closed (code ${String(event?.code ?? 'unknown')}${event?.reason ? `: ${event.reason}` : ''})`))
    })
    ws.addEventListener('error', () => this.#fail(new Error('DevTools connection errored')))
  }

  static async open(browserWsUrl) {
    const ws = new WebSocket(browserWsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('failed to open DevTools browser WebSocket')), { once: true })
      ws.addEventListener('close', () => reject(new Error('DevTools browser WebSocket closed before it opened')), { once: true })
    })
    const page = new CdpPage(ws, undefined)
    const { targetId } = await page.#raw('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await page.#raw('Target.attachToTarget', { targetId, flatten: true })
    page.#sessionId = sessionId
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    return page
  }

  /** Reject every in-flight command and load waiter, and refuse later commands. */
  #fail(error) {
    if (this.#failure !== null) return
    this.#failure = error
    for (const [, waiter] of this.#pending) waiter.reject(error)
    this.#pending.clear()
    for (const waiter of this.#loadWaiters.splice(0)) waiter.reject(error)
  }

  #onMessage(event) {
    const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const { resolve, reject } = this.#pending.get(message.id)
      this.#pending.delete(message.id)
      if (message.error) reject(new Error(`CDP ${message.error.message ?? 'error'} (${JSON.stringify(message.error)})`))
      else resolve(message.result)
      return
    }
    if (message.method === 'Page.loadEventFired') {
      for (const waiter of this.#loadWaiters.splice(0)) waiter.resolve()
    }
  }

  #command(payload) {
    if (this.#failure !== null) return Promise.reject(this.#failure)
    return new Promise((resolve, reject) => {
      this.#pending.set(payload.id, { resolve, reject })
      try {
        this.#ws.send(JSON.stringify(payload))
      } catch (error) {
        this.#pending.delete(payload.id)
        reject(error)
      }
    })
  }

  #raw(method, params = {}) {
    return this.#command({ id: this.#nextId++, method, params })
  }

  /** Send a page-session-scoped CDP command. */
  send(method, params = {}) {
    return this.#command({ id: this.#nextId++, method, params, sessionId: this.#sessionId })
  }

  async navigate(url, { waitMs = 20_000 } = {}) {
    const waiter = {}
    const load = new Promise((resolve, reject) => { waiter.resolve = resolve; waiter.reject = reject })
    this.#loadWaiters.push(waiter)
    let timer
    const elapsed = new Promise((resolve) => { timer = setTimeout(resolve, waitMs) })
    try {
      await this.send('Page.navigate', { url })
      await Promise.race([load, elapsed])
    } finally {
      clearTimeout(timer)
      // Drop an abandoned waiter so a later disconnect cannot reject it unheard.
      const index = this.#loadWaiters.indexOf(waiter)
      if (index !== -1) this.#loadWaiters.splice(index, 1)
    }
  }

  /** Evaluate an expression in the page and return its by-value result. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page evaluation failed: ${detail}`)
    }
    return result.result?.value
  }

  /** Poll an expression until it returns a truthy value or the timeout elapses. */
  async waitFor(expression, { timeoutMs = 20_000, intervalMs = 200, description = expression } = {}) {
    const deadline = Date.now() + timeoutMs
    let last
    for (;;) {
      last = await this.evaluate(expression)
      if (last) return last
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description} (last value: ${JSON.stringify(last)})`)
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }

  async screenshot(path) {
    const { writeFile } = await import('node:fs/promises')
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(path, Buffer.from(data, 'base64'))
    return path
  }

  async currentUrl() {
    return this.evaluate('window.location.href')
  }

  close() {
    this.#fail(new Error('DevTools page session was closed by the harness'))
    try { this.#ws.close() } catch { /* already closing */ }
  }
}
