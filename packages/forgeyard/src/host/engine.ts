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
  MissionRollupState,
  MissionView,
  PromoteRequest,
  PromotionEligibility,
  PromotionId,
  PromotionRecord,
  ReviewState,
  RetryRequest,
  TaskId,
  TaskNodeView,
  TaskReadiness,
  TaskRecord,
  VerificationRecord,
} from '../types.ts'
import { parseCommandLine } from './command-line.ts'
import type { TrustedEvidenceCollector } from './evidence.ts'
import type { SessionGateway } from './execution.ts'
import {
  GitAuthority,
  PromotionRefDisagreement,
  RepositoryIdentityMismatch,
  type CanonicalRepository,
  type PreparedWorktree,
  type PromotionGitView,
} from './git.ts'
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
 * Bounded Git commands between the durable intent and its settlement, each one
 * capped separately by `commandTimeoutMs`:
 *
 *   2  `createPromotionRef`:  `symbolic-ref`, `update-ref`
 *   3  `readPromotionRef`:    `symbolic-ref`, `rev-parse`, `rev-list`
 *   3  headroom for the failure path, which probes and reads before settling
 *
 * The pre-write identity check deliberately spends none of this: it compares
 * filesystem identity rather than re-canonicalizing, which would have added
 * eighteen more commands and tripled the lease.
 *
 * Counted rather than asserted. This budget was written when the path really
 * was two commands long and silently fell behind as commands were added — and a
 * hand count while fixing that was off by more than double — so a test now walks
 * a real promotion and fails if the commands it observes outnumber this.
 * Budgeting fewer than the code runs would let a peer settle the row mid-flight,
 * which is the disagreement the lease exists to stop.
 */
export const PROMOTION_POST_INTENT_GIT_COMMANDS = 8

/**
 * How long to wait before looking again at a Promotion whose lease has already
 * lapsed but which still could not be settled — an unreadable repository, say.
 * It only bounds a retry; it never shortens the lease itself.
 */
export const PROMOTION_RECONCILE_RETRY_MS = 60_000

/**
 * How often a Host with nothing pending of its own looks again. Several Hosts
 * can share one database, so a Promotion this Host never inserted — and whose
 * owner died with its timer — is only ever found by looking.
 */
export const PROMOTION_IDLE_POLL_MS = 60_000

function trailerText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 200)
}

function requiredText(name: string, value: unknown, max = 20_000): string {
  if (typeof value !== 'string') throw new ForgeyardDomainError('INVALID_REQUEST', `${name} must be text`)
  const text = value.trim()
  if (text.length === 0) throw new ForgeyardDomainError('INVALID_REQUEST', `${name} is required`)
  if (Buffer.byteLength(text) > max) throw new ForgeyardDomainError('INVALID_REQUEST', `${name} is too large`)
  // SQLite stores an unpaired UTF-16 surrogate as U+FFFD. Text hashed before
  // that write can therefore never match the text read back, so a Promotion
  // carrying one would create its durable Git ref and then fail its own
  // integrity check forever — reporting invalid authority over a real output.
  // Refusing the input is the only point at which that is still recoverable.
  if (!text.isWellFormed()) {
    throw new ForgeyardDomainError('INVALID_REQUEST', `${name} contains unpaired UTF-16 surrogates`)
  }
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
  /**
   * How long to wait before retrying a Promotion whose lease has lapsed but
   * which still could not be settled. Defaults to `PROMOTION_RECONCILE_RETRY_MS`.
   */
  reconcileRetryMs?: number
  /**
   * How often to look for a pending Promotion this Host did not insert.
   * Defaults to `PROMOTION_IDLE_POLL_MS`.
   */
  idlePollMs?: number
}

interface PlannedAttempt {
  attempt: AttemptRecord
  repository: CanonicalRepository
}

/** One dependency edge's resolved state: satisfied by a re-verified promoted output, or not. */
type DependencySatisfaction =
  | { satisfied: true; baseCommit: string; baseFromAttemptId: AttemptId }
  | { satisfied: false; status: 'blocked' | 'dead'; reason: string }

interface ValidatedMissionNode {
  key: string
  instruction: string
  verificationCommand: string
  verificationArgv: string[]
  dependsOn: string[]
}

/**
 * Validate the bounded serial Pipe before any repository or provider operation.
 * This slice accepts only one root node or one root plus one direct follow-up;
 * parallel edges and a generalized DAG are intentionally unrepresentable.
 */
function validateMissionNodes(input: unknown): ValidatedMissionNode[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 2) {
    throw new ForgeyardDomainError('INVALID_REQUEST', 'this slice materializes one or two serial nodes')
  }
  const nodes = input.map((value, index) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ForgeyardDomainError('INVALID_REQUEST', `node ${index + 1} must be an object`)
    }
    const candidate = value as Record<string, unknown>
    const key = requiredText(`node ${index + 1} key`, candidate.key, 200)
    const instruction = requiredText(`node ${key} task`, candidate.task)
    const verificationCommand = requiredText(
      `node ${key} verification command`, candidate.verificationCommand, 10_000,
    )
    if (!Array.isArray(candidate.dependsOn)) {
      throw new ForgeyardDomainError('INVALID_REQUEST', `node ${key} dependsOn must be an array`)
    }
    const dependsOn = candidate.dependsOn.map((dependency, dependencyIndex) =>
      requiredText(`node ${key} dependency ${dependencyIndex + 1}`, dependency, 200))
    let verificationArgv: string[]
    try {
      verificationArgv = parseCommandLine(verificationCommand)
    } catch (error) {
      throw new ForgeyardDomainError(
        'INVALID_REQUEST',
        `node ${key} verification command is invalid: ${errorText(error)}`,
      )
    }
    return { key, instruction, verificationCommand, verificationArgv, dependsOn }
  })

  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.key)) {
      throw new ForgeyardDomainError('INVALID_REQUEST', `node key ${node.key} is duplicated`)
    }
    seen.add(node.key)
  }
  if (nodes[0]?.dependsOn.length !== 0) {
    throw new ForgeyardDomainError('INVALID_REQUEST', 'the first serial node must have dependsOn: []')
  }
  if (nodes.length === 2) {
    const rootKey = nodes[0]?.key as string
    const followUp = nodes[1] as ValidatedMissionNode
    if (followUp.dependsOn.length !== 1 || followUp.dependsOn[0] !== rootKey) {
      throw new ForgeyardDomainError(
        'INVALID_REQUEST',
        `the second serial node must have dependsOn: [${JSON.stringify(rootKey)}]`,
      )
    }
  }
  return nodes
}

const VERIFIABLE_STATES = new Set(['running', 'awaiting_decision', 'interrupted', 'needs_review'])
const RETRYABLE_STATES = new Set(['awaiting_decision', 'interrupted', 'needs_review'])

const ACTIVE_STATES = new Set(['preparing', 'worktree_ready', 'session_bound', 'running', 'verifying'])

/**
 * The Mission rollup over every node, as a total first-match-wins rule.
 *
 * Attention-demanding states outrank quiescent ones, so a Mission never reports
 * `complete` or `ready` while any node still needs an operator. For a
 * single-node Mission this preserves the operational progression while
 * intentionally normalizing terminal labels (approved -> complete and
 * rejected/cancelled -> stopped).
 */
export function missionRollupState(nodes: TaskNodeView[]): MissionRollupState {
  const states = nodes.map(node => node.nodeState)
  if (states.some(state => ACTIVE_STATES.has(state))) return 'running'
  if (states.includes('awaiting_decision')) return 'awaiting_decision'
  if (states.some(state => state === 'needs_review' || state === 'interrupted')) return 'needs_review'
  if (nodes.some(node => node.readiness.status === 'dead')) return 'dead'
  if (states.some(state => state === 'rejected' || state === 'cancelled')) return 'stopped'
  if (states.length > 0 && states.every(state => state === 'approved')
    && nodes.every(node => node.readiness.status === 'ready')) return 'complete'
  if (nodes.some(node => node.readiness.startable)) return 'ready'
  return 'blocked'
}

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
   *
   * Finding nothing pending is not a reason to stop looking. Several Hosts can
   * share one database: a peer can insert a Promotion and die with its own
   * timer, and nothing pushes that row to this Host. Snapshots do not reconcile
   * and the Cockpit hides promotion while an Attempt is uncertain, so an idle
   * Host that dropped its timer would never discover the abandoned row.
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
    const remaining = earliest === null ? null : earliest - Date.now()
    const delay = remaining === null
      ? this.config.idlePollMs ?? PROMOTION_IDLE_POLL_MS
      : remaining > 0
        ? remaining + 1_000
        : this.config.reconcileRetryMs ?? PROMOTION_RECONCILE_RETRY_MS
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
      // Validate every request-controlled value and parse every verifier before
      // touching the repository or resolving provider policy. A malformed second
      // node must not observe Git or leave partially prepared authority behind.
      const title = requiredText('title', request.title, 1_000)
      const objective = requiredText('objective', request.objective)
      const repositoryPath = requiredText('repository path', request.repositoryPath)
      const baseRef = requiredText('base reference', request.baseRef, 1_000)
      const nodes = validateMissionNodes(request.nodes)
      if (!isAbsolute(repositoryPath)) {
        throw new ForgeyardDomainError('INVALID_REQUEST', 'repository path must be absolute')
      }

      let repository: CanonicalRepository
      try {
        repository = await this.git.canonicalize(repositoryPath)
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

      const materialized = nodes.map(node => ({
        node,
        taskId: forgeyardId('task'),
        requirement: {
          key: 'verify-1',
          command: node.verificationCommand,
          argv: node.verificationArgv,
        },
      }))
      const pipe = {
        nodes: materialized.map(({ node, requirement }) => ({
          key: node.key,
          task: node.instruction,
          verify: [requirement],
          // New Mission rows always carry the explicit edge. Optionality exists
          // only so legacy single-node snapshots with an absent field still read.
          dependsOn: [...node.dependsOn],
        })),
      }
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
      const taskIdByKey = new Map(materialized.map(({ node, taskId }) => [node.key, taskId]))
      const tasks: TaskRecord[] = materialized.map(({ node, taskId, requirement }) => ({
        id: taskId,
        missionId: mission.id,
        sourceNodeKey: node.key,
        specification: {
          title,
          objective,
          instruction: node.instruction,
          verification: [requirement],
        },
        dependencies: node.dependsOn.map((key) => {
          const dependencyId = taskIdByKey.get(key)
          if (dependencyId === undefined) throw new Error(`validated dependency ${key} has no Task ID`)
          return dependencyId
        }),
        createdAt: now,
      }))
      this.store.insertMissionAndTasks(mission, tasks)
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

  /**
   * The re-verified promoted output this Task must freeze as its base, or an
   * INVALID_STATE refusal carrying exactly the reason the Cockpit renders.
   *
   * Rebuilt live from the upstream node's AttemptViews, so admission and the
   * readiness projection can never disagree, and a dependency is admitted only
   * on output `promotionEligibility` would still advertise right now.
   */
  private async resolveDependencyBase(
    task: TaskRecord,
    mission: MissionRecord,
  ): Promise<{ baseCommit: string; baseFromAttemptId: AttemptId }> {
    const tasks = this.orderedMissionTasks(mission)
    const index = tasks.findIndex(candidate => candidate.id === task.id)
    if (index === -1) {
      throw new ForgeyardDomainError('INVALID_STATE', `Task ${task.id} is not part of Mission ${mission.id}.`)
    }
    const upstreamTasks = tasks.slice(0, index)

    const bases: Array<{ baseCommit: string; baseFromAttemptId: AttemptId }> = []
    for (const dependencyId of task.dependencies) {
      const dependency = upstreamTasks.find(candidate => candidate.id === dependencyId)
      if (dependency === undefined) {
        throw new ForgeyardDomainError(
          'INVALID_STATE',
          `This node's recorded dependencies do not resolve within its Mission: ${dependencyId}.`,
        )
      }
      const attempts: AttemptView[] = []
      for (const attempt of this.store.attemptsForTask(dependency.id)) {
        attempts.push(await this.attemptViewUnqueued(attempt.id))
      }
      const satisfaction = this.upstreamOutput(dependency, attempts)
      if (!satisfaction.satisfied) {
        throw new ForgeyardDomainError('INVALID_STATE', satisfaction.reason)
      }
      bases.push(satisfaction)
    }
    if (bases.length !== 1) {
      throw new ForgeyardDomainError(
        'INVALID_STATE',
        `This Task has ${bases.length} satisfied dependencies; only one propagated base is representable.`,
      )
    }
    const base = bases[0]
    if (base === undefined || base.baseCommit.length === 0) {
      throw new ForgeyardDomainError('INVALID_STATE', 'The upstream promoted output does not name a commit.')
    }
    return base
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

    // A dependency-bearing node freezes its re-verified upstream promoted
    // commit as its base — never the Mission base ref. The repository snapshot
    // still records the operator checkout, which is the same for every node;
    // this node's actual base lives in ExecutionSnapshot.baseCommit.
    let dependencyBase: { baseCommit: string; baseFromAttemptId: AttemptId } | null = null
    if (task.dependencies.length !== 0) {
      dependencyBase = await this.resolveDependencyBase(task, mission)
    }

    let repository: CanonicalRepository
    let baseCommit: string
    let repositorySnapshot: MissionRecord['repository']
    try {
      repository = await this.git.canonicalize(mission.repository.path)
      this.git.assertRepositorySnapshot(repository, mission.repository)
      await this.git.assertClean(repository)
      // For a dependency-bearing node this also proves the promoted commit is
      // still a readable commit object in this repository, so a pruned upstream
      // output fails admission rather than producing a worktree on nothing.
      baseCommit = await this.git.resolveBase(repository, dependencyBase?.baseCommit ?? mission.baseRef)
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
      // The repository at the authorized path can be replaced between planning
      // and this write. `prepared.repository` is a cached identity, so Git would
      // resolve the path afresh and create the ref inside the replacement — and
      // the completed-output check can report that afterwards but cannot undo it.
      try {
        // Filesystem identity only: see `assertRepositoryUnmoved`. The full
        // audit here would triple the commands the lease must budget for.
        await this.git.assertRepositoryUnmoved(prepared.repository)
        this.git.assertRepositorySnapshot(prepared.repository, attempt.executionSnapshot.repository)
      } catch (error) {
        const moved = 'The repository at the authorized path no longer matches the Attempt snapshot, so no promotion ref was written'
        this.failPromotion(planned.record.id, moved, error)
        throw new ForgeyardDomainError('GIT_ERROR', boundedReason(moved, error))
      }
      // Git's hard command timeout bounds time spent *inside* a Git call, not
      // time this Host can lose to a stopped process, a container freeze, or a
      // long garbage collection between the recorded intent and this write. A
      // stall that outlived the lease would let another Host settle this row and
      // release the constraint while this one still went on to create a durable
      // ref recorded as failed. Ownership is therefore re-read immediately
      // before the write, which is the last instant Forgeyard controls.
      const owned = this.store.promotion(planned.record.id)
      if (owned === undefined || owned.status !== 'pending') {
        throw new ForgeyardDomainError(
          'PROMOTION_BLOCKED',
          `This promotion was settled as ${owned?.status ?? 'missing'} elsewhere before its Git ref was created; no durable output was written.`,
        )
      }
      if (owned.leaseExpiresAt <= Date.now()) {
        this.failPromotion(
          planned.record.id,
          'This promotion lost its lease before its Git ref was created, so Forgeyard refused to write it',
          new Error('the promotion lease lapsed before the ref write'),
        )
        throw new ForgeyardDomainError(
          'PROMOTION_BLOCKED',
          'This promotion lost its lease before its Git ref was created. No durable output was written, so the Attempt may be promoted again.',
        )
      }
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
      // A settlement this Host did not perform is never overwritten. The ref read
      // back as this promotion's exact commit, so an existing `promoted` record
      // is the same outcome and stands; an opposite one is a disagreement.
      if (this.settleReconciled(planned.record.id, 'promoted', null) === 'conflicted') {
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
   * Every Git invocation is hard-bounded by `commandTimeoutMs`, so the lease is
   * that bound times the number of bounded commands the post-intent path runs —
   * see `PROMOTION_POST_INTENT_GIT_COMMANDS` — plus a margin.
   *
   * This is deliberately a worst case, and it is paid in recovery latency: with
   * the shipped 120s Git timeout the lease is about sixteen minutes, so an
   * Attempt whose Host died mid-promotion reports `uncertain` for that long
   * before the scheduled pass releases it. That is automatic and needs no
   * operator action, and it is the right side to err on — under-budgeting risks
   * a durable ref recorded as failed. Renewing the lease between commands would
   * shorten it to a single command's bound; that is a design change to make
   * deliberately, not a constant to shave.
   */
  private promotionLeaseMs(): number {
    return PROMOTION_POST_INTENT_GIT_COMMANDS * this.git.config.commandTimeoutMs + PROMOTION_LEASE_MARGIN_MS
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
    // A symref at the promotion name proves no Forgeyard-owned output exists
    // there: Forgeyard only ever creates a direct ref, and refuses to write
    // through a symref. That is a definite failure, not an uncertain one, so
    // the Attempt is released now instead of waiting out a lease it cannot
    // learn anything more from.
    let symbolic: string | null = null
    try {
      symbolic = await this.git.promotionSymrefTarget(prepared.repository.path, record.outputRef)
    } catch {
      symbolic = null
    }
    if (symbolic !== null) {
      const symrefReason = `${prefix}: ${record.outputRef} is a symbolic ref to ${symbolic}, so no Forgeyard-owned output exists at that name`
      this.failPromotion(record.id, symrefReason, cause)
      throw new ForgeyardDomainError('GIT_ERROR', boundedReason(symrefReason, cause))
    }
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
      if (this.settleReconciled(record.id, 'promoted', null) === 'conflicted') {
        throw new ForgeyardDomainError('GIT_ERROR', boundedReason(
          `${prefix}, but ${record.outputRef} holds this promotion's commit ${record.outputCommit} while the Promotion was settled as failed elsewhere; inspect the ref before promoting again`,
          cause,
        ))
      }
      return this.attemptViewUnqueued(attempt.id)
    }
    const reason = observed === null
      ? prefix
      : `${prefix}: ${record.outputRef} resolves to ${observed} instead of this promotion's commit ${record.outputCommit}`
    this.failPromotion(record.id, reason, cause)
    throw new ForgeyardDomainError('GIT_ERROR', boundedReason(reason, cause))
  }

  /**
   * Settle a Promotion, accepting a settlement another Host already wrote.
   *
   * Two Hosts can read the same expired pending row before either settles it. A
   * Promotion settles exactly once, by whoever gets there first; the loser must
   * report that outcome rather than fail, which would abort a boot
   * reconciliation or a `promote` request over a question already answered.
   *
   * An *opposite* settlement is not the same thing and is never accepted as
   * agreement. Two Hosts can legitimately observe different refs — one reads
   * nothing and settles `failed`, an external writer creates the ref, the other
   * reads the exact promoted commit — and quietly keeping `failed` would leave
   * a durable output filed as a failure. That disagreement is surfaced.
   */
  private settleReconciled(
    id: PromotionId,
    status: 'promoted' | 'failed',
    failureReason: string | null,
  ): 'settled' | 'agreed' | 'conflicted' {
    try {
      this.store.settlePromotion(id, status, failureReason)
      return 'settled'
    } catch (error) {
      const current = this.store.promotion(id)?.status
      // Only a row that is still pending means this was a real write failure.
      if (current === undefined || current === 'pending') throw error
      return current === status ? 'agreed' : 'conflicted'
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
    // Deliberately not held inside the engine's mutation queue. Probing a
    // repository costs bounded Git commands — 120s each on the shipped config —
    // and this pass is fire-and-forget background recovery that can meet several
    // stalled repositories in a row. Holding the queue across that would make
    // every later Remote request wait behind it, including the Cockpit's first
    // `snapshot`, so a Host recovering quietly would look like a Host that is
    // down. Only the settlements take the queue, and each is one synchronous
    // SQLite write.
    try {
      return await this.reconcilePending(null, write => this.enqueue(async () => write()))
    } finally {
      this.scheduleLeaseReconciliation()
    }
  }

  private async reconcilePromotionsUnqueued(attemptId: AttemptId | null): Promise<number> {
    try {
      // Already inside the queue: settle inline rather than deadlocking on it.
      return await this.reconcilePending(attemptId, write => write())
    } finally {
      // Armed on every exit path. A pass that rejects — SQLite write contention
      // with another Host, say — has already consumed the only timer, and the
      // Cockpit exposes no action that could ask for another.
      this.scheduleLeaseReconciliation()
    }
  }

  private async reconcilePending(
    attemptId: AttemptId | null,
    settle: (write: () => 'settled' | 'agreed' | 'conflicted') => Promise<'settled' | 'agreed' | 'conflicted'> | 'settled' | 'agreed' | 'conflicted',
  ): Promise<number> {
    const now = Date.now()
    const pending = this.store.pendingPromotions()
      .filter(record => attemptId === null || record.attemptId === attemptId)
    const conflicts: string[] = []
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
      let broken: string | null = null
      try {
        const repository = await this.git.canonicalize(attempt.executionSnapshot.repository.path)
        this.git.assertRepositorySnapshot(repository, attempt.executionSnapshot.repository)
        observed = await this.git.readPromotionRef(repository.path, promotion.outputRef)
      } catch (error) {
        // A ref that is present but provably unusable — a symref, an unreadable
        // object graph — will not become usable by looking again. Leaving it
        // pending repeats this pass forever and keeps the Attempt blocked with
        // no operator gesture able to reach it, so it is settled and released.
        // A repository that is not the recorded one is deliberately *not* in
        // that class: the recorded output may still exist wherever the original
        // repository went, so claiming no durable output exists would be a guess.
        if (!(error instanceof PromotionRefDisagreement)) continue
        observed = null
        broken = errorText(error)
      }
      const wrote = await settle(() => broken !== null
        ? this.settleReconciled(
          promotion.id,
          'failed',
          `No usable Forgeyard-owned output exists at ${promotion.outputRef}: ${broken}. Resolve it before promoting this Attempt again.`,
        )
        : observed === promotion.outputCommit
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
          ))
      if (wrote === 'settled') settled += 1
      else if (wrote === 'conflicted') {
        // Two Hosts proved opposite things about one ref. Counting this as an
        // ordinary loss would discard the disagreement the tri-state exists to
        // report, and let an on-demand promotion continue from a `failed` row
        // without ever saying that its exact output ref is present.
        conflicts.push(
          `${promotion.outputRef} is recorded as ${this.store.promotion(promotion.id)?.status ?? 'unknown'} `
          + `while this Host observed ${observed ?? 'no ref'} for this promotion's commit ${promotion.outputCommit}`,
        )
      }
    }
    // Every promotion is still processed first: one disagreement must not stop
    // the others from settling. It is raised once the pass is complete, and the
    // `finally` in the caller still arms the next one.
    if (conflicts.length > 0) {
      throw new ForgeyardDomainError(
        'PROMOTION_BLOCKED',
        `Forgeyard settled a Promotion that disagrees with its Git ref: ${conflicts.join('; ')}. `
        + 'Inspect the ref before promoting again.',
      )
    }
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
    // Every retained Promotion is audit authority for this Attempt, including a
    // `failed` one. Verifying only the active record would let a corrupted or
    // hand-edited failure history sit underneath a fresh promotion written on
    // top of it, which is exactly the state the integrity check exists to block.
    for (const record of promotions) {
      try {
        assertPromotionRecordIntegrity(record)
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
      let symbolic: string | null = null
      try {
        const repository = await this.git.canonicalize(attempt.executionSnapshot.repository.path)
        // A repository replaced at the recorded path is a different repository,
        // whatever it happens to contain. Without this, one holding the same ref
        // at the same commit would confirm a promotion that never happened in it.
        this.git.assertRepositorySnapshot(repository, attempt.executionSnapshot.repository)
        // A symref at the name is a known disagreement, not an unverified read,
        // and must not keep rendering as a promoted output.
        symbolic = await this.git.promotionSymrefTarget(repository.path, active.outputRef)
        observed = symbolic !== null ? null : await this.git.readPromotionRef(repository.path, active.outputRef)
      } catch (error) {
        // A repository that is not the recorded one, and a ref that is present
        // but provably unusable, are both settled questions: looking again will
        // not change them, and continuing to advertise a green promoted output
        // over either would be a claim Forgeyard cannot support.
        if (error instanceof RepositoryIdentityMismatch || error instanceof PromotionRefDisagreement) {
          return {
            ...base,
            status: 'diverged',
            reason: `This Attempt was promoted to ${active.outputRef} at ${active.outputCommit}, but that output no longer holds: ${errorText(error)}`,
          }
        }
        // Unreadable right now is a different thing, and is not asserted as
        // either. The record stands and says it was not re-verified.
        return {
          ...base,
          status: 'promoted',
          reason: `This Attempt was already promoted to ${active.outputRef} at ${active.outputCommit}. That could not be confirmed: ${errorText(error)}`,
        }
      }
      if (symbolic !== null) {
        return {
          ...base,
          status: 'diverged',
          reason: `This Attempt was promoted to ${active.outputRef} at ${active.outputCommit}, but that name is now a symbolic ref to ${symbolic}. Forgeyard only ever creates a direct ref, so this is not its output — and what it resolves to follows that ref whenever it moves.`,
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
    const tasks = this.orderedMissionTasks(mission)
    const nodes: TaskNodeView[] = []
    // Nodes are built in frozen Pipe order, so every dependency of a node has
    // already been built — with its live promotion re-verification attached —
    // by the time that node's own readiness is computed.
    for (const task of tasks) {
      const attempts: AttemptView[] = []
      for (const attempt of this.store.attemptsForTask(task.id)) attempts.push(await this.attemptViewUnqueued(attempt.id))
      nodes.push({
        task,
        attempts,
        readiness: this.taskReadiness(task, tasks, attempts, nodes),
        nodeState: attempts.at(-1)?.attempt.state ?? 'ready',
      })
    }
    return { mission, tasks: nodes, derivedState: missionRollupState(nodes) }
  }

  /**
   * This Mission's Tasks in frozen Pipe order.
   *
   * The Pipe — not SQLite insertion time or random Task IDs — owns node order,
   * so materializing multiple nodes in one transaction can never let UUID order
   * decide which node the Cockpit renders first. This is a total, deterministic
   * order that never throws inside the snapshot fan-out: a Task whose node key
   * is absent from the Pipe (which the creation path does not produce) sorts
   * last rather than blinding every Mission's view.
   */
  private orderedMissionTasks(mission: MissionRecord): TaskRecord[] {
    const materialized = this.store.tasksForMission(mission.id)
    if (materialized.length === 0) throw new Error('Mission has no materialized Task')
    const nodeOrder = new Map(mission.pipe.nodes.map((node, index) => [node.key, index]))
    return [...materialized].sort((left, right) =>
      (nodeOrder.get(left.sourceNodeKey) ?? Number.MAX_SAFE_INTEGER)
        - (nodeOrder.get(right.sourceNodeKey) ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id))
  }

  /**
   * Satisfied upstream output for one dependency edge, or why it is not satisfied.
   *
   * This is the single source of truth for Milestone 3 readiness: the Cockpit
   * renders its `reason` verbatim and `planAttempt` refuses admission with the
   * same text, so the two can never disagree. It reads only the upstream node's
   * `AttemptView[]`, whose `promotion` field was produced by
   * `promotionEligibility` — so a dependency is satisfied only by output that
   * same function would still advertise: re-verified against the live ref, not
   * merely recorded as promoted in SQLite.
   */
  private upstreamOutput(upstreamTask: TaskRecord, upstreamAttempts: AttemptView[]): DependencySatisfaction {
    if (upstreamAttempts.length === 0) {
      return {
        satisfied: false,
        status: 'blocked',
        reason: `Node ${upstreamTask.sourceNodeKey} has not run yet; it must reach an approved, promoted Attempt first.`,
      }
    }
    let promoted: { baseCommit: string; baseFromAttemptId: AttemptId } | null = null
    let divergedReason: string | null = null
    let uncertainReason: string | null = null
    for (const view of upstreamAttempts) {
      if (view.promotion.status === 'promoted') {
        if (promoted === null) promoted = { baseCommit: view.promotion.outputCommit ?? '', baseFromAttemptId: view.attempt.id }
      } else if (view.promotion.status === 'diverged') {
        if (divergedReason === null) divergedReason = view.promotion.reason ?? `Node ${upstreamTask.sourceNodeKey}'s promoted output no longer holds.`
      } else if (view.promotion.status === 'uncertain') {
        if (uncertainReason === null) uncertainReason = view.promotion.reason ?? 'A promotion has not settled yet.'
      }
    }
    const latest = upstreamAttempts.at(-1)?.attempt
    if (latest?.state === 'rejected') {
      return {
        satisfied: false,
        status: 'dead',
        reason: `Node ${upstreamTask.sourceNodeKey} was rejected, which is terminal for that Task; create a new Mission for another line of work.`,
      }
    }
    if (divergedReason !== null) return { satisfied: false, status: 'blocked', reason: divergedReason }
    if (uncertainReason !== null) return { satisfied: false, status: 'blocked', reason: uncertainReason }
    if (promoted !== null && promoted.baseCommit.length > 0) return { satisfied: true, ...promoted }
    if (latest?.state === 'approved') {
      return {
        satisfied: false,
        status: 'blocked',
        reason: `Node ${upstreamTask.sourceNodeKey} is approved but its output has not been promoted yet; promote it first.`,
      }
    }
    return {
      satisfied: false,
      status: 'blocked',
      reason: `Node ${upstreamTask.sourceNodeKey} has not reached a terminal approved Attempt; its latest Attempt is ${latest?.state ?? 'unknown'}.`,
    }
  }

  /**
   * Readiness for one node, computed fresh from existing records. It is never
   * stored: a stored copy would drift from the records it summarizes.
   *
   * A root node resolves to `ready` (startable only until its first Attempt
   * exists). A dependency-bearing node resolves through `upstreamOutput`, so it
   * becomes startable exactly when a re-verified promoted upstream commit exists
   * to freeze as its base. This projection fails soft on inconsistent dependency
   * records rather than throwing inside the snapshot fan-out, so one bad row
   * cannot blind the whole Cockpit.
   */
  private taskReadiness(task: TaskRecord, missionTasks: TaskRecord[], attempts: AttemptView[], builtNodes: TaskNodeView[]): TaskReadiness {
    // Resolve each dependency TaskId to its node key. A dependency that does not
    // resolve is corruption — the creation path never writes one — but the view
    // must fail soft exactly as `promotionEligibility` does: one inconsistent
    // `dependencies_json` row must not throw inside the snapshot fan-out and
    // blind every Mission's Cockpit. Report it as blocked with a reason instead.
    const blockedBy: string[] = []
    const unresolved: string[] = []
    for (const dependencyId of task.dependencies) {
      const dependency = missionTasks.find(candidate => candidate.id === dependencyId)
      if (dependency === undefined) unresolved.push(dependencyId)
      else blockedBy.push(dependency.sourceNodeKey)
    }
    if (unresolved.length > 0) {
      return {
        status: 'blocked',
        startable: false,
        reason: `This node's recorded dependencies do not resolve within its Mission: ${unresolved.join(', ')}. `
          + 'The dependency records are inconsistent and must be inspected.',
        blockedBy,
        baseCommit: null,
        baseFromAttemptId: null,
      }
    }
    if (blockedBy.length === 0) {
      const latest = attempts.at(-1)?.attempt
      const startable = latest === undefined
      let reason: string | null = null
      if (latest !== undefined) {
        if (RETRYABLE_STATES.has(latest.state)) {
          reason = 'The first Attempt already exists; use Retry to create an immutable successor.'
        } else if (latest.state === 'rejected') {
          reason = 'This Task was rejected and is terminal; create a new Mission for another line of work.'
        } else if (latest.state === 'cancelled') {
          reason = 'This Task was cancelled and is terminal; create a new Mission for another line of work.'
        } else if (latest.state === 'approved') {
          reason = 'This Task is approved; starting another initial Attempt is not allowed.'
        } else {
          reason = `Attempt ${latest.id} already exists in state ${latest.state}; a second initial Attempt is not allowed.`
        }
      }
      return {
        status: 'ready',
        startable,
        reason,
        blockedBy: [],
        baseCommit: null,
        baseFromAttemptId: null,
      }
    }

    // Dependency-bearing node: resolve every edge through the same
    // upstreamOutput the engine will refuse admission with. Pipe order
    // guarantees each dependency's view is already in builtNodes.
    const satisfactions: DependencySatisfaction[] = []
    for (const dependencyId of task.dependencies) {
      const dependency = missionTasks.find(candidate => candidate.id === dependencyId)
      const upstreamView = dependency === undefined
        ? undefined
        : builtNodes.find(node => node.task.id === dependencyId)
      if (dependency === undefined || upstreamView === undefined) continue // reported above as unresolved
      satisfactions.push(this.upstreamOutput(dependency, upstreamView.attempts))
    }
    const unsatisfied = satisfactions.find(item => !item.satisfied)
    if (unsatisfied !== undefined) {
      return {
        status: unsatisfied.status,
        startable: false,
        reason: unsatisfied.reason,
        blockedBy,
        baseCommit: null,
        baseFromAttemptId: null,
      }
    }
    const bases = satisfactions.filter(item => item.satisfied)
    if (bases.length !== 1) {
      // A serial Pipe expresses exactly one propagated base. If a wider graph
      // ever becomes representable, this must be designed, not guessed.
      throw new Error(`Task ${task.id} has ${bases.length} satisfied dependencies; only one propagated base is representable.`)
    }
    const base = bases[0]
    if (base === undefined) throw new Error('satisfied dependency disappeared')
    const ownLatest = attempts.at(-1)?.attempt
    const startable = ownLatest === undefined
    return {
      status: 'ready',
      startable,
      reason: startable
        ? null
        : 'The first Attempt already exists; use Retry to create an immutable successor.',
      blockedBy: [],
      baseCommit: base.baseCommit,
      baseFromAttemptId: base.baseFromAttemptId,
    }
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
