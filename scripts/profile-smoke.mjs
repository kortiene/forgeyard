import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dsh = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const profile = join(root, 'profiles', 'local')
// Forgeyard requires canonical managed roots (it realpaths repository roots and
// rejects a worktree root that traverses a symlink). macOS resolves its
// temporary base under /var -> /private/var, so canonicalize both temp roots.
const dshHome = await realpath(await mkdtemp(join(tmpdir(), 'forgeyard-dsh-profile-')))
const repositoryRoot = await realpath(await mkdtemp(join(tmpdir(), 'forgeyard-dsh-repositories-')))
const repository = join(repositoryRoot, 'mission-repository')
const execFileAsync = promisify(execFile)
let child

try {
  await mkdir(repository)
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repository })
  await execFileAsync('git', ['config', 'user.email', 'forgeyard-smoke@example.invalid'], { cwd: repository })
  await execFileAsync('git', ['config', 'user.name', 'Forgeyard Smoke'], { cwd: repository })
  await writeFile(join(repository, 'source.txt'), 'base\n')
  await writeFile(join(repository, 'verify.mjs'), "process.exit(0)\n")
  await execFileAsync('git', ['add', '--', 'source.txt', 'verify.mjs'], { cwd: repository })
  await execFileAsync('git', ['commit', '-m', 'smoke base'], { cwd: repository })

  await mkdir(join(dshHome, 'profiles'), { recursive: true })
  await symlink(profile, join(dshHome, 'profiles', 'local'), process.platform === 'win32' ? 'junction' : 'dir')
  let output = ''
  let resolveUrl
  let rejectUrl
  const ready = new Promise((resolve, reject) => {
    resolveUrl = resolve
    rejectUrl = reject
  })
  const deadline = setTimeout(() => rejectUrl(new Error(`DSH Web did not start within 20 seconds.\n${output}`)), 20_000)
  child = spawn(dsh, ['--profile', 'local', '--no-open', '--port', '0'], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      FORGEYARD_REPOSITORY_ROOT: repositoryRoot,
      DSH_TELEMETRY_MODE: 'DISABLED',
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
  child.once('exit', (code, signal) => {
    rejectUrl(new Error(`DSH Web exited before readiness (${String(code)}/${String(signal)}).\n${output}`))
  })

  const url = await ready
  clearTimeout(deadline)
  const response = await fetch(url)
  const html = await response.text()
  if (!response.ok || !/<html[\s>]/iu.test(html)) {
    throw new Error(`DSH Web returned an invalid root document (${response.status})`)
  }

  let rpcSequence = 0
  const invokeRemote = async (method, args) => {
    const rpcId = `forgeyard-smoke-${Date.now()}-${String(++rpcSequence)}`
    const response = await fetch(new URL(`/api/forgeyard/${method}`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: `forgeyard/${method}`,
        payload: { args },
      }),
    })
    const envelope = await response.json()
    const result = envelope?.result?.value
    if (!response.ok || envelope?.rpcId !== rpcId || envelope?.result?.ok !== true) {
      throw new Error(`Forgeyard Typert ${method} Remote failed: ${JSON.stringify(envelope)}`)
    }
    return result
  }
  const remote = async (method, args) => {
    const result = await invokeRemote(method, args)
    if (result?.ok !== true) {
      throw new Error(`Forgeyard Typert ${method} domain operation failed: ${JSON.stringify(result)}`)
    }
    return result.value
  }
  const verifyWhenIdle = async (attemptId) => {
    let verified
    const verificationDeadline = Date.now() + 30_000
    while (verified === undefined && Date.now() < verificationDeadline) {
      const result = await invokeRemote('verifyAttempt', { attemptId })
      if (result?.ok === true) return result.value
      if (!['DSH_ERROR', 'VERIFICATION_REQUIRED'].includes(result?.error?.code)) {
        throw new Error(`Forgeyard profile Verification failed permanently: ${JSON.stringify(result)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('native DSH Agent did not become verifiably idle within 30 seconds')
  }

  const emptySnapshot = await remote('snapshot', {})
  if (!Array.isArray(emptySnapshot?.missions) || emptySnapshot?.dshVersion !== '0.1.1-rc.2'
    || emptySnapshot?.schemaVersion !== 3) {
    throw new Error(`Forgeyard initial snapshot is incompatible: ${JSON.stringify(emptySnapshot)}`)
  }
  const mission = await remote('createMission', { request: {
    title: 'Profile smoke mission',
    objective: 'Prove native Session admission from an isolated Forgeyard worktree.',
    repositoryPath: repository,
    baseRef: 'main',
    nodes: [{
      key: 'implement',
      task: 'Inspect the repository and preserve its behavior.',
      verificationCommand: 'node verify.mjs',
      dependsOn: [],
    }],
    provider: null,
    model: null,
    reasoningEffort: null,
    agentPreset: null,
    permissionPreset: null,
  } })
  const node = mission.tasks?.[0]
  if (mission.tasks?.length !== 1 || node?.task?.sourceNodeKey !== 'implement'
    || node.readiness?.status !== 'ready' || node.readiness?.startable !== true
    || node.nodeState !== 'ready' || mission.derivedState !== 'ready'
    || node.attempts?.length !== 0 || mission.mission?.pipe?.nodes?.[0]?.dependsOn?.length !== 0
    || 'task' in mission || 'attempts' in mission) {
    throw new Error(`Forgeyard did not expose the one-node Mission through the plural API: ${JSON.stringify(mission)}`)
  }
  const running = await remote('startAttempt', { taskId: node.task.id })
  if (running?.attempt?.state !== 'running' || running.attempt.ordinal !== 1
    || typeof running.attempt.dshSessionId !== 'string' || running.attempt.dshSessionId.length === 0
    || running.attempt.worktreePath.startsWith(repository)
    || running.attempt.rawWorkspaceBaselineHash !== running.attempt.rawWorkspaceBaseline?.hash
    || !existsSync(running.attempt.worktreePath)) {
    throw new Error(`Forgeyard did not bind one native isolated Attempt: ${JSON.stringify(running?.attempt)}`)
  }
  const populatedSnapshot = await remote('snapshot', {})
  const populatedMission = populatedSnapshot.missions?.[0]
  if (populatedMission?.tasks?.[0]?.attempts?.[0]?.attempt?.dshSessionId !== running.attempt.dshSessionId
    || populatedMission.tasks[0].readiness?.startable !== false
    || populatedMission.tasks[0].nodeState !== 'running'
    || populatedMission.derivedState !== 'running') {
    throw new Error(`Forgeyard snapshot did not retain the node-owned native Session association: ${JSON.stringify(populatedMission)}`)
  }

  // Prompt admission is intentionally not treated as completion. Poll the
  // explicit public maintenance gate until the native Agent is idle, then run
  // trusted Git/command collection through the real DSH sandbox/subprocess.
  const verified = await verifyWhenIdle(running.attempt.id)
  if (verified.attempt?.state !== 'awaiting_decision' || verified.evidence?.length !== 2) {
    throw new Error(`Forgeyard real-profile Verification did not complete: ${JSON.stringify(verified)}`)
  }
  const firstPassed = verified.review?.canApprove === true && verified.verifications?.[0]?.status === 'PASS'
  if (!firstPassed) {
    const command = verified.evidence.find(item => item.payload?.kind === 'verification-command')
    if (verified.review?.canApprove !== false || verified.verifications?.[0]?.status !== 'ERROR'
      || !command?.payload?.spawnError?.includes('no sandbox backend is usable')) {
      throw new Error(`Forgeyard real-profile Verification failed unexpectedly: ${JSON.stringify(verified)}`)
    }
    const blocked = await invokeRemote('decide', { request: {
      attemptId: running.attempt.id,
      type: 'APPROVE',
      actor: 'profile-smoke',
      rationale: 'This intentionally confirms fail-closed approval behavior.',
    } })
    if (blocked?.ok !== false || !['VERIFICATION_REQUIRED', 'REVIEW_STALE'].includes(blocked.error?.code)) {
      throw new Error(`Forgeyard accepted non-passing real-profile Verification: ${JSON.stringify(blocked)}`)
    }
  }

  const retry = await remote('retry', { request: {
    attemptId: running.attempt.id,
    actor: 'profile-smoke',
    rationale: firstPassed
      ? 'Exercise the immutable retry boundary after a passing review.'
      : 'The first verifier could not run confined; exercise the immutable retry boundary.',
  } })
  if (retry.attempt?.ordinal !== 2 || retry.attempt.retryOfAttemptId !== running.attempt.id
    || retry.attempt.dshSessionId === running.attempt.dshSessionId
    || retry.attempt.worktreePath === running.attempt.worktreePath
    || !existsSync(retry.attempt.worktreePath)) {
    throw new Error(`Forgeyard real-profile Retry did not create new authority: ${JSON.stringify(retry)}`)
  }
  const afterRetry = await remote('snapshot', {})
  const frozenFirst = afterRetry.missions?.[0]?.tasks?.[0]?.attempts?.find(item => item.attempt?.id === running.attempt.id)
  if (frozenFirst?.attempt?.state !== 'retried' || frozenFirst?.attempt?.successorAttemptId !== retry.attempt.id
    || frozenFirst.decisions?.[0]?.type !== 'RETRY') {
    throw new Error(`Forgeyard did not retain immutable Attempt 1 Retry authority: ${JSON.stringify(frozenFirst)}`)
  }

  const retryVerified = await verifyWhenIdle(retry.attempt.id)
  let decisionOutcome
  let promotionRecord
  if (retryVerified.review?.canApprove === true && retryVerified.verifications?.[0]?.status === 'PASS') {
    const approved = await remote('decide', { request: {
      attemptId: retry.attempt.id,
      type: 'APPROVE',
      actor: 'profile-smoke',
      rationale: 'Attempt 2 produced complete passing trusted Evidence.',
    } })
    if (approved.attempt?.state !== 'approved'
      || approved.decisions?.[0]?.reviewDigest !== retryVerified.review.reviewDigest) {
      throw new Error(`Forgeyard real-profile approval did not bind the exact review: ${JSON.stringify(approved)}`)
    }
    // Milestone 2: approval alone must not deliver anything. Promotion is a
    // separate, explicitly confirmed action bound to the exact approved digest.
    if (approved.promotion?.status !== 'eligible' || approved.promotion?.eligible !== true
      || approved.promotion?.reviewDigest !== approved.decisions[0].reviewDigest
      || approved.promotions?.length !== 0 || approved.promotion?.outputCommit !== null) {
      throw new Error(`Forgeyard approval did not leave promotion pending and eligible: ${JSON.stringify(approved.promotion)}`)
    }
    const wrongDigest = await invokeRemote('promote', { request: {
      attemptId: retry.attempt.id,
      actor: 'profile-smoke',
      rationale: 'A digest the operator never approved must never promote.',
      expectedReviewDigest: '0'.repeat(64),
    } })
    if (wrongDigest?.ok !== false || wrongDigest.error?.code !== 'PROMOTION_BLOCKED') {
      throw new Error(`Forgeyard promoted an unconfirmed review digest: ${JSON.stringify(wrongDigest)}`)
    }
    const promoted = await remote('promote', { request: {
      attemptId: retry.attempt.id,
      actor: 'profile-smoke',
      rationale: 'Promote exactly the approved Attempt 2 deliverable into a local Forgeyard ref.',
      expectedReviewDigest: approved.decisions[0].reviewDigest,
    } })
    const record = promoted.promotions?.[0]
    if (promoted.promotions?.length !== 1 || record?.status !== 'promoted'
      || record.reviewDigest !== approved.decisions[0].reviewDigest
      || record.decisionId !== approved.decisions[0].id
      || record.outputRef !== `refs/forgeyard/promotions/${retry.attempt.id}`
      || !/^[0-9a-f]{40,64}$/u.test(record.outputCommit ?? '')
      || record.projection?.promoted?.count + record.projection?.excluded?.count
        !== record.projection?.manifestEntryCount) {
      throw new Error(`Forgeyard promotion did not produce one bound durable record: ${JSON.stringify(promoted.promotions)}`)
    }
    if (promoted.promotion?.status !== 'promoted' || promoted.promotion?.eligible !== false) {
      throw new Error(`Forgeyard did not report the Attempt as promoted: ${JSON.stringify(promoted.promotion)}`)
    }
    const repeated = await invokeRemote('promote', { request: {
      attemptId: retry.attempt.id,
      actor: 'profile-smoke',
      rationale: 'Repeating a completed promotion must be refused with a stable explanation.',
      expectedReviewDigest: approved.decisions[0].reviewDigest,
    } })
    if (repeated?.ok !== false || repeated.error?.code !== 'PROMOTION_BLOCKED'
      || !repeated.error.message.includes(record.outputCommit)) {
      throw new Error(`Forgeyard repeated a completed promotion: ${JSON.stringify(repeated)}`)
    }
    promotionRecord = record
    decisionOutcome = 'Retry/new Session/worktree, passing Attempt 2 approval, and one explicit local promotion'
  } else {
    const command = retryVerified.evidence.find(item => item.payload?.kind === 'verification-command')
    if (retryVerified.review?.canApprove !== false || retryVerified.verifications?.[0]?.status !== 'ERROR'
      || !command?.payload?.spawnError?.includes('no sandbox backend is usable')) {
      throw new Error(`Forgeyard real-profile Attempt 2 Verification failed unexpectedly: ${JSON.stringify(retryVerified)}`)
    }
    const blocked = await invokeRemote('decide', { request: {
      attemptId: retry.attempt.id,
      type: 'APPROVE',
      actor: 'profile-smoke',
      rationale: 'This confirms Attempt 2 still fails closed without a sandbox backend.',
    } })
    if (blocked?.ok !== false || !['VERIFICATION_REQUIRED', 'REVIEW_STALE'].includes(blocked.error?.code)) {
      throw new Error(`Forgeyard accepted non-passing real-profile Verification: ${JSON.stringify(blocked)}`)
    }
    const rejected = await remote('decide', { request: {
      attemptId: retry.attempt.id,
      type: 'REJECT',
      actor: 'profile-smoke',
      rationale: 'The host has no usable DSH sandbox backend; retain both Attempts.',
    } })
    if (rejected.attempt?.state !== 'rejected'
      || rejected.decisions?.[0]?.reviewDigest !== retryVerified.review.reviewDigest) {
      throw new Error(`Forgeyard real-profile rejection did not bind the exact review: ${JSON.stringify(rejected)}`)
    }
    const promotionBlocked = await invokeRemote('promote', { request: {
      attemptId: retry.attempt.id,
      actor: 'profile-smoke',
      rationale: 'A rejected Attempt must never be promotable.',
      expectedReviewDigest: retryVerified.review.reviewDigest,
    } })
    if (promotionBlocked?.ok !== false || promotionBlocked.error?.code !== 'PROMOTION_BLOCKED') {
      throw new Error(`Forgeyard promoted a rejected Attempt: ${JSON.stringify(promotionBlocked)}`)
    }
    if (rejected.promotion?.status !== 'blocked' || rejected.promotion?.eligible !== false) {
      throw new Error(`Forgeyard did not block promotion for a rejected Attempt: ${JSON.stringify(rejected.promotion)}`)
    }
    decisionOutcome = 'Retry/new Session/worktree plus sandbox-unavailable Attempt 2 rejection with approval and promotion blocked'
  }

  // Milestone 3 slice 2: materialize a real two-node serial Pipe through the
  // generated Remote. The follow-up is visible and blocked at both view and Host
  // admission layers; promoted-base propagation deliberately lands next.
  const serial = await remote('createMission', { request: {
    title: 'Profile smoke serial Pipe',
    objective: 'Prove atomic A -> B Task materialization before downstream execution exists.',
    repositoryPath: repository,
    baseRef: 'main',
    nodes: [
      {
        key: 'A',
        task: 'Inspect the repository as the upstream serial node.',
        verificationCommand: 'node verify.mjs',
        dependsOn: [],
      },
      {
        key: 'B',
        task: 'Perform an independent follow-up after A is approved and promoted.',
        verificationCommand: 'node verify.mjs',
        dependsOn: ['A'],
      },
    ],
    provider: null,
    model: null,
    reasoningEffort: null,
    agentPreset: null,
    permissionPreset: null,
  } })
  const [serialA, serialB] = serial.tasks ?? []
  if (serial.tasks?.length !== 2
    || serial.mission?.pipe?.nodes?.map(node => node.key).join(',') !== 'A,B'
    || serial.mission.pipe.nodes[0]?.dependsOn?.length !== 0
    || serial.mission.pipe.nodes[1]?.dependsOn?.join(',') !== 'A'
    || serialA?.task?.dependencies?.length !== 0
    || serialB?.task?.dependencies?.join(',') !== serialA?.task?.id
    || serialA.readiness?.status !== 'ready' || serialA.readiness?.startable !== true
    || serialB.readiness?.status !== 'blocked' || serialB.readiness?.startable !== false
    || serialB.readiness?.blockedBy?.join(',') !== 'A'
    || !serialB.readiness?.reason?.includes('blocked on A')
    || serial.derivedState !== 'ready') {
    throw new Error(`Forgeyard did not materialize one honest serial Pipe: ${JSON.stringify(serial)}`)
  }
  const blockedDownstream = await invokeRemote('startAttempt', { taskId: serialB.task.id })
  if (blockedDownstream?.ok !== false || blockedDownstream.error?.code !== 'INVALID_STATE'
    || !blockedDownstream.error.message.includes('dependency admission and base propagation')) {
    throw new Error(`Forgeyard admitted downstream Task B before propagated-base support: ${JSON.stringify(blockedDownstream)}`)
  }
  const afterSerial = await remote('snapshot', {})
  const retainedSerial = afterSerial.missions?.find(item => item.mission?.id === serial.mission.id)
  if (retainedSerial?.tasks?.some(item => item.attempts?.length !== 0)
    || retainedSerial?.tasks?.length !== 2) {
    throw new Error(`Forgeyard changed serial Pipe authority after refused admission: ${JSON.stringify(retainedSerial)}`)
  }
  decisionOutcome += ', plus atomic two-node Pipe materialization with downstream admission blocked'

  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('DSH Web did not stop after SIGTERM')), 10_000)),
  ])
  child = undefined

  const databasePath = join(dshHome, 'forgeyard.sqlite')
  if (!existsSync(databasePath)) throw new Error('Forgeyard Host did not create forgeyard.sqlite')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name)
  const schemaVersion = database.prepare('PRAGMA user_version').get().user_version
  const counts = Object.fromEntries(['missions', 'tasks', 'attempts'].map(table => [
    table,
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
  ]))
  database.close()
  const expected = [
    'attempts', 'decisions', 'evidence', 'missions', 'promotions', 'schema_migrations', 'tasks', 'verifications',
  ]
  if (JSON.stringify(tables) !== JSON.stringify(expected)) {
    throw new Error(`Forgeyard Host schema mismatch: ${JSON.stringify(tables)}`)
  }
  if (schemaVersion !== 3 || counts.missions !== 2 || counts.tasks !== 3 || counts.attempts !== 2) {
    throw new Error(`Forgeyard Host authority mismatch: schema=${String(schemaVersion)} counts=${JSON.stringify(counts)}`)
  }
  if (await readFile(join(repository, 'source.txt'), 'utf8') !== 'base\n') {
    throw new Error('Forgeyard profile smoke changed the base checkout')
  }
  const { stdout: baseStatus } = await execFileAsync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: repository })
  if (baseStatus !== '') throw new Error('Forgeyard profile smoke left the base checkout dirty')
  const { stdout: baseHead } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repository })
  const { stdout: baseBranch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repository })
  if (baseBranch.trim() !== 'main') throw new Error('Forgeyard profile smoke moved the base checkout off its branch')
  if (promotionRecord !== undefined) {
    // The durable output must survive the Host and be inspectable from the
    // operator's own checkout, without having moved that checkout at all.
    const { stdout: refCommit } = await execFileAsync(
      'git', ['rev-parse', '--verify', `${promotionRecord.outputRef}^{commit}`], { cwd: repository },
    )
    if (refCommit.trim() !== promotionRecord.outputCommit) {
      throw new Error(`Forgeyard promotion ref does not resolve to the recorded commit: ${refCommit.trim()}`)
    }
    const { stdout: refTree } = await execFileAsync(
      'git', ['rev-parse', '--verify', `${promotionRecord.outputCommit}^{tree}`], { cwd: repository },
    )
    if (refTree.trim() !== promotionRecord.outputTree) {
      throw new Error(`Forgeyard promotion commit does not carry the recorded tree: ${refTree.trim()}`)
    }
    const { stdout: parents } = await execFileAsync(
      'git', ['rev-list', '--parents', '-n', '1', promotionRecord.outputCommit], { cwd: repository },
    )
    if (parents.trim().split(/\s+/u).slice(1).join(' ') !== promotionRecord.baseCommit) {
      throw new Error(`Forgeyard promotion commit is not a single child of the Attempt base: ${parents.trim()}`)
    }
    const { stdout: heads } = await execFileAsync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/'], { cwd: repository })
    if (heads.split('\n').filter(Boolean).join(',') !== 'refs/heads/main' || baseHead.trim() === promotionRecord.outputCommit) {
      throw new Error('Forgeyard promotion changed an operator branch instead of its own ref namespace')
    }
    // Exact correspondence, recomputed from the operator's own repository after
    // the Host is gone: the promoted tree holds precisely the declared entries,
    // each at the exact object name Forgeyard recorded for the reviewed bytes.
    const projection = promotionRecord.projection
    if (projection.promoted.previewTruncated || projection.excluded.previewTruncated) {
      throw new Error('the profile smoke fixture unexpectedly exceeded the promotion ledger preview budget')
    }
    const { stdout: listed } = await execFileAsync(
      'git', ['ls-tree', '-r', '-z', '--full-tree', promotionRecord.outputCommit], { cwd: repository },
    )
    const treeEntries = listed.split('\0').filter(Boolean).map((record) => {
      const [meta, path] = record.split('\t')
      const [mode, , oid] = meta.split(' ')
      return { mode, oid, path }
    })
    const declared = [...projection.promoted.preview].sort((left, right) => left.path.localeCompare(right.path))
    const actual = [...treeEntries].sort((left, right) => left.path.localeCompare(right.path))
    if (actual.length !== declared.length
      || declared.some((entry, index) => actual[index].path !== entry.path
        || actual[index].mode !== entry.gitMode || actual[index].oid !== entry.blobOid)) {
      throw new Error(`the promoted tree is not the declared projection: ${JSON.stringify({ declared, actual })}`)
    }
    const { stdout: promotedSource } = await execFileAsync(
      'git', ['cat-file', 'blob', `${promotionRecord.outputCommit}:source.txt`], { cwd: repository },
    )
    if (promotedSource !== 'base\n') {
      throw new Error(`the promoted commit does not carry the reviewed source.txt bytes: ${JSON.stringify(promotedSource)}`)
    }
    decisionOutcome += ` (ref ${promotionRecord.outputRef} at ${promotionRecord.outputCommit.slice(0, 12)})`
  }
  process.stdout.write(`Forgeyard profile smoke passed: DSH Web ${url}, native Session/worktree, ${decisionOutcome}, Host schema ${tables.length}/8.\n`)
} finally {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  await Promise.all([
    rm(dshHome, { recursive: true, force: true }),
    rm(repositoryRoot, { recursive: true, force: true }),
  ])
}
