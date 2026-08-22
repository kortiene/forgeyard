import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  AttemptId,
  AttemptRecord,
  AttemptSessionRef,
  AttemptView,
  DecisionRecord,
  DecisionRequest,
  ExecutionSnapshot,
  ForgeyardSnapshot,
  MissionCreateRequest,
  MissionId,
  MissionRecord,
  MissionView,
  ReviewState,
  RetryRequest,
  TaskId,
  TaskRecord,
} from '../types.ts'
import { parseCommandLine } from './command-line.ts'
import type { TrustedEvidenceCollector } from './evidence.ts'
import type { SessionGateway } from './execution.ts'
import type { CanonicalRepository, GitAuthority, PreparedWorktree } from './git.ts'
import { canonicalJson, forgeyardId, hashRecord, sha256 } from './hash.ts'
import { assertAttemptRecordIntegrity, type ForgeyardStore } from './store.ts'

export class ForgeyardDomainError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'INVALID_STATE' | 'GIT_ERROR' | 'DSH_ERROR' | 'VERIFICATION_REQUIRED' | 'REVIEW_STALE',
    message: string,
  ) {
    super(message)
  }
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

  constructor(
    readonly store: ForgeyardStore,
    readonly git: GitAuthority,
    readonly sessions: SessionGateway,
    readonly collector: TrustedEvidenceCollector,
    readonly config: EngineConfig,
  ) {}

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

  async snapshot(): Promise<ForgeyardSnapshot> {
    return this.enqueue(() => this.snapshotUnqueued())
  }

  private async snapshotUnqueued(): Promise<ForgeyardSnapshot> {
    const missions: MissionView[] = []
    for (const mission of this.store.missions()) missions.push(await this.missionViewUnqueued(mission.id))
    return { schemaVersion: 2, dshVersion: this.config.dshVersion, missions }
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
    return {
      attempt,
      evidence: this.store.evidence(attempt.id),
      verifications: this.store.verifications(attempt.id),
      decisions: this.store.decisions(attempt.id),
      review: await this.review(attempt),
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
    const canApprove = attempt.state === 'awaiting_decision' && integrityError === null
      && liveError === null && baseError === null && !approvalStale && allEvidenceComplete
      && exactRequirements && passing === required

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
      approvalStale,
      reason,
    }
  }
}
