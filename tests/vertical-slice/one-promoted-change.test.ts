import { chmod, cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AttemptRecord,
  AttemptView,
  DecisionRecord,
  ExecutionSnapshot,
  MissionCreateRequest,
  PromotionRecord,
  ResolvedPolicySnapshot,
} from '../../packages/forgeyard/src/types.ts'
import {
  ForgeyardDomainError,
  ForgeyardEngine,
  PROMOTION_LEASE_MARGIN_MS,
  PROMOTION_POST_INTENT_GIT_COMMANDS,
  type EngineConfig,
} from '../../packages/forgeyard/src/host/engine.ts'
import { TrustedEvidenceCollector } from '../../packages/forgeyard/src/host/evidence.ts'
import type { PolicyOverrides, SessionGateway } from '../../packages/forgeyard/src/host/execution.ts'
import { GitAuthority } from '../../packages/forgeyard/src/host/git.ts'
import type { ProcessRunner } from '../../packages/forgeyard/src/host/process.ts'
import { hashRecord, sha256 } from '../../packages/forgeyard/src/host/hash.ts'
import { PromotionProjector } from '../../packages/forgeyard/src/host/promotion.ts'
import { ForgeyardStore, promotionCore } from '../../packages/forgeyard/src/host/store.ts'
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
    schemaHash: sha256('promotion-slice-tools-v1'),
  },
}

/**
 * A deterministic stand-in for the native DSH Session. Its authored workspace
 * deliberately mixes tracked edits, untracked additions, an executable, an
 * owner-only file, a symlink, ignored verifier state, and an empty directory.
 */
class DeterministicSessionGateway implements SessionGateway {
  readonly admissions: string[] = []
  authored: (cwd: string) => Promise<void> = async (cwd) => {
    await writeFile(join(cwd, 'result.txt'), 'fixed\n')
  }

  async resolvePolicy(_overrides: PolicyOverrides): Promise<ResolvedPolicySnapshot> {
    return structuredClone(POLICY)
  }

  async createAndPrompt(sessionId: string, cwd: string, _snapshot: ExecutionSnapshot): Promise<void> {
    this.admissions.push(sessionId)
    await this.authored(cwd)
  }

  installPolicyGuards(): void {}
  async assertFrozenExecution(): Promise<void> {}
  async sessionExists(sessionId: string): Promise<boolean> {
    return this.admissions.includes(sessionId)
  }

  async runMaintenance<T>(_sessionId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }

  async runTerminalMaintenance<T>(sessionId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.runMaintenance(sessionId, task)
  }
}

describe('Milestone 2: one promoted change', () => {
  let root: string
  let runtime: TestRuntime
  let repositoryPath: string
  let databasePath: string
  let worktreeRoot: string
  let store: ForgeyardStore
  let sessions: DeterministicSessionGateway
  let engine: ForgeyardEngine

  function buildEngine(
    activeStore: ForgeyardStore,
    runner?: ProcessRunner,
    overrides: Partial<EngineConfig> = {},
  ): ForgeyardEngine {
    const git = new GitAuthority(runner ?? runtime.runner, {
      allowedRepositoryRoots: [repositoryPath],
      worktreeRoot,
      commandTimeoutMs: 20_000,
      captureBytes: 2 * 1024 * 1024,
      spillBytes: 8 * 1024 * 1024,
      reviewDiffBytes: 256 * 1024,
    })
    const collector = new TrustedEvidenceCollector(runner ?? runtime.runner, git, {
      commandTimeoutMs: 20_000,
      outputBytes: 256 * 1024,
      spillBytes: 8 * 1024 * 1024,
    }, {
      confine: (attempt, argv) => ({
        argv, mode: 'workspace-write', enforcement: 'full', workspaceRoot: attempt.worktreePath,
      }),
    })
    return new ForgeyardEngine(activeStore, git, sessions, collector, {
      dshVersion: '0.1.1-rc.2',
      // Keep the bounded retry short enough for a test to observe it. The idle
      // poll stays at its default so it never fires under an unrelated test.
      reconcileRetryMs: 250,
      ...overrides,
    })
  }

  beforeEach(async () => {
    root = await makeCanonicalTempDir('forgeyard-promote-')
    runtime = await testRuntime()
    repositoryPath = await seedRepository(runtime.runner, root)
    await writeFile(join(repositoryPath, '.gitignore'), 'build/\n*.log\n')
    await run(runtime.runner, repositoryPath, ['git', 'add', '--', '.gitignore'])
    await run(runtime.runner, repositoryPath, ['git', 'commit', '-m', 'ignore verifier state'])
    databasePath = join(root, 'state', 'forgeyard.sqlite')
    worktreeRoot = join(root, 'worktrees')
    store = new ForgeyardStore(databasePath)
    sessions = new DeterministicSessionGateway()
    engine = buildEngine(store)
  })

  afterEach(async () => {
    engine.dispose()
    try { store.close() } catch { /* A test may close the store to simulate a restart. */ }
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  function missionRequest(): MissionCreateRequest {
    return {
      title: 'Promote one reviewed change',
      objective: 'Deliver exactly the approved workspace and nothing else.',
      repositoryPath,
      baseRef: 'main',
      nodes: [{
        key: 'implement',
        task: 'Write the fixed parser result.',
        verificationCommand: 'node verify.mjs',
        dependsOn: [],
      }],
      provider: null,
      model: null,
      reasoningEffort: null,
      agentPreset: null,
      permissionPreset: null,
    }
  }

  async function approvedAttempt(): Promise<AttemptView> {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.tasks[0].task.id)
    const verified = await engine.verifyAttempt(running.attempt.id)
    expect(verified.verifications[0]?.status).toBe('PASS')
    expect(verified.review.canApprove).toBe(true)
    return engine.decide({
      attemptId: running.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'Trusted verification passed against this exact review.',
    })
  }

  async function promote(attempt: AttemptView, digest?: string): Promise<AttemptView> {
    return engine.promote({
      attemptId: attempt.attempt.id,
      actor: 'operator',
      rationale: 'Promote the approved deliverable into a local Forgeyard ref.',
      expectedReviewDigest: digest ?? (attempt.promotion.reviewDigest as string),
    })
  }

  function errorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  async function gitText(cwd: string, argv: readonly string[]): Promise<string> {
    return (await run(runtime.runner, cwd, argv)).stdout.text.trim()
  }

  async function baseCheckoutState(): Promise<{ head: string; status: string; branches: string }> {
    return {
      head: await gitText(repositoryPath, ['git', 'rev-parse', 'HEAD']),
      status: await gitText(repositoryPath, ['git', 'status', '--porcelain=v2', '-z', '--untracked-files=all']),
      branches: await gitText(repositoryPath, ['git', 'for-each-ref', '--format=%(refname)', 'refs/heads/']),
    }
  }

  /**
   * Reproduce the durable state a Host interrupted mid-promotion leaves behind.
   * An interrupted Host's lease has expired by the time anything reconciles it;
   * `lease: 'live'` instead reproduces a promotion still in flight in a Host
   * that is between its recorded intent and `git update-ref` right now.
   */
  async function pendingPromotion(
    attempt: AttemptRecord,
    decision: DecisionRecord,
    outputCommit: string,
    lease: 'expired' | 'live' = 'expired',
    liveForMs = 3_600_000,
  ): Promise<PromotionRecord> {
    const repository = await engine.git.canonicalize(repositoryPath)
    const prepared = {
      path: attempt.worktreePath,
      repository,
      baseCommit: attempt.baseCommit,
      device: BigInt(attempt.worktreeDevice as string),
      inode: BigInt(attempt.worktreeInode as string),
      baselineManifest: attempt.rawWorkspaceBaseline as NonNullable<AttemptRecord['rawWorkspaceBaseline']>,
    }
    const view = await engine.git.promotionView(prepared)
    const projection = (await new PromotionProjector({ previewBytes: 65_536, spillBytes: 8 * 1024 * 1024 })
      .project(prepared.path, view)).projection
    const core = {
      attemptId: attempt.id,
      decisionId: decision.id,
      reviewDigest: decision.reviewDigest,
      executionSnapshotHash: attempt.executionSnapshotHash,
      baseCommit: attempt.baseCommit,
      worktreeHead: view.headCommit,
      evidenceDigest: sha256('interrupted-evidence'),
      verificationDigest: sha256('interrupted-verification'),
      projectionHash: projection.hash,
      objectFormat: view.objectFormat,
      outputRef: GitAuthority.promotionRef(attempt.id),
      outputCommit,
      outputTree: await engine.git.readCommitTree(prepared, outputCommit),
      actor: 'operator',
      rationale: 'A promotion interrupted before it settled.',
      createdAt: Date.now() - 3_600_000,
    }
    const record: PromotionRecord = {
      id: 'promotion_interrupted',
      ...core,
      projection,
      status: 'pending',
      failureReason: null,
      hash: hashRecord(promotionCore({ ...core, projection } as PromotionRecord)),
      leaseExpiresAt: lease === 'live' ? Date.now() + liveForMs : core.createdAt + 1_000,
      settledAt: null,
    }
    store.insertPendingPromotion(record)
    return record
  }

  it('blocks a follow-up whose upstream promotion could not be re-verified, and never recommends an impossible Retry', async () => {
    const mission = await engine.createMission({
      ...missionRequest(),
      title: 'Unconfirmed upstream output',
      nodes: [
        { key: 'A', task: 'Implement A.', verificationCommand: 'node verify.mjs', dependsOn: [] },
        { key: 'B', task: 'Implement B on top of A.', verificationCommand: 'node verify.mjs', dependsOn: ['A'] },
      ],
    })
    const taskA = mission.tasks[0]?.task
    const taskB = mission.tasks[1]?.task
    if (taskA === undefined || taskB === undefined) throw new Error('serial Mission did not materialize both Tasks')

    const runningA = await engine.startAttempt(taskA.id)
    await engine.verifyAttempt(runningA.attempt.id)
    const approvedA = await engine.decide({
      attemptId: runningA.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'Trusted verification passed against this exact review.',
    })
    const promotedA = await promote(approvedA)
    expect(promotedA.promotion.status).toBe('promoted')
    const readyView = await engine.missionView(mission.mission.id)
    expect(readyView.tasks[1]?.readiness).toMatchObject({ status: 'ready', startable: true })

    // Make the repository unreadable so re-verifying the ref fails with an
    // ordinary Git error. That is deliberately NOT divergence: the record
    // stands and says the output could not be confirmed. A dependency must not
    // freeze a commit whose authoritative ref was never confirmed, because a
    // raw commit OID resolves even when the ref that named it is gone.
    await chmod(repositoryPath, 0o000)
    try {
      const unconfirmedView = await engine.missionView(mission.mission.id)
      const upstreamPanel = unconfirmedView.tasks[0]?.attempts.at(-1)?.promotion
      expect(upstreamPanel?.status).toBe('promoted')
      expect(upstreamPanel?.reason).toContain('could not be confirmed')
      const downstream = unconfirmedView.tasks[1]?.readiness
      expect(downstream).toMatchObject({
        status: 'blocked', startable: false, blockedBy: ['A'], baseCommit: null, baseFromAttemptId: null,
      })
      expect(downstream?.reason).toContain('could not be re-verified')
      await expect(engine.startAttempt(taskB.id)).rejects.toThrow(/could not be re-verified/u)
    } finally {
      await chmod(repositoryPath, 0o755)
    }

    // Readable again: the ref re-verifies and B becomes startable once more.
    const recoveredView = await engine.missionView(mission.mission.id)
    expect(recoveredView.tasks[1]?.readiness).toMatchObject({ status: 'ready', startable: true })
  })

  it('words a satisfied terminal follow-up\'s readiness for its actual state instead of recommending Retry', async () => {
    const mission = await engine.createMission({
      ...missionRequest(),
      title: 'Terminal downstream wording',
      nodes: [
        { key: 'A', task: 'Implement A.', verificationCommand: 'node verify.mjs', dependsOn: [] },
        { key: 'B', task: 'Implement B on top of A.', verificationCommand: 'node verify.mjs', dependsOn: ['A'] },
      ],
    })
    const taskA = mission.tasks[0]?.task
    const taskB = mission.tasks[1]?.task
    if (taskA === undefined || taskB === undefined) throw new Error('serial Mission did not materialize both Tasks')

    const runningA = await engine.startAttempt(taskA.id)
    await engine.verifyAttempt(runningA.attempt.id)
    const approvedA = await engine.decide({
      attemptId: runningA.attempt.id, type: 'APPROVE', actor: 'operator',
      rationale: 'Trusted verification passed against this exact review.',
    })
    const promotedA = await promote(approvedA)
    const outputCommit = promotedA.promotion.outputCommit as string

    const runningB = await engine.startAttempt(taskB.id)
    expect(runningB.attempt.baseCommit).toBe(outputCommit)
    await engine.verifyAttempt(runningB.attempt.id)
    await engine.decide({
      attemptId: runningB.attempt.id, type: 'APPROVE', actor: 'operator',
      rationale: 'The follow-up passed its own verification.',
    })

    const view = await engine.missionView(mission.mission.id)
    const downstream = view.tasks[1]?.readiness
    expect(downstream).toMatchObject({ status: 'ready', startable: false, baseCommit: outputCommit })
    // An approved Attempt is not retryable, so the rendered reason must not
    // tell the operator to use Retry.
    expect(downstream?.reason).not.toMatch(/Retry/u)
    expect(downstream?.reason).toContain('approved')
    expect(view.derivedState).toBe('complete')

    // Criterion 11's second half: promotion governs what Forgeyard requires,
    // not what it permits. A terminal node need not be promoted, but promoting
    // it stays available and succeeds when the operator chooses it.
    const approvedB = await engine.attemptView(runningB.attempt.id)
    expect(approvedB.promotion).toMatchObject({ status: 'eligible', eligible: true })
    const promotedB = await promote(approvedB)
    expect(promotedB.promotion).toMatchObject({ status: 'promoted' })
    expect(promotedB.promotion.outputCommit).toMatch(/^[0-9a-f]{40,64}$/u)
    // B's promoted commit descends from A's, so the chain is real end to end.
    expect(
      await gitText(repositoryPath, ['git', 'merge-base', '--is-ancestor', outputCommit, promotedB.promotion.outputCommit as string]),
    ).toBeDefined()
    const afterTerminalPromotion = await engine.missionView(mission.mission.id)
    expect(afterTerminalPromotion.tasks[1]?.attempts.at(-1)?.promotion.status).toBe('promoted')
    expect(afterTerminalPromotion.derivedState).toBe('complete')
  })

  it('surfaces why an approved upstream still cannot be promoted instead of a generic instruction', async () => {
    const mission = await engine.createMission({
      ...missionRequest(),
      title: 'Stale approved upstream',
      nodes: [
        { key: 'A', task: 'Implement A.', verificationCommand: 'node verify.mjs', dependsOn: [] },
        { key: 'B', task: 'Implement B on top of A.', verificationCommand: 'node verify.mjs', dependsOn: ['A'] },
      ],
    })
    const taskA = mission.tasks[0]?.task
    const taskB = mission.tasks[1]?.task
    if (taskA === undefined || taskB === undefined) throw new Error('serial Mission did not materialize both Tasks')

    const runningA = await engine.startAttempt(taskA.id)
    await engine.verifyAttempt(runningA.attempt.id)
    await engine.decide({
      attemptId: runningA.attempt.id, type: 'APPROVE', actor: 'operator',
      rationale: 'Trusted verification passed against this exact review.',
    })

    // A drifts after approval: the review digest no longer matches, so
    // promotion is blocked with the stale-review reason. B must surface that
    // exact reason rather than advise a promotion that would fail — and an
    // approved Attempt cannot be retried to reach another state.
    await writeFile(join(runningA.attempt.worktreePath, 'post-approval.txt'), 'drift\n')
    const view = await engine.missionView(mission.mission.id)
    const upstreamPanel = view.tasks[0]?.attempts.at(-1)?.promotion
    expect(upstreamPanel?.status).toBe('blocked')
    expect(upstreamPanel?.reason).toMatch(/no longer (?:current|matches)|stale/u)
    const downstream = view.tasks[1]?.readiness
    expect(downstream).toMatchObject({ status: 'blocked', startable: false })
    expect(downstream?.reason).toContain('cannot be promoted')
    expect(downstream?.reason).not.toContain('promote it first')
  })

  it('admits a serial follow-up only on the re-verified promoted upstream commit, and re-blocks it when that output diverges', async () => {
    const mission = await engine.createMission({
      ...missionRequest(),
      title: 'Serial promoted chain',
      nodes: [
        { key: 'A', task: 'Implement A.', verificationCommand: 'node verify.mjs', dependsOn: [] },
        { key: 'B', task: 'Implement B on top of A.', verificationCommand: 'node verify.mjs', dependsOn: ['A'] },
      ],
    })
    const taskA = mission.tasks[0]?.task
    const taskB = mission.tasks[1]?.task
    if (taskA === undefined || taskB === undefined) throw new Error('serial Mission did not materialize both Tasks')

    // Before A runs, B is blocked on it and admission refuses.
    expect(mission.tasks[1]?.readiness).toMatchObject({
      status: 'blocked', startable: false, blockedBy: ['A'], baseCommit: null, baseFromAttemptId: null,
    })
    await expect(engine.startAttempt(taskB.id)).rejects.toThrow(/Node A has not run yet/u)

    // A runs, verifies, and is approved — but not yet promoted.
    const runningA = await engine.startAttempt(taskA.id)
    const verifiedA = await engine.verifyAttempt(runningA.attempt.id)
    expect(verifiedA.review.canApprove).toBe(true)
    const approvedA = await engine.decide({
      attemptId: runningA.attempt.id,
      type: 'APPROVE',
      actor: 'operator',
      rationale: 'Trusted verification passed against this exact review.',
    })
    const approvedView = await engine.missionView(mission.mission.id)
    expect(approvedView.tasks[1]?.readiness).toMatchObject({ status: 'blocked', startable: false })
    expect(approvedView.tasks[1]?.readiness.reason).toContain('approved but its output has not been promoted yet')
    await expect(engine.startAttempt(taskB.id)).rejects.toThrow(/has not been promoted yet/u)

    // Promotion satisfies the dependency and names the exact base.
    const promotedA = await promote(approvedA)
    const outputCommit = promotedA.promotion.outputCommit as string
    expect(outputCommit).toMatch(/^[0-9a-f]{40,64}$/u)
    const readyView = await engine.missionView(mission.mission.id)
    expect(readyView.tasks[1]?.readiness).toEqual({
      status: 'ready',
      startable: true,
      reason: null,
      blockedBy: [],
      baseCommit: outputCommit,
      baseFromAttemptId: runningA.attempt.id,
    })
    expect(readyView.derivedState).toBe('ready')

    // B is admitted on exactly that commit, in its own Session and worktree.
    const runningB = await engine.startAttempt(taskB.id)
    expect(runningB.attempt.executionSnapshot.baseCommit).toBe(outputCommit)
    expect(runningB.attempt.baseCommit).toBe(outputCommit)
    expect(runningB.attempt.dshSessionId).not.toBe(runningA.attempt.dshSessionId)
    expect(runningB.attempt.worktreePath).not.toBe(runningA.attempt.worktreePath)
    expect(await gitText(runningB.attempt.worktreePath, ['git', 'rev-parse', 'HEAD'])).toBe(outputCommit)
    // The chain is real: A's commit descends from the Mission base, B from A.
    const baseCommit = mission.mission.repository.checkoutHead
    expect(await gitText(runningB.attempt.worktreePath, ['git', 'merge-base', '--is-ancestor', baseCommit, outputCommit]) ?? '').toBeDefined()
    await expect(engine.startAttempt(taskB.id)).rejects.toThrow(/first Attempt already exists/u)

    // Criterion 4: an upstream output that no longer holds re-blocks B.
    const outputRef = promotedA.promotion.outputRef as string
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', '-d', outputRef])
    const divergedView = await engine.missionView(mission.mission.id)
    expect(divergedView.tasks[1]?.readiness).toMatchObject({
      status: 'blocked', startable: false, blockedBy: ['A'], baseCommit: null, baseFromAttemptId: null,
    })
    expect(divergedView.tasks[1]?.readiness.reason).toContain('no longer exists')
    expect(divergedView.tasks[1]?.readiness.reason).toContain(outputRef)
    // B's own Attempt stays admitted and immutable on its frozen base.
    const stillB = await engine.attemptView(runningB.attempt.id)
    expect(stillB.attempt.baseCommit).toBe(outputCommit)
    // A Retry successor is also planned through the dependency resolution, so a
    // diverged upstream must block it too — B is moved to a retryable state first.
    const verifiedB = await engine.verifyAttempt(runningB.attempt.id)
    expect(verifiedB.attempt.state).toBe('awaiting_decision')
    await expect(engine.retry({
      attemptId: runningB.attempt.id,
      actor: 'operator',
      rationale: 'Retry must still resolve a re-verified upstream base.',
    })).rejects.toThrow(/no longer exists/u)
  })

  it('reports a rejected upstream as terminal dead readiness and refuses follow-up admission with the same text', async () => {
    const mission = await engine.createMission({
      ...missionRequest(),
      title: 'Rejected upstream',
      nodes: [
        { key: 'A', task: 'Implement A.', verificationCommand: 'node verify.mjs', dependsOn: [] },
        { key: 'B', task: 'Implement B on top of A.', verificationCommand: 'node verify.mjs', dependsOn: ['A'] },
      ],
    })
    const taskA = mission.tasks[0]?.task
    const taskB = mission.tasks[1]?.task
    if (taskA === undefined || taskB === undefined) throw new Error('serial Mission did not materialize both Tasks')

    const runningA = await engine.startAttempt(taskA.id)
    await engine.verifyAttempt(runningA.attempt.id)
    const rejectedA = await engine.decide({
      attemptId: runningA.attempt.id,
      type: 'REJECT',
      actor: 'operator',
      rationale: 'This line of work is finished.',
    })
    expect(rejectedA.attempt.state).toBe('rejected')

    // Criterion 9: the dependency reports the terminal `dead` state with the
    // honest remedy — a new Mission, never a Retry — and the rollup surfaces
    // the dead branch over A's own terminal rejection.
    const view = await engine.missionView(mission.mission.id)
    expect(view.tasks[1]?.readiness).toMatchObject({
      status: 'dead', startable: false, blockedBy: ['A'], baseCommit: null, baseFromAttemptId: null,
    })
    expect(view.tasks[1]?.readiness.reason).toContain('Node A was rejected, which is terminal for that Task')
    expect(view.tasks[1]?.readiness.reason).toContain('create a new Mission')
    expect(view.derivedState).toBe('dead')

    // Admission refuses with exactly the readiness reason — the same-text
    // guarantee, asserted end to end on the dead path.
    const admission = await engine.startAttempt(taskB.id).then(
      () => { throw new Error('downstream admission unexpectedly succeeded') },
      error => error as ForgeyardDomainError,
    )
    expect(admission.message).toBe(view.tasks[1]?.readiness.reason)

    // And no back door exists on the upstream: a rejected Attempt is not
    // retryable, so the remedy the reason names is the only real one.
    await expect(engine.retry({
      attemptId: runningA.attempt.id,
      actor: 'operator',
      rationale: 'A rejected Attempt must not be retryable.',
    })).rejects.toThrow(/Retry requires the latest nonterminal reviewable Attempt/u)
  })

  it('promotes exactly the approved deliverable into a durable local ref and leaves the checkout untouched', async () => {
    sessions.authored = async (cwd) => {
      await writeFile(join(cwd, 'result.txt'), 'fixed\n')
      await writeFile(join(cwd, 'source.txt'), 'promoted content\n')
      await writeFile(join(cwd, 'run.sh'), '#!/bin/sh\necho ok\n')
      await chmod(join(cwd, 'run.sh'), 0o755)
      await symlink('result.txt', join(cwd, 'latest.txt'))
      await writeFile(join(cwd, 'debug.log'), 'ignored noise\n')
      await mkdir(join(cwd, 'build'))
      await writeFile(join(cwd, 'build', 'artifact.txt'), 'ignored output\n')
      await mkdir(join(cwd, 'empty-dir'))
    }
    const before = await baseCheckoutState()
    const approved = await approvedAttempt()
    expect(approved.attempt.state).toBe('approved')
    expect(approved.promotions).toEqual([])
    expect(approved.promotion).toMatchObject({
      status: 'eligible',
      eligible: true,
      reviewDigest: approved.decisions[0]?.reviewDigest,
      decisionId: approved.decisions[0]?.id,
      outputCommit: null,
      plannedRef: `refs/forgeyard/promotions/${approved.attempt.id}`,
    })

    const promoted = await promote(approved)
    expect(promoted.promotions).toHaveLength(1)
    const record = promoted.promotions[0] as PromotionRecord
    expect(record).toMatchObject({
      status: 'promoted',
      attemptId: approved.attempt.id,
      decisionId: approved.decisions[0]?.id,
      reviewDigest: approved.decisions[0]?.reviewDigest,
      executionSnapshotHash: approved.attempt.executionSnapshotHash,
      baseCommit: approved.attempt.baseCommit,
      objectFormat: 'sha1',
      failureReason: null,
    })
    expect(record.settledAt).not.toBeNull()
    expect(record.evidenceDigest).toBe(sha256(promoted.evidence.map(item => item.hash).join('\0')))
    expect(record.verificationDigest).toBe(sha256(promoted.verifications.map(item => item.hash).join('\0')))
    expect(promoted.promotion).toMatchObject({
      status: 'promoted',
      eligible: false,
      outputRef: record.outputRef,
      outputCommit: record.outputCommit,
    })

    // The durable output is a real, inspectable commit in the operator's repository.
    expect(await gitText(repositoryPath, ['git', 'rev-parse', '--verify', `${record.outputRef}^{commit}`]))
      .toBe(record.outputCommit)
    expect(await gitText(repositoryPath, ['git', 'rev-parse', `${record.outputCommit}^{tree}`])).toBe(record.outputTree)
    expect(await gitText(repositoryPath, ['git', 'rev-list', '--parents', '-n', '1', record.outputCommit]))
      .toBe(`${record.outputCommit} ${record.baseCommit}`)
    const message = await gitText(repositoryPath, ['git', 'log', '-1', '--format=%B', record.outputCommit])
    expect(message).toContain(`Forgeyard-Attempt: ${approved.attempt.id}`)
    expect(message).toContain(`Forgeyard-Review-Digest: ${record.reviewDigest}`)
    expect(message).toContain(`Forgeyard-Projection-Hash: ${record.projectionHash}`)
    expect(await gitText(repositoryPath, ['git', 'log', '-1', '--format=%an <%ae>', record.outputCommit]))
      .toBe('Forgeyard <forgeyard@promotion.invalid>')

    // The tree is exactly the declared projection, byte for byte.
    const promotedPaths = (await gitText(repositoryPath, ['git', 'ls-tree', '-r', '--name-only', record.outputCommit]))
      .split('\n').filter(Boolean)
    expect(promotedPaths).toEqual(['.gitignore', 'latest.txt', 'result.txt', 'run.sh', 'source.txt', 'verify.mjs'])
    for (const path of promotedPaths) {
      const blob = await gitText(repositoryPath, ['git', 'cat-file', 'blob', `${record.outputCommit}:${path}`])
      const expected = path === 'latest.txt'
        ? 'result.txt'
        : (await readFile(join(approved.attempt.worktreePath, path), 'utf8'))
      expect(blob).toBe(expected.trimEnd())
    }
    const modes = await gitText(repositoryPath, ['git', 'ls-tree', '-r', record.outputCommit])
    expect(modes).toContain('100755 blob')
    expect(modes).toContain('120000 blob')

    // Everything Git cannot carry is enumerated, never silently dropped.
    const excluded = new Map(record.projection.excluded.preview.map(entry => [entry.path, entry.reason] as const))
    expect(excluded.get('debug.log')).toBe('ignored')
    expect(excluded.get('build/artifact.txt')).toBe('ignored')
    expect(excluded.get('build')).toBe('directory-dropped')
    expect(excluded.get('empty-dir')).toBe('directory-dropped')
    expect(excluded.get('.git')).toBe('git-admin')
    expect(record.projection.promoted.count + record.projection.excluded.count)
      .toBe(record.projection.manifestEntryCount)

    // The original operator checkout is untouched and still clean.
    expect(await baseCheckoutState()).toEqual(before)
    expect(await readFile(join(repositoryPath, 'source.txt'), 'utf8')).toBe('base\n')
    // The reviewed Attempt worktree is unchanged, so its review stays current.
    const afterView = await engine.attemptView(approved.attempt.id)
    expect(afterView.review.approvalStale).toBe(false)
    expect(afterView.review.reviewDigest).toBe(record.reviewDigest)
  })

  it('refuses a review digest the operator did not confirm', async () => {
    const approved = await approvedAttempt()
    await expect(promote(approved, '0'.repeat(64)))
      .rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
    await expect(promote(approved, 'not-a-digest'))
      .rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'INVALID_REQUEST' })
    await expect(engine.promote({
      attemptId: approved.attempt.id,
      actor: '',
      rationale: 'missing actor',
      expectedReviewDigest: approved.promotion.reviewDigest as string,
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'INVALID_REQUEST' })
    expect(store.promotions(approved.attempt.id)).toEqual([])
    expect(await engine.git.readPromotionRef(repositoryPath, GitAuthority.promotionRef(approved.attempt.id))).toBeNull()
  })

  it('fails closed when the reviewed worktree changed after approval', async () => {
    const approved = await approvedAttempt()
    const digest = approved.promotion.reviewDigest as string
    await writeFile(join(approved.attempt.worktreePath, 'result.txt'), 'edited after approval\n')

    const stale = await engine.attemptView(approved.attempt.id)
    expect(stale.review.reviewedStateCurrent).toBe(false)
    expect(stale.promotion.eligible).toBe(false)
    expect(stale.promotion.status).toBe('blocked')
    await expect(promote(approved, digest))
      .rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
    expect(store.promotions(approved.attempt.id)).toEqual([])
    expect(await engine.git.readPromotionRef(repositoryPath, GitAuthority.promotionRef(approved.attempt.id))).toBeNull()
  })

  it('fails closed when the original base checkout changed after approval', async () => {
    const approved = await approvedAttempt()
    const digest = approved.promotion.reviewDigest as string
    await writeFile(join(repositoryPath, 'source.txt'), 'operator changed the base\n')

    const stale = await engine.attemptView(approved.attempt.id)
    expect(stale.promotion.reason).toMatch(/original base checkout changed/u)
    await expect(promote(approved, digest))
      .rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
    expect(store.promotions(approved.attempt.id)).toEqual([])
  })

  it('refuses every non-approved Attempt outcome', async () => {
    const mission = await engine.createMission(missionRequest())
    sessions.authored = async (cwd) => { await writeFile(join(cwd, 'result.txt'), 'broken\n') }
    const failing = await engine.startAttempt(mission.tasks[0].task.id)
    const failed = await engine.verifyAttempt(failing.attempt.id)
    expect(failed.verifications[0]?.status).toBe('FAIL')
    expect(failed.promotion).toMatchObject({ status: 'blocked', eligible: false, reviewDigest: null })
    await expect(engine.promote({
      attemptId: failing.attempt.id,
      actor: 'operator',
      rationale: 'A failing Attempt must never be promotable.',
      expectedReviewDigest: failed.review.reviewDigest,
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })

    // RETRY seals the predecessor; neither the retried nor rejected Attempt is promotable.
    const retried = await engine.retry({
      attemptId: failing.attempt.id,
      actor: 'operator',
      rationale: 'Retry into an isolated successor.',
    })
    const sealed = await engine.attemptView(failing.attempt.id)
    expect(sealed.attempt.state).toBe('retried')
    expect(sealed.promotion.reason).toMatch(/terminal APPROVE Decision can be promoted; this Attempt is retried/u)

    await engine.verifyAttempt(retried.attempt.id)
    const rejected = await engine.decide({
      attemptId: retried.attempt.id,
      type: 'REJECT',
      actor: 'operator',
      rationale: 'Reject the successor.',
    })
    expect(rejected.promotion.reason).toMatch(/this Attempt is rejected/u)
    for (const attemptId of [failing.attempt.id, retried.attempt.id]) {
      await expect(engine.promote({
        attemptId,
        actor: 'operator',
        rationale: 'Terminal non-approval must never deliver anything.',
        expectedReviewDigest: sha256('any'),
      })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
      expect(store.promotions(attemptId)).toEqual([])
    }
  })

  it('refuses a cancelled Attempt and a recovery-uncertain Attempt', async () => {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.tasks[0].task.id)
    const cancelled = await engine.decide({
      attemptId: running.attempt.id,
      type: 'CANCEL',
      actor: 'operator',
      rationale: 'Cancel before review.',
    })
    expect(cancelled.promotion.reason).toMatch(/this Attempt is cancelled/u)

    // A Host restart during an external operation makes the Attempt uncertain.
    const second = await engine.createMission({ ...missionRequest(), title: 'Second mission' })
    const uncertain = await engine.startAttempt(second.tasks[0].task.id)
    store.close()
    store = new ForgeyardStore(databasePath)
    engine = buildEngine(store)
    expect(engine.recoverAfterRestart()).toBe(1)
    const recovered = await engine.attemptView(uncertain.attempt.id)
    expect(recovered.attempt.state).toBe('needs_review')
    expect(recovered.promotion.reason).toMatch(/this Attempt is needs_review/u)
    await expect(engine.promote({
      attemptId: uncertain.attempt.id,
      actor: 'operator',
      rationale: 'A recovery-uncertain Attempt must never deliver anything.',
      expectedReviewDigest: recovered.review.reviewDigest,
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
  })

  it('rejects a repeated promotion with a stable explanation and leaves the output unchanged', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({
        code: 'PROMOTION_BLOCKED',
        message: `This Attempt was already promoted to ${record.outputRef} at ${record.outputCommit}.`,
      })
    }
    expect(store.promotions(approved.attempt.id)).toEqual([record])
    expect(await engine.git.readPromotionRef(repositoryPath, record.outputRef)).toBe(record.outputCommit)
  })

  it('fails closed on a colliding Forgeyard ref and never overwrites it', async () => {
    const approved = await approvedAttempt()
    const ref = GitAuthority.promotionRef(approved.attempt.id)
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', ref, approved.attempt.baseCommit])

    await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'GIT_ERROR' })
    const failed = store.promotions(approved.attempt.id)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ status: 'failed' })
    expect(failed[0]?.failureReason).toMatch(/promotion ref was not created/u)
    expect(await engine.git.readPromotionRef(repositoryPath, ref)).toBe(approved.attempt.baseCommit)

    // A failed promotion releases the Attempt so an explicit retry is possible.
    const view = await engine.attemptView(approved.attempt.id)
    expect(view.promotion).toMatchObject({ status: 'eligible', eligible: true })
    expect(view.promotion.failureReason).toMatch(/promotion ref was not created/u)
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', '-d', ref])
    const promoted = await promote(view)
    expect(promoted.promotions.map(item => item.status)).toEqual(['failed', 'promoted'])

    // The promoted objects are a deterministic function of the reviewed state
    // and the immutable Forgeyard records, so the retry names the same commit
    // the blocked attempt had already computed.
    const [blocked, delivered] = promoted.promotions as [PromotionRecord, PromotionRecord]
    expect(delivered.outputCommit).toBe(blocked.outputCommit)
    expect(delivered.outputTree).toBe(blocked.outputTree)
    expect(delivered.projectionHash).toBe(blocked.projectionHash)
    expect(await engine.git.readPromotionRef(repositoryPath, ref)).toBe(delivered.outputCommit)
  })

  it('serializes concurrent promotions so exactly one durable output exists', async () => {
    const approved = await approvedAttempt()
    const digest = approved.promotion.reviewDigest as string
    const request = {
      attemptId: approved.attempt.id,
      actor: 'operator',
      rationale: 'Two operators press promote at the same moment.',
      expectedReviewDigest: digest,
    }
    const results = await Promise.allSettled([engine.promote(request), engine.promote(request)])
    expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find(item => item.status === 'rejected') as PromiseRejectedResult
    expect(rejection.reason).toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
    const settled = store.promotions(approved.attempt.id)
    expect(settled.filter(item => item.status === 'promoted')).toHaveLength(1)
  })

  it('lets a second Host process lose the promotion race without a second durable output', async () => {
    const approved = await approvedAttempt()
    const digest = approved.promotion.reviewDigest as string
    const secondStore = new ForgeyardStore(databasePath)
    try {
      const secondEngine = buildEngine(secondStore)
      const request = {
        attemptId: approved.attempt.id,
        actor: 'operator',
        rationale: 'Two Forgeyard Hosts share one SQLite authority.',
        expectedReviewDigest: digest,
      }
      const results = await Promise.allSettled([engine.promote(request), secondEngine.promote(request)])
      expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      const promotions = store.promotions(approved.attempt.id)
      expect(promotions.filter(item => item.status === 'promoted')).toHaveLength(1)
      const promoted = promotions.find(item => item.status === 'promoted') as PromotionRecord
      expect(await engine.git.readPromotionRef(repositoryPath, promoted.outputRef)).toBe(promoted.outputCommit)
    } finally {
      secondStore.close()
    }
  })

  it('reconciles a promotion interrupted before its ref, then allows an explicit retry', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)
    expect(store.promotion(record.id)?.status).toBe('pending')

    const uncertain = await engine.attemptView(approved.attempt.id)
    expect(uncertain.promotion).toMatchObject({ status: 'uncertain', eligible: false })

    store.close()
    store = new ForgeyardStore(databasePath)
    engine = buildEngine(store)
    expect(await engine.reconcilePromotions()).toBe(1)
    expect(store.promotion(record.id)).toMatchObject({ status: 'failed' })
    expect(store.promotion(record.id)?.failureReason)
      .toMatch(/interrupted before this promotion created its Git ref/u)

    const view = await engine.attemptView(approved.attempt.id)
    expect(view.promotion).toMatchObject({ status: 'eligible', eligible: true })
    const promoted = await promote(view)
    expect(promoted.promotions.map(item => item.status)).toEqual(['failed', 'promoted'])
  })

  it('reports a completed promotion whose ref was deleted or moved outside Forgeyard', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord
    expect(promoted.promotion).toMatchObject({ status: 'promoted', eligible: false })

    // Anyone with write access can delete a `refs/forgeyard/` ref outside
    // Forgeyard. The SQLite record and the ref are two independent facts.
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', '-d', record.outputRef])
    const deleted = await engine.attemptView(approved.attempt.id)
    expect(deleted.promotion).toMatchObject({ status: 'diverged', eligible: false })
    expect(deleted.promotion.reason).toMatch(/no longer exists/u)
    // The disagreement is reported, never resolved: Forgeyard does not recreate
    // the ref, and the completed record still blocks a second promotion.
    await expect(promote(deleted)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
    expect(await engine.git.readPromotionRef(repositoryPath, record.outputRef)).toBeNull()
    expect(store.promotion(record.id)).toMatchObject({ status: 'promoted', failureReason: null })

    // A ref moved to some other object is reported the same way, naming both.
    const head = await gitText(repositoryPath, ['git', 'rev-parse', 'HEAD'])
    const foreign = await gitText(repositoryPath, [
      'git', 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'unrelated local commit',
    ])
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', record.outputRef, foreign])
    const moved = await engine.attemptView(approved.attempt.id)
    expect(moved.promotion).toMatchObject({ status: 'diverged', eligible: false })
    expect(moved.promotion.reason).toContain(foreign)
    expect(moved.promotion.reason).toContain(record.outputCommit)

    // Restoring the exact promoted commit restores the agreement.
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', record.outputRef, record.outputCommit])
    expect(await engine.attemptView(approved.attempt.id)).toMatchObject({
      promotion: { status: 'promoted', outputCommit: record.outputCommit },
    })
  })

  it('gives each concurrent promotion of one Attempt its own scratch files', async () => {
    const approved = await approvedAttempt()
    let gated = false
    let enteredAdd = (): void => {}
    let releaseAdd = (): void => {}
    const atAdd = new Promise<void>((resolve) => { enteredAdd = resolve })
    const held = new Promise<void>((resolve) => { releaseAdd = resolve })
    // Hold this Host inside `git add`, after it has written its pathspec file
    // and while it still needs to read it back.
    const gatedRunner: ProcessRunner = {
      run: async (request) => {
        if (!gated && request.argv.includes('--pathspec-from-file')) {
          gated = true
          enteredAdd()
          await held
        }
        return runtime.runner.run(request)
      },
    }

    const secondStore = new ForgeyardStore(databasePath)
    try {
      const gatedEngine = buildEngine(secondStore, gatedRunner)
      const request = {
        attemptId: approved.attempt.id,
        actor: 'operator',
        rationale: 'Two Forgeyard Hosts promote one Attempt in one process.',
        expectedReviewDigest: approved.promotion.reviewDigest as string,
      }
      const gatedPromotion = gatedEngine.promote(request).then(() => null, (error: unknown) => error)
      await atAdd

      // The other Host promotes and completes, running its own scratch cleanup.
      // Neither the Attempt ID nor the process ID separates these two calls, and
      // the tree is built before any row claims the uniqueness constraint.
      await promote(approved)
      releaseAdd()

      const rejection = await gatedPromotion
      expect(rejection).toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
      // It must lose on the durable constraint, not because the other Host's
      // cleanup deleted the pathspec file out from under its `git add`.
      expect(errorMessage(rejection)).toMatch(/could not enter promotion/u)
      expect(errorMessage(rejection)).not.toMatch(/could not be projected/u)
    } finally {
      releaseAdd()
      secondStore.close()
    }

    const promotions = store.promotions(approved.attempt.id)
    expect(promotions.filter(item => item.status === 'promoted')).toHaveLength(1)
    const promoted = promotions.find(item => item.status === 'promoted') as PromotionRecord
    expect(await engine.git.readPromotionRef(repositoryPath, promoted.outputRef)).toBe(promoted.outputCommit)
  })

  it('records a promotion whose ref write landed but whose Git call failed', async () => {
    const approved = await approvedAttempt()
    const create = engine.git.createPromotionRef.bind(engine.git)
    let calls = 0
    // `git update-ref` can commit its ref transaction and still fail the call
    // that ran it — a timeout, or a lost subprocess result, after the ref
    // landed. The durable output exists; the error says nothing about it.
    engine.git.createPromotionRef = async (cwd, ref, commit) => {
      calls += 1
      await create(cwd, ref, commit)
      throw new Error('git update-ref timed out after 20000ms')
    }

    const promoted = await promote(approved)
    expect(calls).toBe(1)
    const record = promoted.promotions[0] as PromotionRecord
    // Recording `failed` here would file an existing output as a failure and
    // release the constraint onto a ref every later retry would collide with.
    expect(record).toMatchObject({ status: 'promoted', failureReason: null })
    expect(await create.call(engine.git, repositoryPath, record.outputRef, record.outputCommit)
      .then(() => 'created', () => 'refused')).toBe('refused')
    expect(await engine.git.readPromotionRef(repositoryPath, record.outputRef)).toBe(record.outputCommit)
    expect(promoted.promotion).toMatchObject({ status: 'promoted', outputCommit: record.outputCommit })
  })

  it('leaves a promotion pending when neither the ref write nor its read-back is conclusive', async () => {
    const approved = await approvedAttempt()
    const read = engine.git.readPromotionRef.bind(engine.git)
    engine.git.createPromotionRef = async () => { throw new Error('git update-ref timed out after 20000ms') }
    engine.git.readPromotionRef = async () => { throw new Error('the Forgeyard promotion ref could not be read completely') }

    await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'GIT_ERROR' })
    engine.git.readPromotionRef = read

    // Nothing is guessed in either direction: the Promotion stays pending and
    // its lease hands the question to reconciliation.
    const record = store.promotions(approved.attempt.id)[0] as PromotionRecord
    expect(record).toMatchObject({ status: 'pending', failureReason: null })
    const view = await engine.attemptView(approved.attempt.id)
    expect(view.promotion).toMatchObject({ status: 'uncertain', eligible: false })
    expect(view.promotion.reason).toMatch(/holds a live lease/u)
  })

  it('accepts a settlement another Host wrote while reconciling the same Promotion', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)
    await engine.git.createPromotionRef(repositoryPath, record.outputRef, record.outputCommit)

    const secondStore = new ForgeyardStore(databasePath)
    try {
      const secondEngine = buildEngine(secondStore)
      const read = secondEngine.git.readPromotionRef.bind(secondEngine.git)
      // Both Hosts read the same expired pending row and the same ref before
      // either settles it. This one loses the write.
      secondEngine.git.readPromotionRef = async (cwd, ref) => {
        const observed = await read(cwd, ref)
        store.settlePromotion(record.id, 'promoted', null)
        return observed
      }
      // The loser reports the authoritative outcome instead of aborting the
      // whole reconciliation over a question that is already answered.
      await expect(secondEngine.reconcilePromotions()).resolves.toBe(0)
    } finally {
      secondStore.close()
    }
    expect(store.promotion(record.id)).toMatchObject({ status: 'promoted', failureReason: null })
    expect(await engine.attemptView(approved.attempt.id)).toMatchObject({
      promotion: { status: 'promoted', outputCommit: record.outputCommit },
    })
  })

  it('reconciles a leased promotion when its lease lapses, without another Host restart', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    // A Host was interrupted mid-promotion and restarted before the lease
    // lapsed, so the one boot-time pass necessarily skips the row.
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit, 'live', 400)
    expect(await engine.reconcilePromotions()).toBe(0)

    const blocked = await engine.attemptView(approved.attempt.id)
    expect(blocked.promotion).toMatchObject({ status: 'uncertain', eligible: false })
    // Nothing here is an operator gesture: the panel hides the promote action
    // while the Attempt is ineligible, so no click can reach the on-demand
    // reconciliation inside `promote`. Forgeyard has to arm the pass itself.
    await vi.waitFor(
      () => { expect(store.promotion(record.id)).toMatchObject({ status: 'failed' }) },
      { timeout: 10_000, interval: 50 },
    )
    expect(store.promotion(record.id)?.failureReason)
      .toMatch(/interrupted before this promotion created its Git ref/u)

    // The Attempt is released, and an explicit retry promotes it for real.
    const released = await engine.attemptView(approved.attempt.id)
    expect(released.promotion).toMatchObject({ status: 'eligible', eligible: true })
    const promoted = await promote(released)
    expect(promoted.promotions.map(item => item.status)).toEqual(['failed', 'promoted'])
  })

  it('refuses to write a promotion ref after its own lease lapsed', async () => {
    const approved = await approvedAttempt()
    // A stall Git's command timeout cannot bound — a stopped process, a frozen
    // container — outlives the lease between the recorded intent and the write.
    let wrote = 0
    const create = engine.git.createPromotionRef.bind(engine.git)
    engine.git.createPromotionRef = async (cwd, ref, commit) => {
      wrote += 1
      return create(cwd, ref, commit)
    }
    // Expire the lease the moment the row lands, exactly as an outlived lease
    // would look to this Host when it finally resumes.
    const insert = store.insertPendingPromotion.bind(store)
    store.insertPendingPromotion = (record) => {
      insert({ ...record, leaseExpiresAt: record.createdAt + 1 })
    }

    await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
    // No durable output may exist: the write is refused, not raced.
    expect(wrote).toBe(0)
    expect(await engine.git.readPromotionRef(repositoryPath, GitAuthority.promotionRef(approved.attempt.id))).toBeNull()
    const record = store.promotions(approved.attempt.id)[0] as PromotionRecord
    expect(record).toMatchObject({ status: 'failed' })
    expect(record.failureReason).toMatch(/lost its lease before its Git ref was created/u)

    // The Attempt is released and promotes for real once the lease is honest.
    store.insertPendingPromotion = insert
    const released = await engine.attemptView(approved.attempt.id)
    expect(released.promotion).toMatchObject({ status: 'eligible', eligible: true })
    expect((await promote(released)).promotion).toMatchObject({ status: 'promoted' })
  })

  it('never writes outside refs/forgeyard when a symbolic ref occupies the name', async () => {
    const approved = await approvedAttempt()
    const ref = GitAuthority.promotionRef(approved.attempt.id)
    const branch = 'refs/heads/injected'
    // A repository writer points the promotion name at a branch that does not
    // exist. Git would follow the symref and create that branch instead.
    await run(runtime.runner, repositoryPath, ['git', 'symbolic-ref', ref, branch])
    expect(await gitText(repositoryPath, ['git', 'symbolic-ref', ref])).toBe(branch)

    await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'GIT_ERROR' })
    // The guarantee is that promotion only ever writes under refs/forgeyard/.
    const branches = await gitText(repositoryPath, ['git', 'for-each-ref', '--format=%(refname)', 'refs/heads/'])
    expect(branches).not.toContain(branch)
    expect((await run(runtime.runner, repositoryPath,
      ['git', 'rev-parse', '--verify', '--quiet', branch], true)).exitCode).not.toBe(0)
    expect(store.promotions(approved.attempt.id)[0]).toMatchObject({ status: 'failed' })
  })

  it('refuses a promoted ref whose commit object is no longer readable', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord
    expect(promoted.promotion).toMatchObject({ status: 'promoted' })

    // The ref text survives object-store damage; `rev-parse --verify` answers
    // from the ref alone and would keep calling the output durable.
    const objectPath = join(
      repositoryPath, '.git', 'objects',
      record.outputCommit.slice(0, 2), record.outputCommit.slice(2),
    )
    await rm(objectPath, { force: true })
    expect((await run(runtime.runner, repositoryPath,
      ['git', 'rev-parse', '--verify', '--quiet', record.outputRef], true)).stdout.text.trim())
      .toBe(record.outputCommit)

    await expect(engine.git.readPromotionRef(repositoryPath, record.outputRef))
      .rejects.toThrow(/not all readable in this repository/u)
    // A settled question, not a transient read: it must stop rendering as a
    // green promoted output.
    const damaged = await engine.attemptView(approved.attempt.id)
    expect(damaged.promotion).toMatchObject({ status: 'diverged', eligible: false })
    expect(damaged.promotion.reason).toMatch(/that output no longer holds/u)
    expect(damaged.promotion.reason).toMatch(/not all readable in this repository/u)
  })

  it('refuses a promoted commit whose tree or blobs were pruned beneath it', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord

    // The commit object survives; one promoted blob beneath it does not. A
    // check of the commit alone is blind to this, but the commit cannot be
    // checked out, so it is not a durable output.
    const blob = await gitText(repositoryPath, ['git', 'rev-parse', `${record.outputCommit}:source.txt`])
    await rm(join(repositoryPath, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true })
    expect((await run(runtime.runner, repositoryPath,
      ['git', 'cat-file', '-e', `${record.outputCommit}^{commit}`], true)).exitCode).toBe(0)

    await expect(engine.git.readPromotionRef(repositoryPath, record.outputRef))
      .rejects.toThrow(/not all readable in this repository/u)
    expect((await engine.attemptView(approved.attempt.id)).promotion)
      .toMatchObject({ status: 'diverged', eligible: false })
  })

  it('surfaces an opposite settlement instead of reporting success over it', async () => {
    const approved = await approvedAttempt()
    const secondStore = new ForgeyardStore(databasePath)
    try {
      const create = engine.git.createPromotionRef.bind(engine.git)
      // The ref write lands, but the call fails, and another Host settles the
      // row `failed` in that window. The ref then reads back as this
      // promotion's exact commit while the record says the opposite.
      engine.git.createPromotionRef = async (cwd, ref, commit) => {
        await create(cwd, ref, commit)
        const pending = secondStore.pendingPromotions()[0] as PromotionRecord
        secondStore.settlePromotion(pending.id, 'failed', 'Another Host read no ref and settled first.')
        throw new Error('git update-ref timed out after 20000ms')
      }
      // Treating that as agreement would report a promoted Attempt over a
      // durable output filed as a failure.
      await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'GIT_ERROR' })
    } finally {
      secondStore.close()
    }

    const record = store.promotions(approved.attempt.id)[0] as PromotionRecord
    expect(record).toMatchObject({ status: 'failed' })
    // The disagreement is reported rather than resolved: the ref exists, holds
    // the promoted commit, and the record still says failed.
    expect(await engine.git.readPromotionRef(repositoryPath, record.outputRef)).toBe(record.outputCommit)
  })

  it('re-arms reconciliation when a scheduled pass rejects', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)

    // The first pass fails outright — SQLite write contention, say. It has
    // already consumed the only timer, and nothing in the Cockpit can ask for
    // another, so the pass must arm its own replacement on the way out.
    let failures = 0
    const settle = store.settlePromotion.bind(store)
    store.settlePromotion = (id, status, reason) => {
      if (failures === 0) {
        failures += 1
        throw new Error('database is locked')
      }
      return settle(id, status, reason)
    }
    await expect(engine.reconcilePromotions()).rejects.toThrow(/database is locked/u)
    expect(failures).toBe(1)

    // Nothing else will ask. The rejected pass has to have armed the retry that
    // settles this row.
    await vi.waitFor(
      () => { expect(store.promotion(record.id)).toMatchObject({ status: 'failed' }) },
      { timeout: 10_000, interval: 50 },
    )
    expect(store.promotion(record.id)?.failureReason)
      .toMatch(/interrupted before this promotion created its Git ref/u)
    store.settlePromotion = settle
  })

  it('keeps looking for a promotion another Host left behind', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const peerStore = new ForgeyardStore(databasePath)
    const peer = buildEngine(peerStore, undefined, { idlePollMs: 200, reconcileRetryMs: 200 })
    try {
      // An idle Host that booted with nothing pending. Dropping its timer here
      // is what leaves an abandoned row undiscovered: nothing pushes another
      // Host's insert to this one, snapshots do not reconcile, and the Cockpit
      // hides promotion while the Attempt is uncertain.
      expect(await peer.reconcilePromotions()).toBe(0)

      // Another Host records the intent and dies with its own timer.
      const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)
      await vi.waitFor(
        () => { expect(peerStore.promotion(record.id)).toMatchObject({ status: 'failed' }) },
        { timeout: 10_000, interval: 50 },
      )
      expect(peerStore.promotion(record.id)?.failureReason)
        .toMatch(/interrupted before this promotion created its Git ref/u)
    } finally {
      peer.dispose()
      peerStore.close()
    }
    expect((await engine.attemptView(approved.attempt.id)).promotion)
      .toMatchObject({ status: 'eligible', eligible: true })
  })

  it('never confirms a completed promotion against a replaced repository', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord
    expect(promoted.promotion).toMatchObject({ status: 'promoted' })

    // The repository at the recorded path is replaced by a copy that holds the
    // same ref at the same commit. Only its identity differs, and identity is
    // exactly what makes it a different repository.
    const replacement = `${repositoryPath}.replacement`
    await cp(repositoryPath, replacement, { recursive: true, verbatimSymlinks: true })
    await rm(repositoryPath, { recursive: true, force: true })
    await rename(replacement, repositoryPath)
    expect(await gitText(repositoryPath, ['git', 'rev-parse', record.outputRef])).toBe(record.outputCommit)

    const view = await engine.attemptView(approved.attempt.id)
    expect(view.promotion).toMatchObject({ status: 'diverged', eligible: false })
    expect(view.promotion.reason).toMatch(/that output no longer holds/u)
    expect(view.promotion.reason).toMatch(/repository identity differs/u)
  })

  it('raises a reconciliation whose settlement disagrees with the ref it observed', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)

    const peerStore = new ForgeyardStore(databasePath)
    const peer = buildEngine(peerStore)
    try {
      const read = peer.git.readPromotionRef.bind(peer.git)
      // This Host observes the exact promoted commit. The other read nothing
      // first and settled `failed`. Counting that as an ordinary loss would
      // discard the disagreement and let a later promotion continue from the
      // failed row without ever saying the output ref is present.
      peer.git.readPromotionRef = async (cwd, ref) => {
        await engine.git.createPromotionRef(repositoryPath, record.outputRef, record.outputCommit)
        const observed = await read(cwd, ref)
        store.settlePromotion(record.id, 'failed', 'The other Host read no ref.')
        return observed
      }
      await expect(peer.reconcilePromotions())
        .rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
    } finally {
      peer.dispose()
      peerStore.close()
    }

    // The settlement another Host wrote stands, and the ref it disagrees with
    // is still there for an operator to inspect.
    expect(store.promotion(record.id)).toMatchObject({ status: 'failed' })
    expect(await engine.git.readPromotionRef(repositoryPath, record.outputRef)).toBe(record.outputCommit)
  })

  it('never accepts a symbolic output ref that resolves to the promoted commit', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord
    expect(promoted.promotion).toMatchObject({ status: 'promoted' })

    // A repository writer replaces the output with a symref to a branch that is
    // at the promoted commit right now. `rev-parse` follows it and returns the
    // recorded OID, so the resolved value alone cannot tell them apart — but
    // the output is now a moving target outside Forgeyard's namespace.
    await run(runtime.runner, repositoryPath, ['git', 'branch', 'moving', record.outputCommit])
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', '-d', record.outputRef])
    await run(runtime.runner, repositoryPath, ['git', 'symbolic-ref', record.outputRef, 'refs/heads/moving'])
    expect(await gitText(repositoryPath, ['git', 'rev-parse', record.outputRef])).toBe(record.outputCommit)

    await expect(engine.git.readPromotionRef(repositoryPath, record.outputRef))
      .rejects.toThrow(/is a symbolic ref to refs\/heads\/moving/u)
    // A known disagreement, not an unverified read: it must not keep rendering
    // as a promoted output just because it resolves to the right commit today.
    const view = await engine.attemptView(approved.attempt.id)
    expect(view.promotion).toMatchObject({ status: 'diverged', eligible: false })
    expect(view.promotion.reason).toMatch(/now a symbolic ref to refs\/heads\/moving/u)

    // And it really was a moving target: the branch advances, the "output" follows.
    await run(runtime.runner, repositoryPath, ['git', 'branch', '-f', 'moving', approved.attempt.baseCommit])
    expect(await gitText(repositoryPath, ['git', 'rev-parse', record.outputRef])).toBe(approved.attempt.baseCommit)
  })

  it('settles an expired promotion whose name is occupied by a symbolic ref', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)
    await run(runtime.runner, repositoryPath, ['git', 'branch', 'elsewhere', approved.attempt.baseCommit])
    await run(runtime.runner, repositoryPath, ['git', 'symbolic-ref', record.outputRef, 'refs/heads/elsewhere'])

    // Forgeyard can prove it never created this: it only ever writes a direct
    // ref. Treating the rejection as transient unreadability would repeat every
    // pass forever and leave the Attempt blocked with nothing to press.
    expect(await engine.reconcilePromotions()).toBe(1)
    expect(store.promotion(record.id)).toMatchObject({ status: 'failed' })
    expect(store.promotion(record.id)?.failureReason).toMatch(/symbolic ref to refs\/heads\/elsewhere/u)

    // The Attempt is released, and the planted symref is left exactly as found.
    expect((await engine.attemptView(approved.attempt.id)).promotion)
      .toMatchObject({ status: 'eligible', eligible: true })
    expect(await gitText(repositoryPath, ['git', 'symbolic-ref', record.outputRef])).toBe('refs/heads/elsewhere')
  })

  it('never writes a promotion ref into a repository replaced after planning', async () => {
    const approved = await approvedAttempt()
    const write = engine.git.createPromotionRef.bind(engine.git)
    let wrote = 0
    engine.git.createPromotionRef = async (cwd, ref, commit) => {
      wrote += 1
      return write(cwd, ref, commit)
    }
    // The repository at the authorized path is replaced between planning and
    // the write. `prepared.repository` is a cached identity, so Git would
    // resolve the path afresh and create the ref inside the replacement.
    const view = engine.git.promotionView.bind(engine.git)
    engine.git.promotionView = async (prepared) => {
      const result = await view(prepared)
      const replacement = `${repositoryPath}.replacement`
      await cp(repositoryPath, replacement, { recursive: true, verbatimSymlinks: true })
      await rm(repositoryPath, { recursive: true, force: true })
      await rename(replacement, repositoryPath)
      return result
    }

    await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'GIT_ERROR' })
    // Reporting the mismatch afterwards could not have undone the write.
    expect(wrote).toBe(0)
    expect(await gitText(repositoryPath, ['git', 'for-each-ref', '--format=%(refname)', 'refs/forgeyard/'])).toBe('')
    const record = store.promotions(approved.attempt.id)[0] as PromotionRecord
    expect(record).toMatchObject({ status: 'failed' })
    expect(record.failureReason).toMatch(/no longer matches the Attempt snapshot/u)
  })

  it('budgets the promotion lease for every Git command run after the intent', async () => {
    const approved = await approvedAttempt()
    // The lease must cover the whole post-intent path. It was written when that
    // path was two commands long and silently fell behind as commands were
    // added, so the count is measured against a real promotion rather than
    // asserted: a peer settling the row while one of them is still live is the
    // exact disagreement the lease exists to prevent.
    let counting = false
    const observed: string[] = []
    const countingRunner: ProcessRunner = {
      run: async (request) => {
        if (counting) {
          const verb = request.argv.findIndex((a, i) => i > 0 && !a.startsWith('-') && !a.includes('='))
          observed.push(request.argv.slice(verb, verb + 2).join(' '))
        }
        return runtime.runner.run(request)
      },
    }
    const countingStore = new ForgeyardStore(databasePath)
    try {
      const counted = buildEngine(countingStore, countingRunner)
      const insert = countingStore.insertPendingPromotion.bind(countingStore)
      countingStore.insertPendingPromotion = (record) => { insert(record); counting = true }
      const settle = countingStore.settlePromotion.bind(countingStore)
      countingStore.settlePromotion = (id, status, reason) => {
        counting = false
        return settle(id, status, reason)
      }

      const promoted = await counted.promote({
        attemptId: approved.attempt.id,
        actor: 'operator',
        rationale: 'Measure the post-intent Git path.',
        expectedReviewDigest: approved.promotion.reviewDigest as string,
      })
      counted.dispose()

      expect(observed.length).toBeGreaterThan(0)
      expect(observed.length).toBeLessThanOrEqual(PROMOTION_POST_INTENT_GIT_COMMANDS)
      const record = promoted.promotions[0] as PromotionRecord
      expect(record.leaseExpiresAt - record.createdAt)
        .toBeGreaterThanOrEqual(observed.length * 20_000 + PROMOTION_LEASE_MARGIN_MS)
    } finally {
      countingStore.close()
    }
  })

  it('blocks promotion when a retained failed Promotion no longer verifies', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    // A failed row is retained audit authority. Verifying only the active
    // record would let a corrupted failure history sit underneath a fresh
    // promotion written on top of it.
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)
    store.settlePromotion(record.id, 'failed', 'released so the Attempt is promotable again')
    expect((await engine.attemptView(approved.attempt.id)).promotion)
      .toMatchObject({ status: 'eligible', eligible: true })

    store.database.exec('DROP TRIGGER promotions_authority_immutable')
    store.database.prepare('UPDATE promotions SET output_commit=? WHERE id=?').run('0'.repeat(40), record.id)

    const tampered = await engine.attemptView(approved.attempt.id)
    expect(tampered.promotion).toMatchObject({ status: 'blocked', eligible: false })
    expect(tampered.promotion.reason).toMatch(/recorded Promotion authority is invalid/u)
    await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
  })

  it('does not hold the engine queue while background reconciliation probes Git', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)

    let release = (): void => {}
    const stalled = new Promise<void>((resolve) => { release = resolve })
    let stalling = false
    const read = engine.git.readPromotionRef.bind(engine.git)
    // A repository whose Git commands stall. At the shipped 120s timeout a few
    // of these in a row is minutes; a Host recovering quietly must not look
    // like a Host that is down.
    engine.git.readPromotionRef = async (cwd, ref) => {
      stalling = true
      await stalled
      return read(cwd, ref)
    }

    const pass = engine.reconcilePromotions()
    await vi.waitFor(() => { expect(stalling).toBe(true) }, { timeout: 5_000, interval: 10 })

    // The queue must still serve requests while that probe is outstanding.
    const view = await Promise.race([
      engine.attemptView(approved.attempt.id).then(() => 'served' as const),
      new Promise<'blocked'>((resolve) => { setTimeout(() => { resolve('blocked') }, 2_000).unref?.() }),
    ])
    expect(view).toBe('served')

    release()
    await pass
  })

  it('never reports a broken promotion ref as an absent one', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)

    // A ref file holding a malformed object name. `rev-parse --verify --quiet`
    // exits 1 with empty stdout exactly as it does for a ref that is not there,
    // and only warns on stderr — but the namespace is still occupied.
    const refPath = join(repositoryPath, '.git', record.outputRef)
    await mkdir(dirname(refPath), { recursive: true })
    await writeFile(refPath, 'not-an-object-name\n')

    await expect(engine.git.readPromotionRef(repositoryPath, record.outputRef))
      .rejects.toThrow(/exists but Git cannot read it/u)

    // Settling "no durable output exists, so the Attempt may be promoted again"
    // would send every retry into a collision with the ref sitting right there.
    expect(await engine.reconcilePromotions()).toBe(1)
    const settled = store.promotion(record.id) as PromotionRecord
    expect(settled.status).toBe('failed')
    expect(settled.failureReason).toMatch(/No usable Forgeyard-owned output exists/u)
    expect(settled.failureReason).not.toMatch(/No durable output exists/u)
  })

  it('refuses a promoted commit whose frozen base parent was pruned', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord

    // The promotion commit, its tree, and its blobs all survive; the base commit
    // it names as parent does not. `git show` on the promotion cannot parse it.
    const base = approved.attempt.baseCommit
    await rm(join(repositoryPath, '.git', 'objects', base.slice(0, 2), base.slice(2)), { force: true })
    expect((await run(runtime.runner, repositoryPath, ['git', 'show', record.outputCommit], true)).exitCode)
      .not.toBe(0)

    await expect(engine.git.readPromotionRef(repositoryPath, record.outputRef))
      .rejects.toThrow(/not all readable in this repository/u)
    expect((await engine.attemptView(approved.attempt.id)).promotion)
      .toMatchObject({ status: 'diverged', eligible: false })
  })

  it('refuses promotion text that SQLite could not store unchanged', async () => {
    const approved = await approvedAttempt()
    // An unpaired UTF-16 surrogate is stored by SQLite as U+FFFD, so text
    // hashed before the write could never match the text read back. A Promotion
    // carrying one would create its ref and then fail its own integrity check
    // forever, reporting invalid authority over a real durable output.
    const lone = 'promote\ud800now'
    expect(lone.isWellFormed()).toBe(false)

    await expect(engine.promote({
      attemptId: approved.attempt.id,
      actor: 'operator',
      rationale: lone,
      expectedReviewDigest: approved.promotion.reviewDigest as string,
    })).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'INVALID_REQUEST' })

    // Refused before anything durable exists, and the Attempt stays promotable.
    expect(store.promotions(approved.attempt.id)).toEqual([])
    expect(await engine.git.readPromotionRef(repositoryPath, GitAuthority.promotionRef(approved.attempt.id)))
      .toBeNull()
    expect((await engine.attemptView(approved.attempt.id)).promotion)
      .toMatchObject({ status: 'eligible', eligible: true })
  })

  it('never fails a promotion another Host may still be creating', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit, 'live')

    // A second Host reconciles in the window between the first Host's durable
    // intent and its `git update-ref`. No ref exists yet, and that proves
    // nothing: failing the row here would release the uniqueness constraint
    // while the first Host goes on to create a ref it can no longer settle.
    const secondStore = new ForgeyardStore(databasePath)
    try {
      const secondEngine = buildEngine(secondStore)
      expect(await secondEngine.reconcilePromotions()).toBe(0)
    } finally {
      secondStore.close()
    }
    expect(store.promotion(record.id)).toMatchObject({ status: 'pending', failureReason: null })
    expect(await engine.git.readPromotionRef(repositoryPath, record.outputRef)).toBeNull()

    // The in-flight promotion still owns the Attempt, so nothing starts a second one.
    const view = await engine.attemptView(approved.attempt.id)
    expect(view.promotion).toMatchObject({ status: 'uncertain', eligible: false })
    expect(view.promotion.reason).toMatch(/holds a live lease/u)
    await expect(promote(view)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })

    // The owning Host finishes and settles its own promotion exactly once.
    await engine.git.createPromotionRef(repositoryPath, record.outputRef, record.outputCommit)
    expect(store.settlePromotion(record.id, 'promoted', null)).toMatchObject({ status: 'promoted' })
    expect(await engine.attemptView(approved.attempt.id)).toMatchObject({
      promotion: { status: 'promoted', outputCommit: record.outputCommit },
    })
  })

  it('reconciles a promotion whose ref was already created before the Host stopped', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)
    await engine.git.createPromotionRef(repositoryPath, record.outputRef, record.outputCommit)

    store.close()
    store = new ForgeyardStore(databasePath)
    engine = buildEngine(store)
    expect(await engine.reconcilePromotions()).toBe(1)
    expect(store.promotion(record.id)).toMatchObject({ status: 'promoted', failureReason: null })
    const view = await engine.attemptView(approved.attempt.id)
    expect(view.promotion).toMatchObject({ status: 'promoted', outputCommit: record.outputCommit })
    await expect(promote(view)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
  })

  it('reports a foreign ref discovered at restart as an explicit failure', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const head = await gitText(repositoryPath, ['git', 'rev-parse', 'HEAD'])
    const foreign = await gitText(repositoryPath, [
      'git', 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'unrelated local commit',
    ])
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)
    await run(runtime.runner, repositoryPath, ['git', 'update-ref', record.outputRef, foreign])

    expect(await engine.reconcilePromotions()).toBe(1)
    expect(store.promotion(record.id)).toMatchObject({ status: 'failed' })
    expect(store.promotion(record.id)?.failureReason).toContain(foreign)
    expect(await engine.git.readPromotionRef(repositoryPath, record.outputRef)).toBe(foreign)

    // The Attempt becomes promotable again, and still fails closed on the ref.
    await expect(promote(await engine.attemptView(approved.attempt.id)))
      .rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'GIT_ERROR' })
  })

  it('keeps a completed promotion durable and immutable across a Host restart', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord

    store.close()
    store = new ForgeyardStore(databasePath)
    engine = buildEngine(store)
    expect(await engine.reconcilePromotions()).toBe(0)
    expect(store.promotions(approved.attempt.id)).toEqual([record])
    expect(() => store.database.prepare('UPDATE promotions SET output_commit=? WHERE id=?').run('0'.repeat(40), record.id))
      .toThrow(/promotion authority is immutable/u)
    // A lease that could be shortened is no lease at all.
    expect(() => store.database.prepare('UPDATE promotions SET lease_expires_at=? WHERE id=?').run(0, record.id))
      .toThrow(/promotion authority is immutable/u)
    expect(() => store.database.prepare("UPDATE promotions SET status='failed', failure_reason='x', settled_at=1 WHERE id=?").run(record.id))
      .toThrow(/settles exactly once/u)
    expect(() => store.database.prepare('DELETE FROM promotions WHERE id=?').run(record.id))
      .toThrow(/retained for audit/u)
    expect(await engine.git.readPromotionRef(repositoryPath, record.outputRef)).toBe(record.outputCommit)
  })

  it('blocks promotion when a stored Promotion row no longer verifies', async () => {
    const approved = await approvedAttempt()
    const promoted = await promote(approved)
    const record = promoted.promotions[0] as PromotionRecord

    // Only a hand-edited database can reach this state; the triggers refuse it.
    expect(() => store.database.prepare('UPDATE promotions SET hash=? WHERE id=?').run('0'.repeat(64), record.id))
      .toThrow(/promotion authority is immutable/u)
    store.database.exec('DROP TRIGGER promotions_authority_immutable')
    store.database.prepare('UPDATE promotions SET output_commit=? WHERE id=?').run('0'.repeat(40), record.id)

    const tampered = await engine.attemptView(approved.attempt.id)
    expect(tampered.promotion).toMatchObject({ status: 'blocked', eligible: false })
    expect(tampered.promotion.reason).toMatch(/recorded Promotion authority is invalid/u)
    await expect(promote(approved)).rejects.toMatchObject<Partial<ForgeyardDomainError>>({ code: 'PROMOTION_BLOCKED' })
  })

  it('refuses a Promotion row that is not bound to an approved Attempt and APPROVE Decision', async () => {
    const approved = await approvedAttempt()
    const decision = approved.decisions[0] as DecisionRecord
    const record = await pendingPromotion(approved.attempt, decision, approved.attempt.baseCommit)
    store.settlePromotion(record.id, 'failed', 'released for this test')

    // Rehash so the row is internally consistent and the binding guard, not the
    // content hash, is the check that refuses it.
    const rebound = { ...record, id: 'promotion_wrong_digest', reviewDigest: sha256('other') }
    expect(() => store.insertPendingPromotion({ ...rebound, hash: hashRecord(promotionCore(rebound)) }))
      .toThrow(/terminal APPROVE Decision/u)
    expect(() => store.insertPendingPromotion({ ...record, id: 'promotion_forged_hash', hash: '0'.repeat(64) }))
      .toThrow(/content hash is invalid/u)
    expect(() => store.insertPendingPromotion({
      ...record,
      id: 'promotion_forged_projection',
      projection: { ...record.projection, manifestEntryCount: record.projection.manifestEntryCount + 1 },
    })).toThrow(/projection hash is invalid/u)
  })
})
