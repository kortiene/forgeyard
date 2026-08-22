import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHROMIUM_CANDIDATES = [
  join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-x64/chrome-headless-shell'),
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** Resolve the first usable Chromium-family executable, or null when none exist. */
export function findChromium() {
  if (process.env.FORGEYARD_CHROMIUM && existsSync(process.env.FORGEYARD_CHROMIUM)) return process.env.FORGEYARD_CHROMIUM
  return CHROMIUM_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null
}

/** Launch a headless Chromium and resolve its DevTools browser WebSocket URL. */
export async function launchChromium({ userDataDir, executablePath, timeoutMs = 20_000 }) {
  const exe = executablePath ?? findChromium()
  if (exe === null) throw new Error('no Chromium-family browser executable was found for browser automation')
  const isHeadlessShell = /chrome-headless-shell/.test(exe)
  const args = [
    ...(isHeadlessShell ? [] : ['--headless=new']),
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
    throw error
  }
}

/**
 * Minimal Chrome DevTools Protocol page session over Node's built-in WebSocket.
 * No third-party browser-automation dependency is used.
 */
export class CdpPage {
  #ws
  #nextId = 1
  #pending = new Map()
  #sessionId
  #loadWaiters = []

  constructor(ws, sessionId) {
    this.#ws = ws
    this.#sessionId = sessionId
    ws.addEventListener('message', (event) => this.#onMessage(event))
  }

  static async open(browserWsUrl) {
    const ws = new WebSocket(browserWsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('failed to open DevTools browser WebSocket')), { once: true })
    })
    const page = new CdpPage(ws, undefined)
    const { targetId } = await page.#raw('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await page.#raw('Target.attachToTarget', { targetId, flatten: true })
    page.#sessionId = sessionId
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    return page
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
      for (const waiter of this.#loadWaiters.splice(0)) waiter()
    }
  }

  #raw(method, params = {}) {
    const id = this.#nextId++
    const payload = { id, method, params }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify(payload))
    })
  }

  /** Send a page-session-scoped CDP command. */
  send(method, params = {}) {
    const id = this.#nextId++
    const payload = { id, method, params, sessionId: this.#sessionId }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify(payload))
    })
  }

  async navigate(url, { waitMs = 20_000 } = {}) {
    const load = new Promise((resolve) => { this.#loadWaiters.push(resolve) })
    await this.send('Page.navigate', { url })
    await Promise.race([load, new Promise((resolve) => setTimeout(resolve, waitMs))])
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
    try { this.#ws.close() } catch { /* already closing */ }
  }
}
