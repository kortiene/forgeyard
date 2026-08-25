import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecutionSnapshot, MissionCreateRequest, ResolvedPolicySnapshot } from '../../packages/forgeyard/src/types.ts'
import { ForgeyardDomainError, ForgeyardEngine } from '../../packages/forgeyard/src/host/engine.ts'
import { TrustedEvidenceCollector } from '../../packages/forgeyard/src/host/evidence.ts'
import type { PolicyOverrides, SessionGateway } from '../../packages/forgeyard/src/host/execution.ts'
import { GitAuthority } from '../../packages/forgeyard/src/host/git.ts'
import { hashRecord, sha256 } from '../../packages/forgeyard/src/host/hash.ts'
import { ForgeyardStore } from '../../packages/forgeyard/src/host/store.ts'
import { makeCanonicalTempDir, run, seedRepository, testRuntime, type TestRuntime } from '../helpers/runtime.ts'

const POLICY: ResolvedPolicySnapshot = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  agentPreset: 'default',
  permissionPreset: 'workspace-write',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'ask',
  toolPolicy: {
    version: 1,
    mode: 'frozen-schema',
    allowedToolNames: ['read', 'write', 'bash'],
    schemaHash: sha256('vertical-slice-tools-v1'),
  },
}

class DeterministicSessionGateway implements SessionGateway {
  readonly admissions: Array<{ sessionId: string; cwd: string; snapshot: ExecutionSnapshot }> = []
  readonly agentClaims: string[] = []
  maintenanceCalls = 0
  sessionExistsCalls = 0
  failNextAdmission = false
  afterNextMaintenance: (() => Promise<void>) | null = null

  async resolvePolicy(_overrides: PolicyOverrides): Promise<ResolvedPolicySnapshot> {
    return structuredClone(POLICY)
  }

  async createAndPrompt(sessionId: string, cwd: string, snapshot: ExecutionSnapshot): Promise<void> {
    if (this.failNextAdmission) {
      this.failNextAdmission = false
      throw new Error('synthetic Session admission failure before publication')
    }
    this.admissions.push({ sessionId, cwd, snapshot: structuredClone(snapshot) })
    // The fake native Session makes a real workspace change. Its claim is never
    // accepted as Evidence; Forgeyard's Host collector runs the verifier itself.
    this.agentClaims.push('All tests pass.')
    await writeFile(join(cwd, 'result.txt'), snapshot.ordinal === 1 ? 'broken\n' : 'fixed\n')
  }

  installPolicyGuards(): void {}

  async assertFrozenExecution(): Promise<void> {}

  async sessionExists(sessionId: string): Promise<boolean> {
    this.sessionExistsCalls += 1
    return this.admissions.some(admission => admission.sessionId === sessionId)
  }

  async runMaintenance<T>(_sessionId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.maintenanceCalls += 1
    const result = await task(new AbortController().signal)
    const queued = this.afterNextMaintenance
    this.afterNextMaintenance = null
    if (queued !== null) await queued()
    return result
  }

  async runTerminalMaintenance<T>(sessionId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.runMaintenance(sessionId, task)
  }
}

describe('Milestone 1: one verified Attempt', () => {
  let root: string
  let runtime: TestRuntime
  let repositoryPath: string
  let databasePath: string
  let store: ForgeyardStore
  let sessions: DeterministicSessionGateway
  let engine: ForgeyardEngine

  beforeEach(async () => {
    root = await makeCanonicalTempDir('forgeyard-vertical-')
    runtime = await testRuntime()
    repositoryPath = await seedRepository(runtime.runner, root)
    databasePath = join(root, 'state', 'forgeyard.sqlite')
    store = new ForgeyardStore(databasePath)
    sessions = new DeterministicSessionGateway()
    const git = new GitAuthority(runtime.runner, {
      allowedRepositoryRoots: [repositoryPath],
      worktreeRoot: join(root, 'worktrees'),
      commandTimeoutMs: 20_000,
      captureBytes: 2 * 1024 * 1024,
      spillBytes: 8 * 1024 * 1024,
      reviewDiffBytes: 256 * 1024,
    })
    const collector = new TrustedEvidenceCollector(runtime.runner, git, {
      commandTimeoutMs: 20_000,
      outputBytes: 256 * 1024,
      spillBytes: 8 * 1024 * 1024,
    }, {
      confine: (attempt, argv) => ({
        argv, mode: 'workspace-write', enforcement: 'full', workspaceRoot: attempt.worktreePath,
      }),
    })
    engine = new ForgeyardEngine(store, git, sessions, collector, { dshVersion: '0.1.1-rc.2' })
  })

  afterEach(async () => {
    try { store.close() } catch { /* A test may close the store to simulate restart. */ }
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  function missionRequest(): MissionCreateRequest {
    return {
      title: 'Fix failing parser test',
      objective: 'Diagnose and fix the parser without unrelated changes.',
      repositoryPath,
      baseRef: 'main',
      task: 'Write the fixed parser result.',
      verificationCommand: 'node verify.mjs',
      provider: null,
      model: null,
      reasoningEffort: null,
      agentPreset: null,
      permissionPreset: null,
    }
  }

  it('blocks a claimed success, binds approval to Evidence, and retries into a new Session and worktree', async () => {
    const mission = await engine.createMission(missionRequest())
    expect(mission.task.sourceNodeKey).toBe('implement')
    expect(mission.mission.pipeHash).toMatch(/^[0-9a-f]{64}$/u)

    const attempt1Running = await engine.startAttempt(mission.task.id)
    expect(attempt1Running.attempt.state).toBe('running')
    expect(sessions.admissions[0]).toMatchObject({
      sessionId: attempt1Running.attempt.dshSessionId,
      cwd: attempt1Running.attempt.worktreePath,
    })
    expect(sessions.admissions[0]?.snapshot.executionSnapshotHash).toBeUndefined()
    expect(sessions.agentClaims).toEqual(['All tests pass.'])

    const attempt1Verified = await engine.verifyAttempt(attempt1Running.attempt.id)
    expect(sessions.maintenanceCalls).toBe(1)
    expect(attempt1Verified.attempt.state).toBe('awaiting_decision')
    expect(attempt1Verified.evidence.map(item => item.kind)).toEqual(['verification-command', 'git'])
    expect(attempt1Verified.verifications).toHaveLength(1)
    expect(attempt1Verified.verifications[0]?.status).toBe('FAIL')
    expect(attempt1Verified.review.canApprove).toBe(false)
    await expect(engine.decide({
      attemptId: attempt1Running.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'The agent said it passed.',
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'VERIFICATION_REQUIRED' })

    const attempt2Running = await engine.retry({
      attemptId: attempt1Running.attempt.id,
      actor: 'operator',
      rationale: 'Trusted verification failed; create an isolated retry.',
    })
    expect(attempt2Running.attempt.ordinal).toBe(2)
    expect(attempt2Running.attempt.id).not.toBe(attempt1Running.attempt.id)
    expect(attempt2Running.attempt.dshSessionId).not.toBe(attempt1Running.attempt.dshSessionId)
    expect(attempt2Running.attempt.worktreePath).not.toBe(attempt1Running.attempt.worktreePath)
    expect(await readFile(join(attempt1Running.attempt.worktreePath, 'result.txt'), 'utf8')).toBe('broken\n')
    expect(await readFile(join(attempt2Running.attempt.worktreePath, 'result.txt'), 'utf8')).toBe('fixed\n')
    const frozenAttempt1 = await engine.attemptView(attempt1Running.attempt.id)
    expect(frozenAttempt1.attempt.state).toBe('retried')
    expect(frozenAttempt1.decisions.map(item => item.type)).toEqual(['RETRY'])

    const attempt2Verified = await engine.verifyAttempt(attempt2Running.attempt.id)
    expect(attempt2Verified.verifications[0]?.status).toBe('PASS')
    expect(attempt2Verified.review.canApprove).toBe(true)
    let expectedDigest = sha256([
      'forgeyard.review.v1',
      attempt2Verified.attempt.executionSnapshotHash,
      attempt2Verified.review.liveGitFingerprint,
      ...attempt2Verified.evidence.map(item => item.hash),
      ...attempt2Verified.verifications.map(item => item.hash),
    ].join('\0'))
    expect(attempt2Verified.review.reviewDigest).toBe(expectedDigest)

    await writeFile(join(attempt2Running.attempt.worktreePath, 'result.txt'), 'changed after evidence\n')
    await expect(engine.decide({
      attemptId: attempt2Running.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'Approve stale state.',
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'REVIEW_STALE' })
    await writeFile(join(attempt2Running.attempt.worktreePath, 'result.txt'), 'fixed\n')

    // Restoring bytes does not restore filesystem metadata. The raw-workspace
    // authority therefore remains stale until a new trusted run is collected.
    const refreshed = await engine.verifyAttempt(attempt2Running.attempt.id)
    expect(refreshed.review.canApprove).toBe(true)
    expectedDigest = refreshed.review.reviewDigest

    const approved = await engine.decide({
      attemptId: attempt2Running.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'All frozen requirements passed against this exact review.',
    })
    expect(approved.attempt.state).toBe('approved')
    expect(approved.decisions[0]?.reviewDigest).toBe(expectedDigest)
    expect(await engine.attemptView(attempt1Running.attempt.id)).toEqual(frozenAttempt1)

    await writeFile(join(attempt2Running.attempt.worktreePath, 'post-approval.txt'), 'new state\n')
    const staleApproval = await engine.attemptView(attempt2Running.attempt.id)
    expect(staleApproval.review.approvalStale).toBe(true)
    expect(staleApproval.review.reviewDigest).not.toBe(staleApproval.decisions[0]?.reviewDigest)

    expect(await readFile(join(repositoryPath, 'source.txt'), 'utf8')).toBe('base\n')
    const baseStatus = await run(runtime.runner, repositoryPath, ['git', 'status', '--porcelain=v2', '-z', '--untracked-files=all'])
    expect(baseStatus.stdout.text).toBe('')

    store.close()
    store = new ForgeyardStore(databasePath)
    const afterRestart = await engineSnapshotWithStore(store, engine)
    expect(afterRestart.missions[0]?.attempts.map(item => item.attempt.state)).toEqual(['retried', 'approved'])
    expect(afterRestart.missions[0]?.attempts[0]).toEqual(frozenAttempt1)
    await access(databasePath)
  })

  it('persists only the v1 authority tables, enforces append-only records, and fails recovery closed', async () => {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
    expect(running.attempt.state).toBe('running')

    const tables = (store.database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual([
      'attempts', 'decisions', 'evidence', 'missions', 'promotions', 'schema_migrations', 'tasks', 'verifications',
    ])
    expect((store.database.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((store.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    expect((store.database.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5_000)

    store.close()
    store = new ForgeyardStore(databasePath)
    const recovered = new ForgeyardEngine(store, engine.git, sessions, engine.collector, { dshVersion: '0.1.1-rc.2' })
    expect(recovered.recoverAfterRestart()).toBe(1)
    expect(store.attempt(running.attempt.id)?.state).toBe('needs_review')
    expect(sessions.admissions).toHaveLength(1)
    expect(store.attemptsForTask(mission.task.id)).toHaveLength(1)

    await recovered.verifyAttempt(running.attempt.id)
    const evidence = store.evidence(running.attempt.id)
    expect(evidence).not.toHaveLength(0)
    expect(() => store.database.prepare('UPDATE evidence SET hash=? WHERE id=?').run('tampered', evidence[0]?.id))
      .toThrow(/append-only/u)
    expect(() => store.database.prepare('DELETE FROM missions WHERE id=?').run(mission.mission.id))
      .toThrow(/immutable/u)
    expect(() => store.database.prepare('UPDATE attempts SET worktree_inode=? WHERE id=?').run('999', running.attempt.id))
      .toThrow(/only be bound once/u)

    const rejected = await recovered.decide({
      attemptId: running.attempt.id,
      type: 'REJECT',
      actor: 'operator',
      rationale: 'Retain this failed Attempt for audit.',
    })
    expect(rejected.attempt.state).toBe('rejected')
    expect(() => store.database.prepare('UPDATE attempts SET terminal_reason=? WHERE id=?').run('tampered', running.attempt.id))
      .toThrow(/completed attempts are immutable/u)
    expect(() => store.database.prepare('DELETE FROM attempts WHERE id=?').run(running.attempt.id))
      .toThrow(/retained for audit/u)
  })

  it('uses the DSH maintenance phase as a mutation fence and stales a digest when queued work resumes', async () => {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
    await writeFile(join(running.attempt.worktreePath, 'result.txt'), 'fixed\n')

    const verified = await engine.verifyAttempt(running.attempt.id)
    expect(verified.verifications[0]?.status).toBe('PASS')
    expect(verified.review.canApprove).toBe(true)
    const authorizedDigest = verified.review.reviewDigest

    sessions.afterNextMaintenance = async () => {
      await writeFile(join(running.attempt.worktreePath, 'result.txt'), 'queued mutation after approval\n')
    }
    const approved = await engine.decide({
      attemptId: running.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'Approve exactly the fenced state.',
    })
    expect(approved.attempt.state).toBe('approved')
    expect(approved.decisions[0]?.reviewDigest).toBe(authorizedDigest)
    expect(approved.review.approvalStale).toBe(true)
    expect(approved.review.canApprove).toBe(false)
    expect(await readFile(join(running.attempt.worktreePath, 'result.txt'), 'utf8'))
      .toBe('queued mutation after approval\n')
  })

  it('selects the latest append-ordered verification run without rewriting prior Evidence', async () => {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
    const failed = await engine.verifyAttempt(running.attempt.id)
    const failedRun = failed.review.latestRunId
    expect(failed.verifications.at(-1)?.status).toBe('FAIL')

    await writeFile(join(running.attempt.worktreePath, 'result.txt'), 'fixed\n')
    const passed = await engine.verifyAttempt(running.attempt.id)
    expect(passed.review.latestRunId).not.toBe(failedRun)
    expect(passed.verifications.map(item => item.status)).toEqual(['FAIL', 'PASS'])
    expect(passed.evidence.map(item => item.runId)).toEqual([
      failedRun,
      failedRun,
      passed.review.latestRunId,
      passed.review.latestRunId,
    ])
    expect(passed.review.passingVerificationCount).toBe(1)
    expect(passed.review.canApprove).toBe(true)
  })

  it('admits the initial Attempt exactly once and requires Retry for every successor', async () => {
    const mission = await engine.createMission(missionRequest())
    const first = await engine.startAttempt(mission.task.id)

    await expect(engine.startAttempt(mission.task.id)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({
      code: 'INVALID_STATE',
    })
    expect(store.attemptsForTask(mission.task.id).map(item => item.id)).toEqual([first.attempt.id])
    expect(sessions.admissions).toHaveLength(1)
  })

  it('leaves the predecessor untouched when Retry preflight cannot prove a clean base', async () => {
    const mission = await engine.createMission(missionRequest())
    const first = await engine.startAttempt(mission.task.id)
    await engine.verifyAttempt(first.attempt.id)
    const predecessor = store.attempt(first.attempt.id)

    await writeFile(join(repositoryPath, 'source.txt'), 'operator dirty state\n')
    await expect(engine.retry({
      attemptId: first.attempt.id,
      actor: 'operator',
      rationale: 'This must not partially terminalize the predecessor.',
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'GIT_ERROR' })

    expect(store.attempt(first.attempt.id)).toEqual(predecessor)
    expect(store.decisions(first.attempt.id)).toEqual([])
    expect(store.attemptsForTask(mission.task.id)).toHaveLength(1)
  })

  it('fails approval closed when an extra append-only record contaminates the latest Evidence set', async () => {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
    await writeFile(join(running.attempt.worktreePath, 'result.txt'), 'fixed\n')
    const verified = await engine.verifyAttempt(running.attempt.id)
    expect(verified.review.canApprove).toBe(true)

    const source = verified.evidence.find(item => item.kind === 'git')
    if (source === undefined) throw new Error('fixture did not collect Git Evidence')
    const createdAt = Date.now()
    const core = {
      attemptId: source.attemptId,
      runId: source.runId,
      kind: source.kind,
      collectorId: source.collectorId,
      collectorVersion: source.collectorVersion,
      payload: source.payload,
      completeness: source.completeness,
      createdAt,
    }
    store.appendEvidence({ id: 'evidence_contaminant', ...core, hash: hashRecord(core) })

    const contaminated = await engine.attemptView(running.attempt.id)
    expect(contaminated.review.canApprove).toBe(false)
    expect(contaminated.review.reason).toMatch(/invalid Git Evidence authority|unbound/u)
    await expect(engine.decide({
      attemptId: running.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'Contaminated evidence must not authorize approval.',
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'REVIEW_STALE' })
  })

  it('collects final Git authority after a passing verifier writes ignored build state', async () => {
    await writeFile(join(repositoryPath, '.gitignore'), '.forgeyard-cache\n')
    await writeFile(join(repositoryPath, 'verify.mjs'), [
      "import { readFile, writeFile } from 'node:fs/promises'",
      "await writeFile(new URL('./.forgeyard-cache', import.meta.url), 'created by verifier\\n')",
      "const value = await readFile(new URL('./result.txt', import.meta.url), 'utf8').catch(() => '')",
      "if (value.trim() !== 'fixed') process.exitCode = 1",
      '',
    ].join('\n'))
    await run(runtime.runner, repositoryPath, ['git', 'add', '--', '.gitignore', 'verify.mjs'])
    await run(runtime.runner, repositoryPath, ['git', 'commit', '-m', 'write verifier cache'])

    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
    await writeFile(join(running.attempt.worktreePath, 'result.txt'), 'fixed\n')
    const verified = await engine.verifyAttempt(running.attempt.id)

    expect(verified.verifications[0]?.status).toBe('PASS')
    expect(await readFile(join(running.attempt.worktreePath, '.forgeyard-cache'), 'utf8')).toBe('created by verifier\n')
    expect(verified.evidence.at(-1)?.kind).toBe('git')
    expect(verified.review.approvalStale).toBe(false)
    expect(verified.review.canApprove).toBe(true)
  })

  it('blocks approval when bounded command Evidence is INCOMPLETE', async () => {
    await writeFile(join(repositoryPath, 'verify.mjs'), "process.stdout.write('x'.repeat(300_000))\n")
    await run(runtime.runner, repositoryPath, ['git', 'add', '--', 'verify.mjs'])
    await run(runtime.runner, repositoryPath, ['git', 'commit', '-m', 'large verifier output'])
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
    const verified = await engine.verifyAttempt(running.attempt.id)

    expect(verified.verifications[0]?.status).toBe('INCOMPLETE')
    expect(verified.evidence.find(item => item.kind === 'verification-command')?.completeness).toBe('INCOMPLETE')
    expect(verified.review.canApprove).toBe(false)
    await expect(engine.decide({
      attemptId: running.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'Incomplete output must never authorize approval.',
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'VERIFICATION_REQUIRED' })
  })

  it('marks review stale when the original base checkout changes after Evidence', async () => {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
    await writeFile(join(running.attempt.worktreePath, 'result.txt'), 'fixed\n')
    const verified = await engine.verifyAttempt(running.attempt.id)
    expect(verified.review.canApprove).toBe(true)

    await writeFile(join(repositoryPath, 'source.txt'), 'base checkout changed externally\n')
    const stale = await engine.attemptView(running.attempt.id)
    expect(stale.review.approvalStale).toBe(true)
    expect(stale.review.canApprove).toBe(false)
    expect(stale.review.reason).toMatch(/original base checkout changed/u)
    await expect(engine.decide({
      attemptId: running.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'A changed base cannot be approved.',
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'REVIEW_STALE' })
  })

  it('validates Decisions before fencing and can cancel a pre-Session stranded Attempt', async () => {
    const mission = await engine.createMission(missionRequest())
    sessions.failNextAdmission = true
    await expect(engine.startAttempt(mission.task.id)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'DSH_ERROR' })
    const stranded = store.attemptsForTask(mission.task.id)[0]
    if (stranded === undefined) throw new Error('stranded Attempt was not retained')
    expect(stranded.state).toBe('needs_review')
    expect(sessions.admissions).toHaveLength(0)

    await expect(engine.decide({
      attemptId: stranded.id,
      type: 'CANCEL',
      actor: 'operator',
      rationale: '',
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'INVALID_REQUEST' })
    expect(sessions.sessionExistsCalls).toBe(0)
    expect(store.decisions(stranded.id)).toEqual([])

    const cancelled = await engine.decide({
      attemptId: stranded.id,
      type: 'CANCEL',
      actor: 'operator',
      rationale: 'Session publication was proven absent; retain and cancel the Attempt.',
    })
    expect(sessions.sessionExistsCalls).toBe(1)
    expect(sessions.maintenanceCalls).toBe(0)
    expect(cancelled.attempt.state).toBe('cancelled')
    expect(cancelled.decisions.map(item => item.type)).toEqual(['CANCEL'])
  })

  it('keeps latest-run selection and the review digest stable across VACUUM', async () => {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
    await writeFile(join(running.attempt.worktreePath, 'result.txt'), 'fixed\n')
    const verified = await engine.verifyAttempt(running.attempt.id)
    const before = verified.review

    store.database.exec('VACUUM')
    const after = await engine.attemptView(running.attempt.id)
    expect(after.review.latestRunId).toBe(before.latestRunId)
    expect(after.review.reviewDigest).toBe(before.reviewDigest)
    expect(after.review.canApprove).toBe(true)
  })
})

async function engineSnapshotWithStore(store: ForgeyardStore, previous: ForgeyardEngine) {
  const restarted = new ForgeyardEngine(store, previous.git, previous.sessions, previous.collector, previous.config)
  return restarted.snapshot()
}
