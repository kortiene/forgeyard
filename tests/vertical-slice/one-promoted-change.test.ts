import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AttemptRecord,
  AttemptView,
  DecisionRecord,
  ExecutionSnapshot,
  MissionCreateRequest,
  PromotionRecord,
  ResolvedPolicySnapshot,
} from '../../packages/forgeyard/src/types.ts'
import { ForgeyardDomainError, ForgeyardEngine } from '../../packages/forgeyard/src/host/engine.ts'
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

  function buildEngine(activeStore: ForgeyardStore, runner?: ProcessRunner): ForgeyardEngine {
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
    return new ForgeyardEngine(activeStore, git, sessions, collector, { dshVersion: '0.1.1-rc.2' })
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
      task: 'Write the fixed parser result.',
      verificationCommand: 'node verify.mjs',
      provider: null,
      model: null,
      reasoningEffort: null,
      agentPreset: null,
      permissionPreset: null,
    }
  }

  async function approvedAttempt(): Promise<AttemptView> {
    const mission = await engine.createMission(missionRequest())
    const running = await engine.startAttempt(mission.task.id)
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
      leaseExpiresAt: lease === 'live' ? Date.now() + 3_600_000 : core.createdAt + 1_000,
      settledAt: null,
    }
    store.insertPendingPromotion(record)
    return record
  }

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
    const failing = await engine.startAttempt(mission.task.id)
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
    const running = await engine.startAttempt(mission.task.id)
    const cancelled = await engine.decide({
      attemptId: running.attempt.id,
      type: 'CANCEL',
      actor: 'operator',
      rationale: 'Cancel before review.',
    })
    expect(cancelled.promotion.reason).toMatch(/this Attempt is cancelled/u)

    // A Host restart during an external operation makes the Attempt uncertain.
    const second = await engine.createMission({ ...missionRequest(), title: 'Second mission' })
    const uncertain = await engine.startAttempt(second.task.id)
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
