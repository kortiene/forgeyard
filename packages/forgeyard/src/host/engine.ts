import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  AttemptId,
  AttemptRecord,
  AttemptSessionRef,
  AttemptView,
  DecisionRecord,
  DecisionRequest,
  EvidenceRecord,
  ExecutionSnapshot,
  ForgeyardSnapshot,
  GitFingerprint,
  MissionCreateRequest,
  MissionId,
  MissionRecord,
  MissionView,
  PromoteRequest,
  PromotionEligibility,
  PromotionId,
  PromotionRecord,
  ReviewState,
  RetryRequest,
  TaskId,
  TaskRecord,
  VerificationRecord,
} from '../types.ts'
import { parseCommandLine } from './command-line.ts'
import type { TrustedEvidenceCollector } from './evidence.ts'
import type { SessionGateway } from './execution.ts'
import { GitAuthority, type CanonicalRepository, type PreparedWorktree, type PromotionGitView } from './git.ts'
import { canonicalJson, forgeyardId, hashRecord, sha256 } from './hash.ts'
import { assertTreeMatchesProjection, PromotionProjector, type PromotionProjectionResult } from './promotion.ts'
import {
  assertAttemptRecordIntegrity,
  assertPromotionRecordIntegrity,
  promotionCore,
  type ForgeyardStore,
} from './store.ts'

export class ForgeyardDomainError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'INVALID_STATE' | 'GIT_ERROR' | 'DSH_ERROR'
      | 'VERIFICATION_REQUIRED' | 'REVIEW_STALE' | 'PROMOTION_BLOCKED',
    message: string,
  ) {
    super(message)
  }
}

/** The Forgeyard-owned identity every promotion commit is authored with. */
export const PROMOTION_IDENTITY = { name: 'Forgeyard', email: 'forgeyard@promotion.invalid' } as const

/**
 * Time added to a promotion lease on top of the Git commands it must cover:
 * process spawn, SQLite writes, and scheduling between them. It only widens the
 * window in which a live Host provably owns its own recorded intent.
 */
export const PROMOTION_LEASE_MARGIN_MS = 30_000

/**
 * How long to wait before looking again at a Promotion whose lease has already
 * lapsed but which still could not be settled — an unreadable repository, say.
 * It only bounds a retry; it never shortens the lease itself.
 */
export const PROMOTION_RECONCILE_RETRY_MS = 60_000

function trailerText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 200)
}

function requiredText(name: string, value: string, max = 20_000): string {
  const text = value.trim()
  if (text.length === 0) throw new ForgeyardDomainError('INVALID_REQUEST', `${name} is required`)
  if (Buffer.byteLength(text) > max) throw new ForgeyardDomainError('INVALID_REQUEST', `${name} is too large`)
  return text
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedReason(prefix: string, error: unknown): string {
  return `${prefix}: ${errorText(error)}`.slice(0, 20_000)
}

function decisionRecord(request: DecisionRequest | RetryRequest, type: DecisionRecord['type'], digest: string): DecisionRecord {
  const actor = requiredText('actor', request.actor, 500)
  const rationale = requiredText('rationale', request.rationale, 10_000)
  return {
    id: forgeyardId('decision'),
    attemptId: request.attemptId,
    type,
    reviewDigest: digest,
    actor,
    rationale,
    createdAt: Date.now(),
  }
}

export interface EngineConfig {
  dshVersion: string
}

interface PlannedAttempt {
  attempt: AttemptRecord
  repository: CanonicalRepository
}

const VERIFIABLE_STATES = new Set(['running', 'awaiting_decision', 'interrupted', 'needs_review'])
const RETRYABLE_STATES = new Set(['awaiting_decision', 'interrupted', 'needs_review'])

/** Modular-monolith application service for the complete Milestone 1 loop. */
export class ForgeyardEngine {
  /**
   * SQLite serializes its own writes, while this queue additionally makes each
   * Host Remote observe one complete external-operation lifecycle at a time.
   */
  private mutationTail: Promise<void> = Promise.resolve()

  private readonly projector: PromotionProjector

  /** The pending reconciliation armed for the earliest live promotion lease. */
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    readonly store: ForgeyardStore,
    readonly git: GitAuthority,
    readonly sessions: SessionGateway,
    readonly collector: TrustedEvidenceCollector,
    readonly config: EngineConfig,
  ) {
    this.projector = new PromotionProjector({
      previewBytes: git.config.reviewDiffBytes,
      spillBytes: git.config.spillBytes,
    })
  }

  /** Stop the scheduled lease reconciliation. Safe to call more than once. */
  dispose(): void {
    this.disposed = true
    if (this.leaseTimer !== null) {
      clearTimeout(this.leaseTimer)
      this.leaseTimer = null
    }
  }

  /**
   * Arm the next reconciliation for the earliest live promotion lease.
   *
   * A leased Promotion is deliberately skipped, so a single boot-time pass can
   * leave one pending indefinitely: the Cockpit reports it as `uncertain` and
   * the panel hides the promote action while it is ineligible, which means no
   * operator gesture reaches the on-demand reconciliation inside `promote`.
   * Forgeyard therefore schedules the pass itself, for the instant the question
   * becomes answerable. A row whose lease has already lapsed and still did not
   * settle is retried on a bounded interval instead of spinning.
   */
  private scheduleLeaseReconciliation(): void {
    if (this.leaseTimer !== null) {
      clearTimeout(this.leaseTimer)
      this.leaseTimer = null
    }
    if (this.disposed) return
    let earliest: number | null = null
    for (const record of this.store.pendingPromotions()) {
      if (earliest === null || record.leaseExpiresAt < earliest) earliest = record.leaseExpiresAt
    }
    if (earliest === null) return
    const remaining = earliest - Date.now()
    const delay = remaining > 0 ? remaining + 1_000 : PROMOTION_RECONCILE_RETRY_MS
    this.leaseTimer = setTimeout(() => {
      this.leaseTimer = null
      // A pass that cannot run right now leaves the row pending; the pass it
      // schedules on the way out is what tries again.
      void this.reconcilePromotions().catch(() => undefined)
    }, delay)
    this.leaseTimer.unref?.()
  }

  recoverAfterRestart(): number {
    return this.store.recoverUncertainAttempts()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }

  /** Fence a published native Session; only a public not-found proof may bypass it. */
  private async runTerminalAuthority<T>(
    attempt: AttemptRecord,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (await this.sessions.sessionExists(attempt.dshSessionId)) {
      return this.sessions.runTerminalMaintenance(attempt.dshSessionId, task)
    }
    return task(new AbortController().signal)
  }

  async createMission(request: MissionCreateRequest): Promise<MissionView> {
    return this.enqueue(async () => {
      const title = requiredText('title', request.title, 1_000)
      const objective = requiredText('objective', request.objective)
      const instruction = requiredText('task', request.task)
      const baseRef = requiredText('base reference', request.baseRef, 1_000)
      const verificationCommand = requiredText('verification command', request.verificationCommand, 10_000)
      if (!isAbsolute(request.repositoryPath)) {
        throw new ForgeyardDomainError('INVALID_REQUEST', 'repository path must be absolute')
      }

      let repository: CanonicalRepository
      try {
        repository = await this.git.canonicalize(request.repositoryPath)
        await this.git.assertClean(repository)
      } catch (error) {
        throw new ForgeyardDomainError('GIT_ERROR', errorText(error))
      }

      let policy
      try {
        policy = await this.sessions.resolvePolicy(request)
      } catch (error) {
        throw new ForgeyardDomainError('DSH_ERROR', errorText(error))
      }

      let argv: string[]
      try {
        argv = parseCommandLine(verificationCommand)
      } catch (error) {
        throw new ForgeyardDomainError('INVALID_REQUEST', errorText(error))
      }
      const requirement = { key: 'verify-1', command: verificationCommand, argv }
      const pipe = { nodes: [{ key: 'implement', task: instruction, verify: [requirement] }] }
      const now = Date.now()
      const mission: MissionRecord = {
        id: forgeyardId('mission'),
        title,
        objective,
        repository: await this.git.repositorySnapshot(repository, baseRef),
        baseRef,
        defaultPolicy: policy,
        pipe,
        pipeHash: hashRecord(pipe),
        createdAt: now,
      }
      const task: TaskRecord = {
        id: forgeyardId('task'),
        missionId: mission.id,
        sourceNodeKey: 'implement',
        specification: { title, objective, instruction, verification: [requirement] },
        dependencies: [],
        createdAt: now,
      }
      this.store.insertMissionAndTask(mission, task)
      return this.missionViewUnqueued(mission.id)
    })
  }

  async startAttempt(taskId: TaskId): Promise<AttemptView> {
    return this.enqueue(async () => {
      if (this.store.attemptsForTask(taskId).length !== 0) {
        throw new ForgeyardDomainError(
          'INVALID_STATE',
          'The first Attempt already exists; use Retry to create an immutable successor.',
        )
      }
      const planned = await this.planAttempt(taskId, null)
      this.store.createAttempt(planned.attempt)
      return this.completeAttempt(planned)
    })
  }

  /** Preflight freezes authority without yet mutating Attempt/Decision state. */
  private async planAttempt(taskId: TaskId, retryOf: AttemptRecord | null): Promise<PlannedAttempt> {
    const task = this.store.task(taskId)
    if (task === undefined) throw new ForgeyardDomainError('NOT_FOUND', `Task ${taskId} was not found`)
    const mission = this.store.mission(task.missionId)
    if (mission === undefined) throw new ForgeyardDomainError('NOT_FOUND', `Mission ${task.missionId} was not found`)

    if (retryOf === null) {
      if (this.store.attemptsForTask(task.id).length !== 0) {
        throw new ForgeyardDomainError('INVALID_STATE', 'An initial Attempt already exists for this Task.')
      }
    } else {
      const attempts = this.store.attemptsForTask(task.id)
      if (retryOf.taskId !== task.id || attempts.at(-1)?.id !== retryOf.id
        || !RETRYABLE_STATES.has(retryOf.state) || retryOf.successorAttemptId !== null) {
        throw new ForgeyardDomainError('INVALID_STATE', 'Retry must extend the latest eligible Attempt exactly once.')
      }
    }

    let repository: CanonicalRepository
    let baseCommit: string
    let repositorySnapshot: MissionRecord['repository']
    try {
      repository = await this.git.canonicalize(mission.repository.path)
      this.git.assertRepositorySnapshot(repository, mission.repository)
      await this.git.assertClean(repository)
      baseCommit = await this.git.resolveBase(repository, mission.baseRef)
      repositorySnapshot = await this.git.repositorySnapshot(repository, mission.baseRef)
    } catch (error) {
      throw new ForgeyardDomainError('GIT_ERROR', errorText(error))
    }

    const attemptId = forgeyardId('attempt')
    const ordinal = retryOf === null ? 1 : retryOf.ordinal + 1
    let worktreePath: string
    try {
      worktreePath = await this.git.deterministicWorktreePath(repository, attemptId)
    } catch (error) {
      throw new ForgeyardDomainError('GIT_ERROR', errorText(error))
    }
    const createdAt = Date.now()
    const executionSnapshot: ExecutionSnapshot = {
      version: 1,
      attemptId,
      ordinal,
      task: structuredClone(task.specification),
      repository: structuredClone(repositorySnapshot),
      baseCommit,
      policy: structuredClone(mission.defaultPolicy),
      verification: structuredClone(task.specification.verification),
      createdAt,
    }
    return {
      repository,
      attempt: {
        id: attemptId,
        taskId: task.id,
        ordinal,
        executionSnapshot,
        executionSnapshotHash: hashRecord(executionSnapshot),
        baseCommit,
        worktreePath,
        worktreeDevice: null,
        worktreeInode: null,
        rawWorkspaceBaseline: null,
        rawWorkspaceBaselineHash: null,
        retryOfAttemptId: retryOf?.id ?? null,
        successorAttemptId: null,
        dshSessionId: `forgeyard-${randomUUID()}`,
        state: 'preparing',
        startedAt: null,
        endedAt: null,
        gitFingerprint: null,
        terminalReason: null,
        createdAt,
        updatedAt: createdAt,
      },
    }
  }

  /** Finish the two non-transactional edges after the preparing row is durable. */
  private async completeAttempt(planned: PlannedAttempt): Promise<AttemptView> {
    const { attempt, repository } = planned
    let prepared: PreparedWorktree
    try {
      prepared = await this.git.createWorktree(repository, attempt.baseCommit, attempt.id)
      this.store.bindWorktreeIdentity(
        attempt.id,
        String(prepared.device),
        String(prepared.inode),
        prepared.baselineManifest,
        prepared.baselineManifest.hash,
      )
      this.store.transition(attempt.id, 'worktree_ready')
    } catch (error) {
      this.markNeedsReview(attempt.id, boundedReason('Worktree preparation uncertain', error))
      throw new ForgeyardDomainError('GIT_ERROR', errorText(error))
    }

    try {
      await this.sessions.createAndPrompt(attempt.dshSessionId, prepared.path, attempt.executionSnapshot)
      this.store.transition(attempt.id, 'session_bound')
      this.store.transition(attempt.id, 'running', { startedAt: Date.now(), terminalReason: null })
    } catch (error) {
      this.markNeedsReview(attempt.id, boundedReason('DSH Session binding uncertain', error))
      throw new ForgeyardDomainError('DSH_ERROR', errorText(error))
    }
    return this.attemptViewUnqueued(attempt.id)
  }

  private markNeedsReview(attemptId: AttemptId, terminalReason: string): void {
    const current = this.store.attempt(attemptId)
    if (current === undefined || current.state === 'needs_review' || this.store.isTerminal(current.state)) return
    try {
      this.store.transition(attemptId, 'needs_review', { terminalReason })
    } catch {
      // The original external-operation error remains authoritative. A later
      // Host restart also fails any still-nonterminal phase to needs_review.
    }
  }

  async verifyAttempt(attemptId: AttemptId): Promise<AttemptView> {
    return this.enqueue(async () => {
      const candidate = this.requireAttempt(attemptId)
      if (!VERIFIABLE_STATES.has(candidate.state)) {
        throw new ForgeyardDomainError('INVALID_STATE', `Attempt ${candidate.id} cannot be verified from ${candidate.state}`)
      }
      let enteredVerification = false
      try {
        await this.sessions.runMaintenance(candidate.dshSessionId, async (signal) => {
          if (signal.aborted) throw new Error('DSH cancelled the verification maintenance phase')
          await this.sessions.assertFrozenExecution(
            candidate.dshSessionId,
            candidate.worktreePath,
            candidate.executionSnapshot,
          )
          if (signal.aborted) throw new Error('DSH cancelled the verification maintenance phase')
          const current = this.requireAttempt(candidate.id)
          if (!VERIFIABLE_STATES.has(current.state)) {
            throw new ForgeyardDomainError('INVALID_STATE', `Attempt ${current.id} cannot be verified from ${current.state}`)
          }
          this.store.transition(current.id, 'verifying', { terminalReason: null })
          enteredVerification = true
          const runId = forgeyardId('run')
          const prepared = await this.prepared(current)
          for (const requirement of current.executionSnapshot.verification) {
            if (signal.aborted) throw new Error('DSH cancelled the verification maintenance phase')
            const collected = await this.collector.collectCommand(current, requirement, runId, signal)
            this.store.appendEvidence(collected.evidence)
            this.store.appendVerification(collected.verification)
          }
          if (signal.aborted) throw new Error('DSH cancelled the verification maintenance phase')
          // Verifiers may legitimately write build products, caches, or coverage.
          // Git/raw-workspace Evidence must therefore describe the final reviewed
          // state after every command, not a pre-verification intermediate state.
          const gitEvidence = await this.collector.collectGit(current, prepared, runId)
          this.store.appendEvidence(gitEvidence)
          if (signal.aborted) throw new Error('DSH cancelled the verification maintenance phase')
          this.store.transition(current.id, 'awaiting_decision', {
            gitFingerprint: gitEvidence.payload.kind === 'git' ? gitEvidence.payload.fingerprint.digest : null,
            terminalReason: null,
          })
        })
      } catch (error) {
        if (enteredVerification && this.store.attempt(candidate.id)?.state === 'verifying') {
          this.markNeedsReview(candidate.id, boundedReason('Verification did not complete', error))
        }
        if (error instanceof ForgeyardDomainError) throw error
        throw new ForgeyardDomainError('VERIFICATION_REQUIRED', boundedReason('Verification did not complete', error))
      }
      return this.attemptViewUnqueued(candidate.id)
    })
  }

  async decide(request: DecisionRequest): Promise<AttemptView> {
    return this.enqueue(async () => {
      // Reject invalid human input before cancelling or draining any DSH work.
      requiredText('actor', request.actor, 500)
      requiredText('rationale', request.rationale, 10_000)
      const candidate = this.requireAttempt(request.attemptId)
      const allowed = request.type === 'APPROVE'
        ? candidate.state === 'awaiting_decision'
        : request.type === 'REJECT'
          ? RETRYABLE_STATES.has(candidate.state)
          : ['running', 'awaiting_decision', 'interrupted', 'needs_review'].includes(candidate.state)
      if (!allowed) {
        throw new ForgeyardDomainError('INVALID_STATE', `${request.type} is not valid from Attempt state ${candidate.state}.`)
      }

      try {
        await this.runTerminalAuthority(candidate, async (signal) => {
          if (signal.aborted) throw new Error('DSH cancelled the terminal maintenance phase')
          const current = this.requireAttempt(candidate.id)
          if (request.type === 'APPROVE') {
            await this.sessions.assertFrozenExecution(
              current.dshSessionId,
              current.worktreePath,
              current.executionSnapshot,
            )
          }
          if (signal.aborted) throw new Error('DSH cancelled the terminal maintenance phase')
          const review = await this.review(current)
          if (request.type === 'APPROVE' && !review.canApprove) {
            const code = review.approvalStale ? 'REVIEW_STALE' : 'VERIFICATION_REQUIRED'
            throw new ForgeyardDomainError(code, review.reason ?? 'Attempt cannot be approved')
          }
          if (signal.aborted) throw new Error('DSH cancelled the terminal maintenance phase')
          const decision = decisionRecord(request, request.type, review.reviewDigest)
          const state = request.type === 'APPROVE' ? 'approved' : request.type === 'REJECT' ? 'rejected' : 'cancelled'
          const reason = request.type === 'APPROVE'
            ? 'Approved for the exact recorded review digest.'
            : request.type === 'REJECT' ? 'Rejected by reviewer.' : 'Cancelled by operator.'
          this.store.recordDecisionAndTransition(decision, state, reason)
        })
      } catch (error) {
        // The public DSH terminal fence has a post-commit drain. If that final
        // drain fails, SQLite remains the terminal authority and the global
        // Host pre-step guard rejects any later model step for this Session.
        const persisted = this.store.attempt(candidate.id)
        if (persisted === undefined || !this.store.isTerminal(persisted.state)) {
          if (error instanceof ForgeyardDomainError) throw error
          throw new ForgeyardDomainError('DSH_ERROR', errorText(error))
        }
      }
      return this.attemptViewUnqueued(candidate.id)
    })
  }

  async retry(request: RetryRequest): Promise<AttemptView> {
    return this.enqueue(async () => {
      // Validation precedes Git preflight and the predecessor's terminal fence.
      requiredText('actor', request.actor, 500)
      requiredText('rationale', request.rationale, 10_000)
      const predecessor = this.requireAttempt(request.attemptId)
      if (!RETRYABLE_STATES.has(predecessor.state) || predecessor.successorAttemptId !== null) {
        throw new ForgeyardDomainError('INVALID_STATE', 'Retry requires the latest nonterminal reviewable Attempt.')
      }

      // Resolve repository identity/base and freeze the successor before the
      // predecessor is terminalized. A failed preflight leaves it untouched.
      const planned = await this.planAttempt(predecessor.taskId, predecessor)
      try {
        await this.runTerminalAuthority(predecessor, async (signal) => {
          if (signal.aborted) throw new Error('DSH cancelled the retry maintenance phase')
          const current = this.requireAttempt(predecessor.id)
          const review = await this.review(current)
          if (signal.aborted) throw new Error('DSH cancelled the retry maintenance phase')
          const decision = decisionRecord(request, 'RETRY', review.reviewDigest)
          this.store.recordRetryAndCreateSuccessor(
            decision,
            planned.attempt,
            'Retry requested; this Attempt remains immutable.',
          )
        })
      } catch (error) {
        // As with Decisions, accept an atomically committed retry even if the
        // fence's final drain reports an error after the SQLite commit.
        const persisted = this.store.attempt(planned.attempt.id)
        if (persisted === undefined || this.store.attempt(predecessor.id)?.successorAttemptId !== persisted.id) {
          if (error instanceof ForgeyardDomainError) throw error
          throw new ForgeyardDomainError('DSH_ERROR', errorText(error))
        }
      }
      return this.completeAttempt(planned)
    })
  }

  /**
   * Promote one approved Attempt into a durable Forgeyard-owned local Git ref.
   *
   * Promotion is deliberately separate from approval: `APPROVE` authorizes a
   * reviewed state, and only this explicit operator action turns that state
   * into a durable output. It never touches the Attempt's DSH Session. The
   * terminal Decision already cancelled and drained that execution tree and the
   * global pre-step guard rejects its later model steps, so re-entering
   * maintenance would resume a sealed Session instead of fencing anything.
   * Filesystem drift after that boundary is detected by the live fingerprint,
   * which is exactly the guarantee the review model claims.
   */
  async promote(request: PromoteRequest): Promise<AttemptView> {
    return this.enqueue(async () => {
      const actor = requiredText('actor', request.actor, 500)
      const rationale = requiredText('rationale', request.rationale, 10_000)
      const confirmed = requiredText('confirmed review digest', request.expectedReviewDigest, 200)
      if (!/^[0-9a-f]{64}$/u.test(confirmed)) {
        throw new ForgeyardDomainError('INVALID_REQUEST', 'The confirmed review digest must be a sha256 hex digest.')
      }
      // A promotion left uncertain by an interrupted Host must be reconciled
      // against its Git ref before this Attempt can be promoted again.
      await this.reconcilePromotionsUnqueued(request.attemptId)

      const attempt = this.requireAttempt(request.attemptId)
      const review = await this.review(attempt)
      const eligibility = await this.promotionEligibility(attempt, review)
      if (!eligibility.eligible || eligibility.decisionId === null || eligibility.plannedRef === null) {
        throw new ForgeyardDomainError('PROMOTION_BLOCKED', eligibility.reason ?? 'This Attempt cannot be promoted.')
      }
      const decision = this.store.decisions(attempt.id).find(item => item.id === eligibility.decisionId)
      if (decision === undefined) throw new ForgeyardDomainError('PROMOTION_BLOCKED', 'The approved Decision is no longer readable.')
      if (decision.reviewDigest !== confirmed) {
        throw new ForgeyardDomainError(
          'PROMOTION_BLOCKED',
          'The confirmed review digest does not match this Attempt\'s approved review digest; promotion was refused.',
        )
      }
      const task = this.store.task(attempt.taskId)
      if (task === undefined) throw new ForgeyardDomainError('NOT_FOUND', 'The promoted Attempt references a missing Task.')
      const runId = review.latestRunId
      if (runId === null) throw new ForgeyardDomainError('PROMOTION_BLOCKED', 'The approved review has no trusted Evidence run.')
      const runEvidence = this.store.evidence(attempt.id).filter(item => item.runId === runId)
      const runVerifications = this.store.verifications(attempt.id).filter(item => item.runId === runId)
      const gitEvidence = runEvidence.find(item => item.kind === 'git')
      if (gitEvidence === undefined || gitEvidence.payload.kind !== 'git') {
        throw new ForgeyardDomainError('PROMOTION_BLOCKED', 'The approved review has no trusted Git Evidence.')
      }
      const reviewed = gitEvidence.payload.fingerprint

      let prepared: PreparedWorktree
      try {
        prepared = await this.prepared(attempt)
        await this.git.assertBaseCheckoutSnapshot(prepared.repository, attempt.executionSnapshot.repository)
      } catch (error) {
        throw new ForgeyardDomainError('GIT_ERROR', boundedReason('The approved Attempt worktree is not promotable', error))
      }

      const planned = await this.planPromotion({
        attempt, task, decision, prepared, reviewed, runEvidence, runVerifications, actor, rationale,
        ref: eligibility.plannedRef,
      })

      // Durable intent precedes the ref. `BEGIN IMMEDIATE` plus the partial
      // unique indexes make a concurrent promotion of the same Attempt or ref
      // lose here rather than racing Git's ref transaction.
      try {
        this.store.insertPendingPromotion(planned.record)
      } catch (error) {
        throw new ForgeyardDomainError('PROMOTION_BLOCKED', boundedReason('This Attempt could not enter promotion', error))
      }
      // A durable pending row now exists. If this Host dies here, or the write
      // outcome stays unknown, its lease is the only thing that can unblock the
      // Attempt — so the reconciliation that consumes it is armed immediately.
      this.scheduleLeaseReconciliation()
      try {
        await this.git.createPromotionRef(prepared.repository.path, planned.record.outputRef, planned.record.outputCommit)
      } catch (error) {
        // Git can commit its ref transaction and still fail the call that ran
        // it — a timeout or a lost subprocess result after the ref landed. The
        // error alone therefore proves nothing about whether a durable output
        // exists, and recording `failed` here would file an existing output as
        // a failure and release the uniqueness constraint onto a ref nothing
        // knows about. Only the ref itself can settle this.
        return await this.settleUncertainRefWrite(
          attempt, prepared, planned.record, 'The Forgeyard promotion ref was not created', error,
        )
      }
      try {
        const written = await this.git.readPromotionRef(prepared.repository.path, planned.record.outputRef)
        if (written !== planned.record.outputCommit) {
          throw new Error(`the ref resolves to ${written ?? 'nothing'} instead of the promoted commit`)
        }
      } catch (error) {
        return await this.settleUncertainRefWrite(
          attempt, prepared, planned.record,
          'The Forgeyard promotion ref did not read back as the promoted commit; inspect it manually',
          error,
        )
      }
      // The lease makes a concurrent settlement unreachable for a live Host, but
      // a settlement this Host did not perform is never overwritten. The ref read
      // back as this promotion's exact commit, so an existing `promoted` record
      // is the same outcome and stands.
      this.settleReconciled(planned.record.id, 'promoted', null)
      if (this.store.promotion(planned.record.id)?.status !== 'promoted') {
        throw new ForgeyardDomainError(
          'PROMOTION_BLOCKED',
          `${planned.record.outputRef} holds this promotion's commit ${planned.record.outputCommit}, but the Promotion was settled as failed elsewhere; inspect the ref before promoting again.`,
        )
      }
      return this.attemptViewUnqueued(attempt.id)
    })
  }

  /**
   * How long a recorded promotion intent stays owned by the Host that wrote it.
   *
   * Between the durable intent and its settlement Forgeyard runs exactly two
   * Git commands — `update-ref` and `rev-parse` — and every Git invocation is
   * hard-bounded by `commandTimeoutMs`. A lease of twice that bound plus a
   * margin therefore cannot expire while a live Host is still in flight, and it
   * caps how long an abandoned intent blocks its Attempt after a Host dies.
   */
  private promotionLeaseMs(): number {
    return 2 * this.git.config.commandTimeoutMs + PROMOTION_LEASE_MARGIN_MS
  }

  /**
   * Resolve a promotion whose ref write left the durable outcome unknown.
   *
   * The ref is the only authority: it either names this promotion's exact
   * deterministic commit — in which case the write landed and the approved
   * deliverable is durable — or it is absent, or it holds something Forgeyard
   * must never overwrite. When even reading it fails, the Promotion stays
   * `pending` and its lease hands the question to reconciliation instead of
   * guessing an answer in either direction.
   */
  private async settleUncertainRefWrite(
    attempt: AttemptRecord,
    prepared: PreparedWorktree,
    record: PromotionRecord,
    prefix: string,
    cause: unknown,
  ): Promise<AttemptView> {
    let observed: string | null
    try {
      observed = await this.git.readPromotionRef(prepared.repository.path, record.outputRef)
    } catch {
      throw new ForgeyardDomainError('GIT_ERROR', boundedReason(
        `${prefix}, and the ref could not be read back. This Promotion stays uncertain until Forgeyard reconciles it against the ref`,
        cause,
      ))
    }
    if (observed === record.outputCommit) {
      this.settleReconciled(record.id, 'promoted', null)
      return this.attemptViewUnqueued(attempt.id)
    }
    const reason = observed === null
      ? prefix
      : `${prefix}: ${record.outputRef} resolves to ${observed} instead of this promotion's commit ${record.outputCommit}`
    this.failPromotion(record.id, reason, cause)
    throw new ForgeyardDomainError('GIT_ERROR', boundedReason(reason, cause))
  }

  /**
   * Settle a Promotion, accepting a settlement another Host wrote first.
   *
   * Two Hosts can read the same expired pending row and the same ref before
   * either settles it. A Promotion settles exactly once, by whoever gets there
   * first; the loser must report that authoritative outcome rather than fail,
   * which would abort a boot reconciliation or a `promote` request over a
   * question that is already answered. Returns whether this Host settled it.
   */
  private settleReconciled(id: PromotionId, status: 'promoted' | 'failed', failureReason: string | null): boolean {
    try {
      this.store.settlePromotion(id, status, failureReason)
      return true
    } catch (error) {
      // Only a row that is still pending means this was a real write failure.
      if (this.store.promotion(id)?.status === 'pending') throw error
      return false
    }
  }

  /**
   * Record why a promotion failed without ever replacing the failure itself.
   * A Promotion left pending because this write also failed is settled by the
   * next reconciliation against its durable Git ref.
   */
  private failPromotion(id: string, prefix: string, cause: unknown): void {
    try {
      this.store.settlePromotion(id, 'failed', boundedReason(prefix, cause))
    } catch {
      // The original failure remains authoritative.
    }
  }

  /**
   * Compute the projection, write the promoted objects, and prove they are the
   * declared deliverable — all before any Forgeyard ref exists. Unreferenced
   * Git objects are inert, so a failure here leaves no durable output at all.
   */
  private async planPromotion(input: {
    attempt: AttemptRecord
    task: TaskRecord
    decision: DecisionRecord
    prepared: PreparedWorktree
    reviewed: GitFingerprint
    runEvidence: EvidenceRecord[]
    runVerifications: VerificationRecord[]
    actor: string
    rationale: string
    ref: string
  }): Promise<{ record: PromotionRecord }> {
    const { attempt, task, decision, prepared, reviewed } = input
    let view: PromotionGitView
    try {
      view = await this.git.promotionView(prepared)
    } catch (error) {
      throw new ForgeyardDomainError('GIT_ERROR', boundedReason('The approved Attempt worktree could not be read', error))
    }
    if (view.fingerprint.digest !== reviewed.digest || view.manifest.hash !== reviewed.workspaceHash
      || view.fingerprint.baseCommit !== attempt.baseCommit) {
      throw new ForgeyardDomainError(
        'REVIEW_STALE',
        'The Attempt worktree no longer matches the approved review fingerprint; promotion was refused.',
      )
    }

    let projected: PromotionProjectionResult
    let tree: string
    try {
      projected = await this.projector.project(prepared.path, view)
      const written = await this.git.writePromotionTree(prepared, attempt.id, projected.promotedPaths)
      assertTreeMatchesProjection(projected.promotedEntries, written.entries)
      assertTreeMatchesProjection(projected.promotedEntries, await this.git.readTreeEntries(prepared, written.tree))
      tree = written.tree
    } catch (error) {
      throw new ForgeyardDomainError(
        'PROMOTION_BLOCKED',
        boundedReason('The approved deliverable could not be projected onto an exact Git tree', error),
      )
    }

    const evidenceDigest = sha256(input.runEvidence.map(item => item.hash).join('\0'))
    const verificationDigest = sha256(input.runVerifications.map(item => item.hash).join('\0'))
    const projection = projected.projection
    const message = [
      `forgeyard: promote attempt ${String(attempt.ordinal)} (${attempt.id})`,
      '',
      'Forgeyard-owned local promotion of one reviewed Attempt. This commit carries',
      'only the Git-representable projection of the reviewed workspace; the projection',
      'ledger records every reviewed entry Git cannot carry.',
      '',
      'Forgeyard-Projection-Version: 1',
      `Forgeyard-Attempt: ${attempt.id}`,
      `Forgeyard-Attempt-Ordinal: ${String(attempt.ordinal)}`,
      `Forgeyard-Task: ${task.id}`,
      `Forgeyard-Mission: ${task.missionId}`,
      `Forgeyard-Task-Title: ${trailerText(task.specification.title)}`,
      `Forgeyard-Base-Commit: ${attempt.baseCommit}`,
      `Forgeyard-Worktree-Head: ${view.headCommit}`,
      `Forgeyard-Execution-Snapshot: ${attempt.executionSnapshotHash}`,
      `Forgeyard-Decision: ${decision.id}`,
      `Forgeyard-Review-Digest: ${decision.reviewDigest}`,
      `Forgeyard-Evidence-Digest: ${evidenceDigest}`,
      `Forgeyard-Verification-Digest: ${verificationDigest}`,
      `Forgeyard-Projection-Hash: ${projection.hash}`,
      `Forgeyard-Promoted-Entries: ${String(projection.promoted.count)}`,
      `Forgeyard-Excluded-Entries: ${String(projection.excluded.count)}`,
      '',
    ].join('\n')

    let commit: string
    try {
      commit = await this.git.createPromotionCommit(prepared, tree, attempt.baseCommit, message, {
        ...PROMOTION_IDENTITY,
        // A pinned identity and the approval instant make the same approved
        // deliverable always name the same commit, so a repeated or recovered
        // promotion is comparable instead of merely similar.
        epochSeconds: Math.floor(decision.createdAt / 1000),
      })
      if (await this.git.readCommitTree(prepared, commit) !== tree) {
        throw new Error('the promotion commit does not carry the promoted tree')
      }
      // Nothing may have moved while the objects were written. Everything after
      // this point only creates and reads back the Forgeyard-owned ref.
      const settled = await this.git.liveFingerprint(prepared)
      if (settled.digest !== reviewed.digest) throw new Error('the Attempt worktree changed while it was promoted')
      await this.git.assertBaseCheckoutSnapshot(prepared.repository, attempt.executionSnapshot.repository)
    } catch (error) {
      throw new ForgeyardDomainError('GIT_ERROR', boundedReason('The promotion commit could not be proven', error))
    }

    const core = {
      attemptId: attempt.id,
      decisionId: decision.id,
      reviewDigest: decision.reviewDigest,
      executionSnapshotHash: attempt.executionSnapshotHash,
      baseCommit: attempt.baseCommit,
      worktreeHead: view.headCommit,
      evidenceDigest,
      verificationDigest,
      projectionHash: projection.hash,
      objectFormat: view.objectFormat,
      outputRef: input.ref,
      outputCommit: commit,
      outputTree: tree,
      actor: input.actor,
      rationale: input.rationale,
      createdAt: Date.now(),
    }
    const record: PromotionRecord = {
      id: forgeyardId('promotion'),
      ...core,
      projection,
      status: 'pending',
      failureReason: null,
      hash: hashRecord(promotionCore(core)),
      leaseExpiresAt: core.createdAt + this.promotionLeaseMs(),
      settledAt: null,
    }
    return { record }
  }

  /**
   * Settle promotions that an interrupted Host left uncertain by comparing the
   * durable Forgeyard ref with the deterministic commit the record names.
   * Forgeyard never infers success and never rewrites an existing ref.
   */
  async reconcilePromotions(): Promise<number> {
    return this.enqueue(() => this.reconcilePromotionsUnqueued(null))
  }

  private async reconcilePromotionsUnqueued(attemptId: AttemptId | null): Promise<number> {
    const now = Date.now()
    const pending = this.store.pendingPromotions()
      .filter(record => attemptId === null || record.attemptId === attemptId)
    let settled = 0
    for (const promotion of pending) {
      // A recorded intent whose lease is still live belongs to a Host that may
      // be inside `createPromotionRef` right now. Reading no ref there proves
      // nothing, and failing the row would release the uniqueness constraint
      // while that Host goes on to create a durable ref it can no longer
      // settle. Only an expired lease distinguishes an abandoned intent from a
      // promotion still in flight, so a leased Promotion is left untouched and
      // keeps reporting as uncertain.
      if (promotion.leaseExpiresAt > now) continue
      const attempt = this.store.attempt(promotion.attemptId)
      if (attempt === undefined) continue
      try {
        // A Promotion whose stored authority does not verify is never settled
        // from a ref. It stays pending and keeps the Attempt blocked.
        assertPromotionRecordIntegrity(promotion)
      } catch {
        continue
      }
      let observed: string | null
      try {
        const repository = await this.git.canonicalize(attempt.executionSnapshot.repository.path)
        this.git.assertRepositorySnapshot(repository, attempt.executionSnapshot.repository)
        observed = await this.git.readPromotionRef(repository.path, promotion.outputRef)
      } catch {
        // The repository is unreadable right now. The Promotion stays pending
        // and the Cockpit reports it as uncertain rather than guessing.
        continue
      }
      const wrote = observed === promotion.outputCommit
        ? this.settleReconciled(promotion.id, 'promoted', null)
        : observed === null
          ? this.settleReconciled(
            promotion.id,
            'failed',
            'Forgeyard was interrupted before this promotion created its Git ref. No durable output exists, so the Attempt may be promoted again.',
          )
          : this.settleReconciled(
            promotion.id,
            'failed',
            `${promotion.outputRef} already resolves to ${observed} instead of this promotion's commit ${promotion.outputCommit}. Inspect the ref before promoting again.`,
          )
      if (wrote) settled += 1
    }
    // Anything still pending is either leased or unsettleable right now. Either
    // way the next pass is armed here rather than waiting for a Host restart.
    this.scheduleLeaseReconciliation()
    return settled
  }

  /** Whether this exact Attempt may be promoted right now, and why not. */
  private async promotionEligibility(attempt: AttemptRecord, review: ReviewState): Promise<PromotionEligibility> {
    const promotions = this.store.promotions(attempt.id)
    const active = promotions.find(record => record.status !== 'failed')
    const decision = this.store.decisions(attempt.id).find(record => record.type === 'APPROVE')
    let plannedRef: string | null = null
    try {
      plannedRef = GitAuthority.promotionRef(attempt.id)
    } catch {
      plannedRef = null
    }
    const base: PromotionEligibility = {
      status: 'blocked',
      eligible: false,
      reason: null,
      reviewDigest: decision?.reviewDigest ?? null,
      decisionId: decision?.id ?? null,
      plannedRef,
      promotionId: active?.id ?? null,
      outputRef: active?.outputRef ?? null,
      outputCommit: active?.outputCommit ?? null,
      failureReason: (active ?? promotions.at(-1))?.failureReason ?? null,
    }
    if (active !== undefined) {
      try {
        assertPromotionRecordIntegrity(active)
      } catch (error) {
        return { ...base, reason: `The recorded Promotion authority is invalid: ${errorText(error)}` }
      }
    }
    if (active?.status === 'promoted') {
      // A completed record is not self-certifying. The SQLite row and the ref
      // are two independent facts, and anyone with write access to the
      // repository can delete or move a `refs/forgeyard/` ref outside
      // Forgeyard. Naming a durable output that is gone, or that now points
      // somewhere else, would advertise a deliverable Forgeyard cannot produce.
      let observed: string | null
      try {
        const repository = await this.git.canonicalize(attempt.executionSnapshot.repository.path)
        observed = await this.git.readPromotionRef(repository.path, active.outputRef)
      } catch (error) {
        // Unreadable right now is not the same as diverged, and is not asserted
        // as either. The record stands and says it was not re-verified.
        return {
          ...base,
          status: 'promoted',
          reason: `This Attempt was already promoted to ${active.outputRef} at ${active.outputCommit}. The ref could not be read to confirm it right now: ${errorText(error)}`,
        }
      }
      if (observed !== active.outputCommit) {
        return {
          ...base,
          status: 'diverged',
          reason: observed === null
            ? `This Attempt was promoted to ${active.outputRef} at ${active.outputCommit}, but that ref no longer exists. Forgeyard reports the disagreement and will not recreate it; inspect the repository before relying on this record.`
            : `This Attempt was promoted to ${active.outputRef} at ${active.outputCommit}, but that ref now resolves to ${observed}. Forgeyard reports the disagreement and never overwrites the ref; inspect it before relying on this record.`,
        }
      }
      return {
        ...base,
        status: 'promoted',
        reason: `This Attempt was already promoted to ${active.outputRef} at ${active.outputCommit}.`,
      }
    }
    if (active?.status === 'pending') {
      return {
        ...base,
        status: 'uncertain',
        reason: active.leaseExpiresAt > Date.now()
          ? 'A promotion of this Attempt holds a live lease, so Forgeyard will not start a second one. It reconciles against its Git ref once the lease lapses.'
          : 'A previous promotion did not settle. Forgeyard reconciles it against its Git ref before this Attempt can be promoted again.',
      }
    }
    if (attempt.state !== 'approved') {
      return { ...base, reason: `Only an Attempt with a terminal APPROVE Decision can be promoted; this Attempt is ${attempt.state}.` }
    }
    if (decision === undefined) return { ...base, reason: 'This Attempt has no terminal APPROVE Decision.' }
    if (!review.reviewedStateCurrent) {
      return { ...base, reason: review.reason ?? 'The approved reviewed state is no longer current.' }
    }
    if (review.reviewDigest !== decision.reviewDigest) {
      return { ...base, reason: 'The live review digest no longer matches the approved review digest; promotion was refused.' }
    }
    if (plannedRef === null) return { ...base, reason: 'This Attempt identifier cannot address a Forgeyard promotion ref.' }
    return { ...base, status: 'eligible', eligible: true, reason: null }
  }

  async snapshot(): Promise<ForgeyardSnapshot> {
    return this.enqueue(() => this.snapshotUnqueued())
  }

  private async snapshotUnqueued(): Promise<ForgeyardSnapshot> {
    const missions: MissionView[] = []
    for (const mission of this.store.missions()) missions.push(await this.missionViewUnqueued(mission.id))
    return { schemaVersion: 3, dshVersion: this.config.dshVersion, missions }
  }

  async attemptForSession(sessionId: string): Promise<AttemptSessionRef | null> {
    return this.enqueue(async () => {
      const attempt = this.store.attemptBySession(sessionId)
      if (attempt === undefined) return null
      const task = this.store.task(attempt.taskId)
      if (task === undefined) throw new Error('Attempt references a missing Task')
      return { attemptId: attempt.id, taskId: task.id, missionId: task.missionId, ordinal: attempt.ordinal }
    })
  }

  async missionView(missionId: MissionId): Promise<MissionView> {
    return this.enqueue(() => this.missionViewUnqueued(missionId))
  }

  private async missionViewUnqueued(missionId: MissionId): Promise<MissionView> {
    const mission = this.store.mission(missionId)
    if (mission === undefined) throw new ForgeyardDomainError('NOT_FOUND', `Mission ${missionId} was not found`)
    const task = this.store.taskForMission(mission.id)
    if (task === undefined) throw new Error('Mission has no materialized Task')
    const attempts: AttemptView[] = []
    for (const attempt of this.store.attemptsForTask(task.id)) attempts.push(await this.attemptViewUnqueued(attempt.id))
    return { mission, task, attempts, derivedState: attempts.at(-1)?.attempt.state ?? 'ready' }
  }

  async attemptView(attemptId: AttemptId): Promise<AttemptView> {
    return this.enqueue(() => this.attemptViewUnqueued(attemptId))
  }

  private async attemptViewUnqueued(attemptId: AttemptId): Promise<AttemptView> {
    const attempt = this.requireAttempt(attemptId)
    const review = await this.review(attempt)
    return {
      attempt,
      evidence: this.store.evidence(attempt.id),
      verifications: this.store.verifications(attempt.id),
      decisions: this.store.decisions(attempt.id),
      review,
      promotions: this.store.promotions(attempt.id),
      promotion: await this.promotionEligibility(attempt, review),
    }
  }

  private requireAttempt(id: AttemptId): AttemptRecord {
    const attempt = this.store.attempt(id)
    if (attempt === undefined) throw new ForgeyardDomainError('NOT_FOUND', `Attempt ${id} was not found`)
    return attempt
  }

  private async prepared(attempt: AttemptRecord): Promise<PreparedWorktree> {
    assertAttemptRecordIntegrity(attempt)
    const repository = await this.git.canonicalize(attempt.executionSnapshot.repository.path)
    this.git.assertRepositorySnapshot(repository, attempt.executionSnapshot.repository)
    if (attempt.worktreeDevice === null || attempt.worktreeInode === null
      || attempt.rawWorkspaceBaseline === null || attempt.rawWorkspaceBaselineHash === null) {
      throw new Error('Attempt has no complete durable worktree identity and raw baseline binding')
    }
    return {
      path: attempt.worktreePath,
      repository,
      baseCommit: attempt.baseCommit,
      device: BigInt(attempt.worktreeDevice),
      inode: BigInt(attempt.worktreeInode),
      baselineManifest: structuredClone(attempt.rawWorkspaceBaseline),
    }
  }

  private async review(attempt: AttemptRecord): Promise<ReviewState> {
    const evidence = this.store.evidence(attempt.id)
    const latestRunId = this.store.latestEvidenceRunId(attempt.id)
    const runEvidence = latestRunId === null ? [] : evidence.filter(item => item.runId === latestRunId)
    const runVerifications = latestRunId === null
      ? []
      : this.store.verifications(attempt.id).filter(item => item.runId === latestRunId)
    const gitEvidence = runEvidence.find(item => item.kind === 'git')
    let integrityError: string | null = null
    try {
      assertAttemptRecordIntegrity(attempt)
      if (latestRunId !== null) this.store.assertReviewRecordIntegrity(attempt.id, latestRunId)
    } catch (error) {
      integrityError = errorText(error)
    }

    let liveGitFingerprint = 'unavailable'
    let approvalStale = true
    let liveError: string | null = null
    let baseError: string | null = null
    if (integrityError === null && gitEvidence?.payload.kind === 'git') {
      try {
        const prepared = await this.prepared(attempt)
        try {
          await this.git.assertBaseCheckoutSnapshot(prepared.repository, attempt.executionSnapshot.repository)
        } catch (error) {
          baseError = errorText(error)
        }
        const live = await this.git.liveFingerprint(prepared)
        liveGitFingerprint = live.digest
        approvalStale = gitEvidence.payload.fingerprint.digest !== live.digest
          || attempt.gitFingerprint !== gitEvidence.payload.fingerprint.digest
        if (baseError !== null) approvalStale = true
      } catch (error) {
        liveError = errorText(error)
      }
    }

    const required = attempt.executionSnapshot.verification.length
    const passing = runVerifications.filter(record => record.status === 'PASS').length
    const allEvidenceComplete = runEvidence.length > 0
      && runEvidence.every(record => record.completeness === 'COMPLETE')
    const exactRequirements = runVerifications.length === required
      && runVerifications.every((record, index) => record.requirementIndex === index
        && canonicalJson(record.requirement) === canonicalJson(attempt.executionSnapshot.verification[index]))
    const digest = sha256([
      'forgeyard.review.v1',
      attempt.executionSnapshotHash,
      liveGitFingerprint,
      ...runEvidence.map(record => record.hash),
      ...runVerifications.map(record => record.hash),
    ].join('\0'))
    // Whether the recorded review still describes the live state exactly. It is
    // deliberately independent of Attempt state so a terminal Attempt can be
    // revalidated before promotion without re-deriving approvability.
    const reviewedStateCurrent = integrityError === null && liveError === null && baseError === null
      && !approvalStale && allEvidenceComplete && exactRequirements && passing === required
    const canApprove = attempt.state === 'awaiting_decision' && reviewedStateCurrent

    let reason: string | null = null
    if (integrityError !== null) reason = `Stored review authority is invalid: ${integrityError}`
    else if (latestRunId === null) reason = 'No trusted Evidence has been collected.'
    else if (baseError !== null) reason = `The original base checkout changed: ${baseError}`
    else if (liveError !== null) reason = `Live Git state is unavailable: ${liveError}`
    else if (approvalStale) reason = 'The worktree or recorded fingerprint changed after Evidence collection; review is stale.'
    else if (!allEvidenceComplete) reason = 'Evidence collection is incomplete.'
    else if (!exactRequirements || passing !== required) reason = 'All frozen verification requirements must be complete and PASS.'
    else if (attempt.state !== 'awaiting_decision') reason = `Attempt state ${attempt.state} is not approvable.`
    return {
      reviewDigest: digest,
      liveGitFingerprint,
      latestRunId,
      requiredVerificationCount: required,
      passingVerificationCount: passing,
      canApprove,
      reviewedStateCurrent,
      approvalStale,
      reason,
    }
  }
}
