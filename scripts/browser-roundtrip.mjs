// Assembled-browser acceptance: drive the real pinned DSH Web profile end to end
// in a real headless Chromium (Chrome DevTools Protocol, no browser-automation
// dependency) and prove the exact Cockpit -> Session -> Attempt round trip.
//
// This is the graphical-browser counterpart to the jsdom emitted-bundle test:
// it exercises the fully assembled application, not a hand-mounted slot tree.
//
// Fails closed (non-zero exit, explicit MISSING CAPABILITY) when the browser or
// a routable provider is unavailable. Never fakes a result.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { provisionCaseSensitiveBase } from './harness/case-sensitive-workspace.mjs'
import { bootProfile, makeRemoteClient, prepareOperatorDshHome } from './harness/dsh-profile.mjs'
import { CdpPage, findChromium, launchChromium } from './harness/cdp.mjs'

const execFileAsync = promisify(execFile)
const MISSION_TITLE = 'Browser round-trip mission'
const steps = []
function step(message) { steps.push(message); process.stdout.write(`  ✓ ${message}\n`) }

async function main() {
  if (findChromium() === null) {
    throw new Error(
      'MISSING CAPABILITY: no Chromium-family browser executable is available. Install a Playwright '
      + 'Chromium (npx playwright install chromium) or Google Chrome, or set FORGEYARD_CHROMIUM.',
    )
  }

  const workspace = await provisionCaseSensitiveBase('forgeyard-browser')
  const evidenceDir = await mkdtemp(join(tmpdir(), 'forgeyard-browser-evidence-'))
  let profile
  let browser
  let page
  try {
    process.stdout.write(`Forgeyard assembled-browser acceptance (workspace backend: ${workspace.backend})\n`)

    // 1. Controlled Git fixture on a canonical, case-sensitive volume.
    const repositoryRoot = join(workspace.base, 'repositories')
    const repository = join(repositoryRoot, 'mission-repository')
    await mkdir(repository, { recursive: true })
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.email', 'forgeyard-browser@example.invalid'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.name', 'Forgeyard Browser'], { cwd: repository })
    await writeFile(join(repository, 'answer.txt'), 'TODO\n')
    await writeFile(join(repository, 'verify.mjs'), 'process.exit(0)\n')
    await execFileAsync('git', ['add', '--', 'answer.txt', 'verify.mjs'], { cwd: repository })
    await execFileAsync('git', ['commit', '-m', 'browser base'], { cwd: repository })

    // Real operator provider config (startAttempt selects a live model/session).
    const home = await prepareOperatorDshHome(workspace.base)
    if (!home.hasProvider) {
      throw new Error(
        'MISSING CAPABILITY: no operator DSH provider configuration was found (need '
        + `${home.source}/.credentials.yaml and an agent-default-model). Cannot create a native Session for the round trip.`,
      )
    }
    step(`operator provider configured: ${home.defaultModel.provider}/${home.defaultModel.model}`)

    // 2. Boot the real pinned assembled DSH Web profile.
    profile = await bootProfile({ dshHome: home.dshHome, repositoryRoot })
    step(`real pinned DSH Web profile booted at ${profile.url}`)
    const { remote } = makeRemoteClient(profile.url)

    // Setup only (NOT the round trip under test): seed one Mission + Attempt so a
    // native Session exists to select and open through the graphical UI.
    const emptySnapshot = await remote('snapshot', {})
    if (emptySnapshot?.dshVersion !== '0.1.1-rc.2' || emptySnapshot?.schemaVersion !== 2) {
      throw new Error(`unexpected initial Forgeyard snapshot: ${JSON.stringify(emptySnapshot)}`)
    }
    const mission = await remote('createMission', { request: {
      title: MISSION_TITLE,
      objective: 'Prove the assembled graphical Cockpit -> Session -> Attempt round trip.',
      repositoryPath: repository,
      baseRef: 'main',
      task: 'Inspect the repository; the browser round trip does not depend on the model output.',
      verificationCommand: 'node verify.mjs',
      provider: home.defaultModel.provider,
      model: home.defaultModel.model,
      reasoningEffort: home.defaultModel.reasoningEffort,
      agentPreset: null,
      permissionPreset: null,
    } })
    const running = await remote('startAttempt', { taskId: mission.task.id })
    const attemptId = running.attempt.id
    const sessionId = running.attempt.dshSessionId
    const worktreePath = running.attempt.worktreePath
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`startAttempt did not bind a native DSH Session: ${JSON.stringify(running.attempt)}`)
    }
    step(`seeded Mission + native Attempt (attempt ${attemptId}, session ${sessionId})`)

    // 3. Load the static Forgeyard client inside the assembled application.
    browser = await launchChromium({ userDataDir: join(evidenceDir, 'chrome-profile') })
    step(`headless Chromium launched (${browser.executablePath})`)
    page = await CdpPage.open(browser.wsUrl)
    await page.navigate(profile.url)
    await page.waitFor('document.readyState === "complete"', { description: 'assembled app document load' })
    await page.waitFor('!!document.querySelector("#app, [data-dsh-app], main, body > div")', { description: 'assembled DSH shell mounted' })

    // 4. The Forgeyard sidebar action appears inside the assembled shell.
    await page.waitFor('!!document.querySelector(\'button[aria-label="Open Forgeyard"]\')', {
      timeoutMs: 30_000, description: 'Forgeyard sidebar footer action',
    })
    step('static Forgeyard client loaded; sidebar action present in the assembled app')
    await page.screenshot(join(evidenceDir, '01-shell-with-sidebar-action.png'))

    // 5. The Cockpit overlay opens.
    await page.evaluate('document.querySelector(\'button[aria-label="Open Forgeyard"]\').click(), true')
    await page.waitFor('!!document.querySelector(\'[role="dialog"][aria-label="Forgeyard Cockpit"]\')', {
      description: 'Cockpit overlay dialog',
    })
    const styleCount = await page.evaluate('document.querySelectorAll(\'style[data-plugin-css="forgeyard/client"]\').length')
    if (styleCount !== 1) throw new Error(`expected exactly one Forgeyard style sheet, saw ${styleCount}`)
    step('Cockpit overlay opened with its declarative style sheet')
    await page.screenshot(join(evidenceDir, '02-cockpit-overlay.png'))

    // 6. A Mission and Attempt can be selected.
    await page.waitFor(
      `(() => { const b=[...document.querySelectorAll('button.fy-mission-card')].find(x=>x.textContent.includes(${JSON.stringify(MISSION_TITLE)})); if(!b) return false; b.click(); return true; })()`,
      { description: 'mission card selectable' },
    )
    await page.waitFor('[...document.querySelectorAll(".fy-header-view span")].some(s=>s.textContent==="Mission detail")', { description: 'mission detail view' })
    await page.waitFor(
      '(() => { const r=document.querySelector(\'button[role="row"].fy-attempt-row\'); if(!r) return false; r.click(); return true; })()',
      { description: 'attempt row selectable' },
    )
    await page.waitFor('[...document.querySelectorAll("h1")].some(h=>h.textContent==="Attempt review")', { description: 'attempt review view' })
    const reviewShowsWorktree = await page.evaluate(`document.body.textContent.includes(${JSON.stringify(worktreePath)})`)
    if (!reviewShowsWorktree) throw new Error('attempt review did not display the exact worktree path')
    step('selected the exact Mission and Attempt; attempt review shows the bound worktree')
    await page.screenshot(join(evidenceDir, '03-attempt-review.png'))

    // Wait until the native Session is addressable, then confirm Open Session is enabled.
    await page.waitFor(
      '(() => { const b=[...document.querySelectorAll("button")].find(x=>/Open Session/.test(x.textContent)); return !!b && !b.disabled; })()',
      { timeoutMs: 30_000, description: 'Open Session enabled (native Session in ctx.sessions.list)' },
    )
    const urlBeforeOpen = await page.currentUrl()

    // 7. Entering the native Session closes the overlay and calls ctx.sessions.open(sessionId).
    await page.evaluate('[...document.querySelectorAll("button")].find(x=>/Open Session/.test(x.textContent)).click(), true')
    await page.waitFor('!document.querySelector(\'[role="dialog"][aria-label="Forgeyard Cockpit"]\')', { description: 'overlay closed on Open Session' })
    step('entering the native Session closed the Cockpit overlay')
    const urlAfterOpen = await page.currentUrl()
    if (urlAfterOpen === urlBeforeOpen) {
      // Not all shells change the address bar; assert session entry via the header action instead.
      process.stdout.write(`  · session route unchanged in URL (${urlAfterOpen}); verifying via header action\n`)
    }

    // 8. The Session-header Forgeyard action appears for the exact Session.
    const headerTitle = await page.waitFor(
      '(() => { const b=document.querySelector(\'button[title^="Return to Forgeyard attempt"]\'); return b ? b.title : false; })()',
      { timeoutMs: 30_000, description: 'Forgeyard session-header return action' },
    )
    if (headerTitle !== `Return to Forgeyard attempt ${attemptId}`) {
      throw new Error(`session-header action mapped to the wrong attempt: ${headerTitle}`)
    }
    step(`ctx.sessions.open entered the exact Session; header action maps to attempt ${attemptId}`)
    await page.screenshot(join(evidenceDir, '04-session-header-action.png'))

    // 9. That action returns to the exact Attempt review.
    await page.evaluate('document.querySelector(\'button[title^="Return to Forgeyard attempt"]\').click(), true')
    await page.waitFor('!!document.querySelector(\'[role="dialog"][aria-label="Forgeyard Cockpit"]\')', { description: 'overlay reopened' })
    await page.waitFor('[...document.querySelectorAll("h1")].some(h=>h.textContent==="Attempt review")', { description: 'returned to attempt review' })
    const backToExactAttempt = await page.evaluate(`document.body.textContent.includes(${JSON.stringify(worktreePath)})`)
    if (!backToExactAttempt) throw new Error('return action did not reopen the exact Attempt review')
    step('session-header action returned to the exact Attempt review')
    await page.screenshot(join(evidenceDir, '05-returned-to-attempt.png'))

    process.stdout.write(
      `\nForgeyard assembled-browser round trip PASSED (${steps.length} checks). `
      + `Evidence screenshots: ${evidenceDir}\n`,
    )
  } finally {
    if (page !== undefined) page.close()
    if (browser !== undefined) await browser.stop()
    if (profile !== undefined) await profile.stop()
    await workspace.cleanup()
  }
}

main().catch((error) => {
  process.stderr.write(`\nForgeyard assembled-browser acceptance FAILED: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
