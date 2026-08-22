// Native provider-driven acceptance: run a REAL DSH Attempt on a controlled Git
// fixture using an actually configured provider, a DSH sandbox reporting full
// enforcement, a deterministic model-authored code change, and a passing
// verifier.
//
// It proves, end to end and only from Host-trusted records:
//   Mission -> Task -> Attempt 1 -> isolated worktree -> native DSH model
//   execution -> actual code change -> trusted Git Evidence -> trusted verifier
//   Evidence -> PASS Verification -> current approvable review digest
//   -> RETRY (Attempt 1 sealed immutable; Attempt 2 gets a new Session and
//      worktree)
//   -> Attempt 2 native execution -> PASS -> APPROVE bound to the exact digest,
//   with Attempt 1 still immutable and the base checkout unchanged.
//
// Why RETRY precedes the terminal APPROVE: Forgeyard's SQLite authority enforces
// exactly one terminal Decision per Attempt and `retry` only accepts a
// nonterminal reviewable Attempt (awaiting_decision / interrupted /
// needs_review). An APPROVEd Attempt is terminal and can never be retried, so
// "approve then retry the same Attempt" is impossible by design. This harness
// therefore proves the approvable-success path on Attempt 1 (PASS +
// canApprove), the immutable RETRY boundary, and the terminal APPROVE on the
// successful Attempt 2 — every element the objective requires, in the only order
// the authority model permits.
//
// Fails closed (explicit MISSING CAPABILITY, non-zero exit) when a provider
// credential or a fully enforcing sandbox is unavailable. Never fakes success,
// never runs the verifier unconfined (the Host enforces confinement), and never
// treats model prose or a raw worktree read as the pass signal.

import { execFile } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { provisionCaseSensitiveBase } from './harness/case-sensitive-workspace.mjs'
import { bootProfile, latestTurnEnd, makeDshApiClient, makeRemoteClient, prepareOperatorDshHome } from './harness/dsh-profile.mjs'

const execFileAsync = promisify(execFile)
const EXPECTED = '42\n'
const MODEL_DEADLINE_MS = Number(process.env.FORGEYARD_MODEL_DEADLINE_MS ?? 360_000)
const steps = []
function step(message) { steps.push(message); process.stdout.write(`  \u2713 ${message}\n`) }
function note(message) { process.stdout.write(`  \u00b7 ${message}\n`) }

/**
 * Assert that a verified AttemptView carries a complete, trusted, fully-confined
 * PASS for the latest run: the model made the exact answer.txt change, Git
 * Evidence recorded it, and the verifier ran exit-0 under full DSH enforcement
 * in the exact worktree. Returns the current approvable review digest.
 */
function assertTrustedPass(view, worktree, label) {
  const latestRunId = view.review?.latestRunId
  const latest = (view.evidence ?? []).filter((item) => item.runId === latestRunId)
  const git = latest.find((item) => item.payload?.kind === 'git')
  const command = latest.find((item) => item.payload?.kind === 'verification-command')
  if (git === undefined) throw new Error(`${label}: latest run has no trusted Git Evidence`)
  if (command === undefined) throw new Error(`${label}: latest run has no trusted verifier Evidence`)
  if (git.completeness !== 'COMPLETE') throw new Error(`${label}: Git Evidence is ${git.completeness}, not COMPLETE`)
  if (command.completeness !== 'COMPLETE') throw new Error(`${label}: verifier Evidence is ${command.completeness}, not COMPLETE`)
  const env = Object.fromEntries((command.payload.environment ?? []).map((fact) => [fact.name, fact.value]))
  if (env['sandbox-enforcement'] !== 'full') {
    throw new Error(`${label}: verifier ran without full DSH enforcement (sandbox-enforcement=${env['sandbox-enforcement'] ?? 'absent'})`)
  }
  if (env['sandbox-workspace'] !== worktree) {
    throw new Error(`${label}: verifier confined to ${env['sandbox-workspace'] ?? 'absent'}, not the Attempt worktree ${worktree}`)
  }
  if (env['sandbox-mode'] !== 'workspace-write' && env['sandbox-mode'] !== 'read-only') {
    throw new Error(`${label}: verifier sandbox-mode is ${env['sandbox-mode'] ?? 'absent'}, not a confined mode`)
  }
  if (!env['executed-argv-sha256'] || env['executed-argv-sha256'] === 'not-executed') {
    throw new Error(`${label}: verifier argv was never executed under confinement`)
  }
  if (command.payload.exitCode !== 0) throw new Error(`${label}: trusted verifier exit code is ${command.payload.exitCode}, not 0`)
  const answerChange = git.payload.changedFiles?.find((file) => file.path === 'answer.txt')
  if (answerChange === undefined) throw new Error(`${label}: Git Evidence did not record the answer.txt change: ${JSON.stringify(git.payload.changedFiles)}`)
  if (view.review?.canApprove !== true) throw new Error(`${label}: review is not approvable: ${view.review?.reason ?? 'unknown'}`)
  return { reviewDigest: view.review.reviewDigest, answerStatus: answerChange.status }
}

async function main() {
  const workspace = await provisionCaseSensitiveBase('forgeyard-native')
  let profile
  try {
    process.stdout.write(`Forgeyard native provider-driven acceptance (workspace backend: ${workspace.backend})\n`)

    // Real operator provider configuration with a file-based credential.
    const home = await prepareOperatorDshHome(workspace.base)
    if (!home.hasCredentials) {
      throw new Error(
        `MISSING CAPABILITY: no operator DSH credentials found at ${home.source}/.credentials.yaml. `
        + 'A native model turn cannot authenticate. Configure a provider through DSH first.',
      )
    }
    // The profile default (deepseek-official) authenticates from a file-based
    // DEEPSEEK_API_KEY credential; env-var provider keys (e.g. SAKANA_API_KEY)
    // are scrubbed from tool subprocesses and cannot be replicated here.
    const provider = process.env.FORGEYARD_ACCEPT_PROVIDER ?? null
    const model = process.env.FORGEYARD_ACCEPT_MODEL ?? null
    const reasoningEffort = process.env.FORGEYARD_ACCEPT_REASONING ?? null
    note(`copied operator config: ${home.copied.join(', ') || '(none)'}`)
    note(`mission model selection: ${provider ?? '(profile default)'} / ${model ?? '(profile default)'}`)

    // Controlled Git fixture on a canonical, case-sensitive volume.
    const repositoryRoot = join(workspace.base, 'repositories')
    const repository = join(repositoryRoot, 'mission-repository')
    await mkdir(repository, { recursive: true })
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.email', 'forgeyard-native@example.invalid'], { cwd: repository })
    await execFileAsync('git', ['config', 'user.name', 'Forgeyard Native'], { cwd: repository })
    await writeFile(join(repository, 'answer.txt'), 'PLACEHOLDER\n')
    // Deterministic verifier: exit 0 only when answer.txt is exactly "42".
    await writeFile(join(repository, 'verify.mjs'), [
      "import { readFile } from 'node:fs/promises'",
      "const value = await readFile(new URL('./answer.txt', import.meta.url), 'utf8').catch(() => '')",
      "if (value.trim() !== '42') { console.error(`answer.txt is ${JSON.stringify(value)}, expected 42`); process.exit(1) }",
      "console.log('answer.txt is exactly 42')",
      '',
    ].join('\n'))
    await execFileAsync('git', ['add', '--', 'answer.txt', 'verify.mjs'], { cwd: repository })
    await execFileAsync('git', ['commit', '-m', 'native base'], { cwd: repository })
    const baseAnswer = await readFile(join(repository, 'answer.txt'), 'utf8')

    // Boot the real pinned assembled DSH Web profile.
    profile = await bootProfile({ dshHome: home.dshHome, repositoryRoot })
    step(`real pinned DSH Web profile booted at ${profile.url}`)
    const { invokeRemote, remote } = makeRemoteClient(profile.url)
    const dshApi = makeDshApiClient(profile.url)

    // Mission -> Task with a deterministic model-authored change contract.
    const mission = await remote('createMission', { request: {
      title: 'Native provider-driven acceptance',
      objective: 'Prove a real model-authored code change under trusted verification.',
      repositoryPath: repository,
      baseRef: 'main',
      task: [
        'Edit the file named answer.txt in the current workspace so that its entire contents are',
        'exactly the two characters 4 and 2 followed by a single trailing newline, and nothing else.',
        'Do not modify any other file. Use your editing tools to make the change now.',
      ].join(' '),
      verificationCommand: 'node verify.mjs',
      provider,
      model,
      reasoningEffort,
      agentPreset: null,
      permissionPreset: null,
    } })
    const policy = mission.mission.defaultPolicy
    step(`Mission + Task created; frozen model ${policy.provider}/${policy.model}, sandbox ${policy.sandboxMode}`)

    // Attempt 1 -> isolated worktree + native Session + queued model prompt.
    const running = await remote('startAttempt', { taskId: mission.task.id })
    const attempt1 = running.attempt.id
    const worktree1 = running.attempt.worktreePath
    const session1 = running.attempt.dshSessionId
    if (running.attempt.state !== 'running' || typeof session1 !== 'string' || session1.length === 0) {
      throw new Error(`Attempt 1 did not bind a native running Session: ${JSON.stringify(running.attempt)}`)
    }
    if (worktree1.startsWith(repository)) throw new Error('Attempt worktree must be outside the base repository')
    step(`Attempt 1 running: native Session ${session1}, isolated worktree ${worktree1}`)

    // Native model execution -> deterministic code change, verified only through
    // trusted Host collectors under full DSH confinement.
    const verified1 = await settleAttempt(invokeRemote, dshApi, attempt1, worktree1, session1)
    const pass1 = assertTrustedPass(verified1.view, worktree1, 'Attempt 1')
    step(`Attempt 1: native model authored answer.txt (${pass1.answerStatus}); trusted Git + confined verifier Evidence; PASS`)
    step(`Attempt 1: current approvable review digest ${pass1.reviewDigest.slice(0, 16)}\u2026`)
    const attempt1Evidence = JSON.stringify(verified1.view.evidence.map((item) => item.hash))

    // RETRY the reviewable Attempt 1 -> Attempt 2 with a new Session + worktree.
    // Attempt 1 becomes terminal (retried) and immutable.
    const retry = await remote('retry', { request: {
      attemptId: attempt1,
      actor: 'native-acceptance',
      rationale: 'Exercise the immutable retry boundary from a passing, reviewable Attempt 1.',
    } })
    const attempt2 = retry.attempt.id
    const worktree2 = retry.attempt.worktreePath
    const session2 = retry.attempt.dshSessionId
    if (retry.attempt.ordinal !== 2 || retry.attempt.retryOfAttemptId !== attempt1
      || session2 === session1 || worktree2 === worktree1) {
      throw new Error(`Retry did not create new isolated authority: ${JSON.stringify(retry.attempt)}`)
    }
    const afterRetry = await remote('snapshot', {})
    const frozen1 = afterRetry.missions[0]?.attempts.find((item) => item.attempt.id === attempt1)
    if (frozen1?.attempt.state !== 'retried' || frozen1.attempt.successorAttemptId !== attempt2
      || frozen1.decisions.map((decision) => decision.type).join(',') !== 'RETRY') {
      throw new Error(`Attempt 1 is not sealed with exactly one RETRY Decision: ${JSON.stringify(frozen1?.decisions)}`)
    }
    if (JSON.stringify(frozen1.evidence.map((item) => item.hash)) !== attempt1Evidence) {
      throw new Error('Attempt 1 trusted Evidence changed after Retry')
    }
    step(`RETRY: Attempt 1 sealed immutable (state retried, decision RETRY); Attempt 2 new Session ${session2}, new worktree ${worktree2}`)

    // Attempt 2 native execution -> PASS -> terminal APPROVE bound to its digest.
    const verified2 = await settleAttempt(invokeRemote, dshApi, attempt2, worktree2, session2)
    const pass2 = assertTrustedPass(verified2.view, worktree2, 'Attempt 2')
    step(`Attempt 2: native model authored answer.txt (${pass2.answerStatus}); trusted Git + confined verifier Evidence; PASS`)

    const approved = await remote('decide', { request: {
      attemptId: attempt2,
      type: 'APPROVE',
      actor: 'native-acceptance',
      rationale: 'Attempt 2 produced a real model-authored change with complete, confined, passing trusted Evidence.',
    } })
    if (approved.attempt.state !== 'approved' || approved.decisions.at(-1)?.type !== 'APPROVE'
      || approved.decisions.at(-1)?.reviewDigest !== pass2.reviewDigest) {
      throw new Error(`APPROVE did not bind the exact Attempt 2 review digest: ${JSON.stringify(approved)}`)
    }
    step(`APPROVE recorded for Attempt 2, bound to digest ${pass2.reviewDigest.slice(0, 16)}\u2026`)

    // Attempt 1 must remain immutable after Attempt 2's terminal decision.
    const afterApprove = await remote('snapshot', {})
    const stillFrozen1 = afterApprove.missions[0]?.attempts.find((item) => item.attempt.id === attempt1)
    if (stillFrozen1?.attempt.state !== 'retried'
      || JSON.stringify(stillFrozen1.evidence.map((item) => item.hash)) !== attempt1Evidence
      || stillFrozen1.decisions.map((decision) => decision.type).join(',') !== 'RETRY') {
      throw new Error('Attempt 1 was mutated by Attempt 2 approval')
    }
    step('Attempt 1 remained immutable after Attempt 2 approval')

    // Base checkout must remain unchanged and clean.
    const finalAnswer = await readFile(join(repository, 'answer.txt'), 'utf8')
    if (finalAnswer !== baseAnswer) throw new Error('the base checkout answer.txt changed during the Attempt')
    const status = await execFileAsync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: repository })
    if (status.stdout !== '') throw new Error('the base checkout is dirty after the Attempt')
    step('base checkout unchanged and clean')

    process.stdout.write(`\nForgeyard native provider-driven acceptance PASSED (${steps.length} proofs).\n`)
    process.stdout.write(`  approved digest: ${pass2.reviewDigest}\n`)
    process.stdout.write(`  attempt 1 (immutable, retried): ${attempt1}\n  attempt 2 (approved):           ${attempt2}\n`)
  } finally {
    if (profile !== undefined) await profile.stop()
    await workspace.cleanup()
  }
}

/**
 * Drive one Attempt to a trusted PASS or fail closed with the exact reason.
 * PASS comes only from the Host verifier record; the worktree is read only to
 * decide whether the settled turn produced the change, never as the pass signal.
 * A settled-but-unchanged turn is diagnosed through the public session.history
 * `turn/end` reason: a provider/model error is a MISSING CAPABILITY, while a
 * completed turn that made no edit is a genuine acceptance failure.
 */
async function settleAttempt(invokeRemote, dshApi, attemptId, worktreePath, sessionId) {
  const outcome = await pollVerification(invokeRemote, attemptId, worktreePath)
  if (outcome.status === 'pass') return outcome
  if (outcome.status === 'sandbox-unavailable') {
    throw new Error(
      'MISSING CAPABILITY: DSH reported no usable sandbox backend for the confined verifier; '
      + 'Forgeyard failed closed and did not run the verifier unconfined. Provide a DSH sandbox '
      + 'backend reporting full enforcement (macOS sandbox-exec / Linux bubblewrap|Landlock).',
    )
  }
  if (outcome.status === 'model-did-not-change') {
    const turnEnd = await latestTurnEnd(dshApi, sessionId)
    const reason = turnEnd.reason
    if (reason?.kind === 'error') {
      const failure = reason.error ?? {}
      throw new Error(
        `MISSING CAPABILITY: the native model turn errored (turn/end code=${failure.code ?? 'UNKNOWN'}): `
        + `${failure.message ?? JSON.stringify(reason)}. The configured provider route (${'deepseek-official'} `
        + 'by default) is not usable from a spawned DSH process. Configure a working file-based provider '
        + 'credential (e.g. DEEPSEEK_API_KEY) or override FORGEYARD_ACCEPT_PROVIDER/MODEL to a usable route.',
      )
    }
    throw new Error(
      `ACCEPTANCE FAILURE: the native model turn ended (${describeReason(reason)}) without writing answer.txt=42 `
      + `(observed ${JSON.stringify(outcome.answer)}). This is a genuine failure to produce the required change, `
      + 'not a missing environmental capability.',
    )
  }
  throw new Error(`native Verification reached an unexpected state: ${JSON.stringify(outcome)}`)
}

function describeReason(reason) {
  if (reason === null || reason === undefined) return 'no recorded turn/end'
  if (reason.kind === 'max-tokens') return 'kind=max-tokens'
  if (reason.kind === 'aborted') return `kind=aborted:${reason.reason?.kind ?? 'unknown'}`
  return `kind=${reason.kind ?? 'unknown'}`
}

/**
 * Poll the trusted Verification gate until the native model turn settles.
 * The gate acquires the exact live Agent's maintenance phase and only runs the
 * verifier once the turn is idle, so a returned verifier result proves the turn
 * settled. Returns a structured outcome; never trusts model prose.
 */
async function pollVerification(invokeRemote, attemptId, worktreePath) {
  const deadline = Date.now() + MODEL_DEADLINE_MS
  let announcedWorking = false
  for (;;) {
    const result = await invokeRemote('verifyAttempt', { attemptId })
    if (result?.ok === true) {
      const view = result.value
      const latestRunId = view.review?.latestRunId
      const latest = (view.verifications ?? []).filter((item) => item.runId === latestRunId)
      const status = latest[latest.length - 1]?.status
      const command = (view.evidence ?? []).filter((item) => item.runId === latestRunId)
        .find((item) => item.payload?.kind === 'verification-command')
      if (view.review?.canApprove === true && status === 'PASS') return { status: 'pass', view }
      if (status === 'ERROR' && command?.payload?.spawnError?.includes('no sandbox backend is usable')) {
        return { status: 'sandbox-unavailable', view }
      }
      // Agent turn is idle (the verifier ran) but the change is absent/incorrect.
      const answer = await readFile(join(worktreePath, 'answer.txt'), 'utf8').catch(() => '<unreadable>')
      if (answer.trim() !== '42') return { status: 'model-did-not-change', answer, view }
      return { status: 'unexpected', view }
    }
    const code = result?.error?.code
    if (!['DSH_ERROR', 'VERIFICATION_REQUIRED'].includes(code)) {
      throw new Error(`Verification failed permanently: ${JSON.stringify(result)}`)
    }
    if (!announcedWorking) { note('native model turn in progress (Verification gate parked until the Agent is idle)\u2026'); announcedWorking = true }
    if (Date.now() > deadline) {
      const answer = await readFile(join(worktreePath, 'answer.txt'), 'utf8').catch(() => '<unreadable>')
      return { status: 'model-did-not-change', answer, view: null }
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
}

main().catch((error) => {
  process.stderr.write(`\nForgeyard native provider-driven acceptance FAILED: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
