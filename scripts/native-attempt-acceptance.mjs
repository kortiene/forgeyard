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
// A verifier exit code alone is never accepted as success: verify.mjs is an
// ordinary worktree file the model can edit, so the same trusted Git Evidence
// must also show the verification contract untouched and answer.txt recorded as
// exactly the promised bytes (see scripts/harness/attempt-evidence.mjs).
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
import { ANSWER_PATH, EXPECTED_ANSWER, VERIFIER_PATH, assertTrustedPass, durationMs } from './harness/attempt-evidence.mjs'
import { bootProfile, latestTurnEnd, makeDshApiClient, makeRemoteClient, prepareOperatorDshHome } from './harness/dsh-profile.mjs'

const execFileAsync = promisify(execFile)
const DEFAULT_MODEL_DEADLINE_MS = 360_000
const steps = []
function step(message) { steps.push(message); process.stdout.write(`  \u2713 ${message}\n`) }
function note(message) { process.stdout.write(`  \u00b7 ${message}\n`) }

async function main() {
  const modelDeadlineMs = durationMs('FORGEYARD_MODEL_DEADLINE_MS', process.env.FORGEYARD_MODEL_DEADLINE_MS, DEFAULT_MODEL_DEADLINE_MS)
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
    await writeFile(join(repository, ANSWER_PATH), 'PLACEHOLDER\n')
    // Deterministic verifier: exit 0 only when answer.txt reads 42. The exact
    // promised bytes are pinned independently, from trusted Git Evidence, in
    // assertTrustedPass — so an edited verifier cannot manufacture a PASS.
    await writeFile(join(repository, VERIFIER_PATH), [
      "import { readFile } from 'node:fs/promises'",
      "const value = await readFile(new URL('./answer.txt', import.meta.url), 'utf8').catch(() => '')",
      "if (value.trim() !== '42') { console.error(`answer.txt is ${JSON.stringify(value)}, expected 42`); process.exit(1) }",
      "console.log('answer.txt is exactly 42')",
      '',
    ].join('\n'))
    await execFileAsync('git', ['add', '--', ANSWER_PATH, VERIFIER_PATH], { cwd: repository })
    await execFileAsync('git', ['commit', '-m', 'native base'], { cwd: repository })
    const baseAnswer = await readFile(join(repository, ANSWER_PATH), 'utf8')

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
      nodes: [{
        key: 'implement',
        task: [
          'Edit the file named answer.txt in the current workspace so that its entire contents are',
          'exactly the two characters 4 and 2 followed by a single trailing newline, and nothing else.',
          'Do not modify any other file. Use your editing tools to make the change now.',
        ].join(' '),
        verificationCommand: 'node verify.mjs',
        dependsOn: [],
      }],
      provider,
      model,
      reasoningEffort,
      agentPreset: null,
      permissionPreset: null,
    } })
    const policy = mission.mission.defaultPolicy
    step(`Mission + Task created; frozen model ${policy.provider}/${policy.model}, sandbox ${policy.sandboxMode}`)

    // Attempt 1 -> isolated worktree + native Session + queued model prompt.
    const running = await remote('startAttempt', { taskId: mission.tasks[0].task.id })
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
    const verified1 = await settleAttempt(invokeRemote, dshApi, attempt1, worktree1, session1, modelDeadlineMs)
    const pass1 = assertTrustedPass(verified1.view, worktree1, 'Attempt 1')
    if (pass1.otherChangedPaths.length > 0) note(`Attempt 1: Git Evidence also recorded ${pass1.otherChangedPaths.join(', ')}`)
    step(`Attempt 1: native model authored ${ANSWER_PATH} as exactly ${JSON.stringify(EXPECTED_ANSWER)} (${pass1.answerStatus}); trusted Git + confined verifier Evidence; PASS`)
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
    const frozen1 = afterRetry.missions[0]?.tasks[0]?.attempts.find((item) => item.attempt.id === attempt1)
    if (frozen1?.attempt.state !== 'retried' || frozen1.attempt.successorAttemptId !== attempt2
      || frozen1.decisions.map((decision) => decision.type).join(',') !== 'RETRY') {
      throw new Error(`Attempt 1 is not sealed with exactly one RETRY Decision: ${JSON.stringify(frozen1?.decisions)}`)
    }
    if (JSON.stringify(frozen1.evidence.map((item) => item.hash)) !== attempt1Evidence) {
      throw new Error('Attempt 1 trusted Evidence changed after Retry')
    }
    step(`RETRY: Attempt 1 sealed immutable (state retried, decision RETRY); Attempt 2 new Session ${session2}, new worktree ${worktree2}`)

    // Attempt 2 native execution -> PASS -> terminal APPROVE bound to its digest.
    const verified2 = await settleAttempt(invokeRemote, dshApi, attempt2, worktree2, session2, modelDeadlineMs)
    const pass2 = assertTrustedPass(verified2.view, worktree2, 'Attempt 2')
    if (pass2.otherChangedPaths.length > 0) note(`Attempt 2: Git Evidence also recorded ${pass2.otherChangedPaths.join(', ')}`)
    step(`Attempt 2: native model authored ${ANSWER_PATH} as exactly ${JSON.stringify(EXPECTED_ANSWER)} (${pass2.answerStatus}); trusted Git + confined verifier Evidence; PASS`)

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

    // Milestone 2: the approved deliverable becomes a durable local Git output
    // only through a separate, explicitly confirmed promotion.
    if (approved.promotion?.status !== 'eligible' || approved.promotion?.eligible !== true
      || approved.promotion?.reviewDigest !== pass2.reviewDigest || approved.promotions?.length !== 0) {
      throw new Error(`APPROVE did not leave promotion separate and eligible: ${JSON.stringify(approved.promotion)}`)
    }
    const unconfirmed = await invokeRemote('promote', { request: {
      attemptId: attempt2,
      actor: 'native-acceptance',
      rationale: 'A digest the operator never approved must never promote.',
      expectedReviewDigest: '0'.repeat(64),
    } })
    if (unconfirmed?.ok !== false || unconfirmed.error?.code !== 'PROMOTION_BLOCKED') {
      throw new Error(`Forgeyard promoted an unconfirmed review digest: ${JSON.stringify(unconfirmed)}`)
    }
    const promotedView = await remote('promote', { request: {
      attemptId: attempt2,
      actor: 'native-acceptance',
      rationale: 'Promote exactly the approved Attempt 2 deliverable into a local Forgeyard ref.',
      expectedReviewDigest: pass2.reviewDigest,
    } })
    const promotion = promotedView.promotions?.[0]
    if (promotedView.promotions?.length !== 1 || promotion?.status !== 'promoted'
      || promotion.reviewDigest !== pass2.reviewDigest
      || promotion.decisionId !== approved.decisions.at(-1)?.id
      || promotion.outputRef !== `refs/forgeyard/promotions/${attempt2}`) {
      throw new Error(`promotion did not produce one bound durable record: ${JSON.stringify(promotedView.promotions)}`)
    }
    if (promotion.projection.promoted.count + promotion.projection.excluded.count
      !== promotion.projection.manifestEntryCount) {
      throw new Error(`the promotion projection did not classify every reviewed entry: ${JSON.stringify(promotion.projection)}`)
    }
    step(`PROMOTE: ${promotion.outputRef} at ${promotion.outputCommit.slice(0, 12)} (${promotion.projection.promoted.count} promoted, ${promotion.projection.excluded.count} excluded)`)

    // The durable output must hold exactly the model-authored answer bytes and
    // an untouched verification contract, read straight out of Git.
    const promotedAnswer = await execFileAsync('git', ['cat-file', 'blob', `${promotion.outputCommit}:${ANSWER_PATH}`], { cwd: repository })
    if (promotedAnswer.stdout !== EXPECTED_ANSWER) {
      throw new Error(`the promoted commit does not carry ${ANSWER_PATH}=${JSON.stringify(EXPECTED_ANSWER)}: ${JSON.stringify(promotedAnswer.stdout)}`)
    }
    const promotedVerifier = await execFileAsync('git', ['cat-file', 'blob', `${promotion.outputCommit}:${VERIFIER_PATH}`], { cwd: repository })
    const baseVerifier = await execFileAsync('git', ['cat-file', 'blob', `${approved.attempt.baseCommit}:${VERIFIER_PATH}`], { cwd: repository })
    if (promotedVerifier.stdout !== baseVerifier.stdout) {
      throw new Error('the promoted commit changed the verification contract')
    }
    const promotedTree = await execFileAsync('git', ['rev-parse', `${promotion.outputCommit}^{tree}`], { cwd: repository })
    const promotedParents = await execFileAsync('git', ['rev-list', '--parents', '-n', '1', promotion.outputCommit], { cwd: repository })
    if (promotedTree.stdout.trim() !== promotion.outputTree
      || promotedParents.stdout.trim() !== `${promotion.outputCommit} ${promotion.baseCommit}`) {
      throw new Error('the promoted commit is not the recorded tree on the exact Attempt base commit')
    }
    const repeated = await invokeRemote('promote', { request: {
      attemptId: attempt2,
      actor: 'native-acceptance',
      rationale: 'Repeating a completed promotion must be refused with a stable explanation.',
      expectedReviewDigest: pass2.reviewDigest,
    } })
    if (repeated?.ok !== false || repeated.error?.code !== 'PROMOTION_BLOCKED'
      || !repeated.error.message.includes(promotion.outputCommit)) {
      throw new Error(`Forgeyard repeated a completed promotion: ${JSON.stringify(repeated)}`)
    }
    step(`promoted commit holds ${ANSWER_PATH}=${JSON.stringify(EXPECTED_ANSWER)} with an untouched verifier; repeating it is refused`)

    // Attempt 1 must remain immutable after Attempt 2's terminal decision.
    const afterApprove = await remote('snapshot', {})
    const stillFrozen1 = afterApprove.missions[0]?.tasks[0]?.attempts.find((item) => item.attempt.id === attempt1)
    if (stillFrozen1?.attempt.state !== 'retried'
      || JSON.stringify(stillFrozen1.evidence.map((item) => item.hash)) !== attempt1Evidence
      || stillFrozen1.decisions.map((decision) => decision.type).join(',') !== 'RETRY') {
      throw new Error('Attempt 1 was mutated by Attempt 2 approval')
    }
    step('Attempt 1 remained immutable after Attempt 2 approval')

    // Base checkout must remain unchanged and clean.
    const finalAnswer = await readFile(join(repository, ANSWER_PATH), 'utf8')
    if (finalAnswer !== baseAnswer) throw new Error('the base checkout answer.txt changed during the Attempt')
    const status = await execFileAsync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: repository })
    if (status.stdout !== '') throw new Error('the base checkout is dirty after the Attempt')
    const branches = await execFileAsync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/'], { cwd: repository })
    if (branches.stdout.split('\n').filter(Boolean).length !== 1) {
      throw new Error('promotion created or moved an operator branch instead of its own ref namespace')
    }
    step('base checkout unchanged and clean; promotion stayed inside refs/forgeyard/')

    process.stdout.write(`\nForgeyard native provider-driven acceptance PASSED (${steps.length} proofs).\n`)
    process.stdout.write(`  approved digest: ${pass2.reviewDigest}\n`)
    process.stdout.write(`  promoted ref:    ${promotion.outputRef}\n  promoted commit: ${promotion.outputCommit}\n`)
    process.stdout.write(`  attempt 1 (immutable, retried): ${attempt1}\n  attempt 2 (approved):           ${attempt2}\n`)
  } finally {
    if (profile !== undefined) await profile.stop()
    // Never let a cleanup failure mask the acceptance result, but never report
    // success when the provisioned workspace could not be released either.
    await workspace.cleanup().catch((error) => {
      process.stderr.write(`\nWARNING: the case-sensitive workspace could not be released: ${error?.message ?? error}\n`)
      process.exitCode = 1
    })
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
async function settleAttempt(invokeRemote, dshApi, attemptId, worktreePath, sessionId, modelDeadlineMs) {
  const outcome = await pollVerification(invokeRemote, attemptId, worktreePath, modelDeadlineMs)
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
async function pollVerification(invokeRemote, attemptId, worktreePath, modelDeadlineMs) {
  const deadline = Date.now() + modelDeadlineMs
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
      const answer = await readFile(join(worktreePath, ANSWER_PATH), 'utf8').catch(() => '<unreadable>')
      if (answer !== EXPECTED_ANSWER) return { status: 'model-did-not-change', answer, view }
      return { status: 'unexpected', view }
    }
    const code = result?.error?.code
    if (!['DSH_ERROR', 'VERIFICATION_REQUIRED'].includes(code)) {
      throw new Error(`Verification failed permanently: ${JSON.stringify(result)}`)
    }
    if (!announcedWorking) { note('native model turn in progress (Verification gate parked until the Agent is idle)\u2026'); announcedWorking = true }
    if (Date.now() > deadline) {
      const answer = await readFile(join(worktreePath, ANSWER_PATH), 'utf8').catch(() => '<unreadable>')
      return { status: 'model-did-not-change', answer, view: null }
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
}

main().catch((error) => {
  process.stderr.write(`\nForgeyard native provider-driven acceptance FAILED: ${error?.message ?? error}\n`)
  process.exitCode = 1
})
