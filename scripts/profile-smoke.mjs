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
    || emptySnapshot?.schemaVersion !== 2) {
    throw new Error(`Forgeyard initial snapshot is incompatible: ${JSON.stringify(emptySnapshot)}`)
  }
  const mission = await remote('createMission', { request: {
    title: 'Profile smoke mission',
    objective: 'Prove native Session admission from an isolated Forgeyard worktree.',
    repositoryPath: repository,
    baseRef: 'main',
    task: 'Inspect the repository and preserve its behavior.',
    verificationCommand: 'node verify.mjs',
    provider: null,
    model: null,
    reasoningEffort: null,
    agentPreset: null,
    permissionPreset: null,
  } })
  const running = await remote('startAttempt', { taskId: mission.task.id })
  if (running?.attempt?.state !== 'running' || running.attempt.ordinal !== 1
    || typeof running.attempt.dshSessionId !== 'string' || running.attempt.dshSessionId.length === 0
    || running.attempt.worktreePath.startsWith(repository)
    || running.attempt.rawWorkspaceBaselineHash !== running.attempt.rawWorkspaceBaseline?.hash
    || !existsSync(running.attempt.worktreePath)) {
    throw new Error(`Forgeyard did not bind one native isolated Attempt: ${JSON.stringify(running?.attempt)}`)
  }
  const populatedSnapshot = await remote('snapshot', {})
  if (populatedSnapshot.missions?.[0]?.attempts?.[0]?.attempt?.dshSessionId !== running.attempt.dshSessionId) {
    throw new Error('Forgeyard snapshot did not retain the exact native DSH Session association')
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
  const frozenFirst = afterRetry.missions?.[0]?.attempts?.find(item => item.attempt?.id === running.attempt.id)
  if (frozenFirst?.attempt?.state !== 'retried' || frozenFirst?.attempt?.successorAttemptId !== retry.attempt.id
    || frozenFirst.decisions?.[0]?.type !== 'RETRY') {
    throw new Error(`Forgeyard did not retain immutable Attempt 1 Retry authority: ${JSON.stringify(frozenFirst)}`)
  }

  const retryVerified = await verifyWhenIdle(retry.attempt.id)
  let decisionOutcome
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
    decisionOutcome = 'Retry/new Session/worktree and passing Attempt 2 approval'
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
    decisionOutcome = 'Retry/new Session/worktree plus sandbox-unavailable Attempt 2 rejection with approval blocked'
  }

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
  const expected = ['attempts', 'decisions', 'evidence', 'missions', 'schema_migrations', 'tasks', 'verifications']
  if (JSON.stringify(tables) !== JSON.stringify(expected)) {
    throw new Error(`Forgeyard Host schema mismatch: ${JSON.stringify(tables)}`)
  }
  if (schemaVersion !== 2 || counts.missions !== 1 || counts.tasks !== 1 || counts.attempts !== 2) {
    throw new Error(`Forgeyard Host authority mismatch: schema=${String(schemaVersion)} counts=${JSON.stringify(counts)}`)
  }
  if (await readFile(join(repository, 'source.txt'), 'utf8') !== 'base\n') {
    throw new Error('Forgeyard profile smoke changed the base checkout')
  }
  const { stdout: baseStatus } = await execFileAsync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: repository })
  if (baseStatus !== '') throw new Error('Forgeyard profile smoke left the base checkout dirty')
  process.stdout.write(`Forgeyard profile smoke passed: DSH Web ${url}, native Session/worktree, ${decisionOutcome}, Host schema ${tables.length}/7.\n`)
} finally {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
  await Promise.all([
    rm(dshHome, { recursive: true, force: true }),
    rm(repositoryRoot, { recursive: true, force: true }),
  ])
}
