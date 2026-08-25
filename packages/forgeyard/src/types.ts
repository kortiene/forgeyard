/** Public, client-safe Forgeyard domain and Remote vocabulary. */

export type MissionId = string
export type TaskId = string
export type AttemptId = string
export type EvidenceId = string
export type VerificationId = string
export type DecisionId = string
export type PromotionId = string

export type AttemptState =
  | 'preparing'
  | 'worktree_ready'
  | 'session_bound'
  | 'running'
  | 'verifying'
  | 'awaiting_decision'
  | 'approved'
  | 'rejected'
  | 'retried'
  | 'cancelled'
  | 'interrupted'
  | 'needs_review'

export type VerificationStatus = 'PASS' | 'FAIL' | 'ERROR' | 'INCOMPLETE'
export type DecisionType = 'APPROVE' | 'REJECT' | 'RETRY' | 'CANCEL'
export type PromotionStatus = 'pending' | 'promoted' | 'failed'

/**
 * How one reviewed raw-workspace entry is treated by the promotion projection.
 * Every entry of the reviewed manifest receives exactly one of these outcomes.
 */
export type PromotionOutcome =
  /** Carried into the promoted Git tree as a blob with a Git file mode. */
  | 'promoted'
  /** The linked-worktree `.git` administrative entry (and anything below it). */
  | 'git-admin'
  /** Git-ignored file or symlink; excluded by the declared projection. */
  | 'ignored'
  /** A directory with at least one promoted descendant; Git implies it from paths. */
  | 'directory-implied'
  /** A directory with no promoted descendant; Git cannot represent it at all. */
  | 'directory-dropped'

export interface RepositorySnapshot {
  path: string
  baseRef: string
  checkoutHead: string
  checkoutStatusHash: string
  gitDir: string
  gitCommonDir: string
  pathDevice: string
  pathInode: string
  gitDirDevice: string
  gitDirInode: string
  gitCommonDirDevice: string
  gitCommonDirInode: string
  ownerUid: string | null
}

export interface VerificationRequirement {
  key: string
  command: string
  argv: string[]
}

export interface PipeNodeSnapshot {
  key: string
  task: string
  verify: VerificationRequirement[]
  /**
   * Node keys this node depends on. Absent in Missions frozen before the Pipe
   * existed, which is read as `[]` — exactly the single-node truth.
   */
  dependsOn?: string[]
}

export interface PipeSnapshot {
  nodes: PipeNodeSnapshot[]
}

export interface ResolvedPolicySnapshot {
  provider: string
  model: string
  reasoningEffort: string | null
  agentPreset: string | null
  permissionPreset: string
  sandboxMode: string
  approvalPolicy: string
  toolPolicy: {
    version: 1
    mode: 'frozen-schema'
    allowedToolNames: string[]
    schemaHash: string
  }
}

export interface MissionRecord {
  id: MissionId
  title: string
  objective: string
  repository: RepositorySnapshot
  baseRef: string
  defaultPolicy: ResolvedPolicySnapshot
  pipe: PipeSnapshot
  pipeHash: string
  createdAt: number
}

export interface TaskSpecification {
  title: string
  objective: string
  instruction: string
  verification: VerificationRequirement[]
}

export interface TaskRecord {
  id: TaskId
  missionId: MissionId
  sourceNodeKey: string
  specification: TaskSpecification
  dependencies: TaskId[]
  createdAt: number
}

export interface ExecutionSnapshot {
  version: 1
  attemptId: AttemptId
  ordinal: number
  task: TaskSpecification
  repository: RepositorySnapshot
  baseCommit: string
  policy: ResolvedPolicySnapshot
  verification: VerificationRequirement[]
  createdAt: number
}

/** A no-follow filesystem observation used by the trusted raw-workspace collector. */
export interface WorkspaceManifestEntry {
  path: string
  type: 'directory' | 'file' | 'symlink'
  mode: string
  uid: string
  gid: string
  device: string
  inode: string
  nlink: string
  size: string
  mtimeNs: string
  ctimeNs: string
  contentHash: string | null
  linkHash: string | null
}

/** Immutable baseline for metadata/content changes that Git itself does not render. */
export interface RawWorkspaceManifest {
  version: 1
  rootPath: '.'
  entries: WorkspaceManifestEntry[]
  canonical: string
  hash: string
}

export interface AttemptRecord {
  id: AttemptId
  taskId: TaskId
  ordinal: number
  executionSnapshot: ExecutionSnapshot
  executionSnapshotHash: string
  baseCommit: string
  worktreePath: string
  worktreeDevice: string | null
  worktreeInode: string | null
  rawWorkspaceBaseline: RawWorkspaceManifest | null
  rawWorkspaceBaselineHash: string | null
  retryOfAttemptId: AttemptId | null
  successorAttemptId: AttemptId | null
  dshSessionId: string
  state: AttemptState
  startedAt: number | null
  endedAt: number | null
  gitFingerprint: string | null
  terminalReason: string | null
  createdAt: number
  updatedAt: number
}

export interface ChangedFile {
  status: string
  path: string
}

export interface GitFingerprint {
  baseCommit: string
  headCommit: string
  statusHash: string
  diffHash: string
  untrackedHash: string
  workspaceHash: string
  digest: string
}

export interface GitEvidencePayload {
  kind: 'git'
  baseCommit: string
  headCommit: string
  fingerprint: GitFingerprint
  changedFiles: ChangedFile[]
  diff: string
  diffBytes: number
  diffTruncated: boolean
  ignoredFilesExcluded: false
}

export interface EnvironmentFact {
  name: string
  value: string
}

export interface CommandEvidencePayload {
  kind: 'verification-command'
  requirementKey: string
  command: string
  argv: string[]
  cwd: string
  environment: EnvironmentFact[]
  exitCode: number | null
  signal: string | null
  durationMs: number
  stdout: string
  stdoutBytes: number
  stdoutHash: string
  stdoutTruncated: boolean
  stderr: string
  stderrBytes: number
  stderrHash: string
  stderrTruncated: boolean
  timedOut: boolean
  spawnError: string | null
}

export type EvidencePayload = GitEvidencePayload | CommandEvidencePayload

export interface EvidenceRecord {
  id: EvidenceId
  attemptId: AttemptId
  runId: string
  kind: 'git' | 'verification-command'
  collectorId: string
  collectorVersion: string
  payload: EvidencePayload
  hash: string
  completeness: 'COMPLETE' | 'INCOMPLETE'
  createdAt: number
}

export interface VerificationRecord {
  id: VerificationId
  attemptId: AttemptId
  runId: string
  requirementIndex: number
  requirement: VerificationRequirement
  evaluator: string
  evaluatorVersion: string
  evidenceIds: EvidenceId[]
  evidenceSetDigest: string
  status: VerificationStatus
  rationale: string
  hash: string
  createdAt: number
}

export interface DecisionRecord {
  id: DecisionId
  attemptId: AttemptId
  type: DecisionType
  reviewDigest: string
  actor: string
  rationale: string
  createdAt: number
}

/**
 * One entry carried into the promoted Git tree.
 *
 * `contentHash` is the SHA-256 of the exact reviewed bytes (a regular file's
 * content, or a symlink's raw target bytes). `blobOid` is the Git object name
 * Forgeyard computed for those same bytes in the same read; the promoted tree
 * is accepted only when Git independently produced the identical object name.
 */
export interface PromotedEntry {
  path: string
  type: 'file' | 'symlink'
  /** `100644`, `100755`, or `120000`. */
  gitMode: string
  /** The exact reviewed POSIX mode bits, which Git does not carry. */
  mode: string
  sizeBytes: string
  contentHash: string
  blobOid: string
}

export interface ExcludedEntry {
  path: string
  type: 'directory' | 'file' | 'symlink'
  reason: Exclude<PromotionOutcome, 'promoted'>
}

/** A promoted entry whose reviewed permission bits Git will not reproduce. */
export interface UnrepresentableMode {
  path: string
  /** The reviewed POSIX mode bits. */
  mode: string
  gitMode: string
  /** The permission bits `gitMode` canonically denotes: `420` (0644) or `493` (0755). */
  canonicalMode: string
}

export interface PromotionLedgerSection<T> {
  count: number
  /** SHA-256 over the complete canonical list, whether or not the preview is bounded. */
  hash: string
  preview: T[]
  previewTruncated: boolean
}

/**
 * The declared, total promotion projection of one reviewed raw workspace.
 *
 * Every entry of the reviewed manifest appears in exactly one section, so
 * `promoted.count + excluded.count` equals the reviewed manifest entry count.
 * Section hashes always cover the complete list; previews are bounded for
 * rendering only and never authorize anything on their own.
 */
export interface PromotionProjection {
  version: 1
  projector: string
  projectorVersion: string
  /** The reviewed raw-workspace manifest hash this projection was computed from. */
  workspaceHash: string
  manifestEntryCount: number
  promoted: PromotionLedgerSection<PromotedEntry>
  excluded: PromotionLedgerSection<ExcludedEntry>
  excludedByReason: { reason: Exclude<PromotionOutcome, 'promoted'>; count: number; hash: string }[]
  unrepresentableModes: PromotionLedgerSection<UnrepresentableMode>
  /** Constant statement of reviewed facts a Git tree structurally cannot carry. */
  notCarried: string[]
  canonical: string
  hash: string
}

export interface PromotionRecord {
  id: PromotionId
  attemptId: AttemptId
  decisionId: DecisionId
  reviewDigest: string
  executionSnapshotHash: string
  baseCommit: string
  /** The Attempt worktree HEAD at promotion time; content, not history, is promoted. */
  worktreeHead: string
  evidenceDigest: string
  verificationDigest: string
  projection: PromotionProjection
  projectionHash: string
  objectFormat: 'sha1' | 'sha256'
  outputRef: string
  outputCommit: string
  outputTree: string
  status: PromotionStatus
  actor: string
  rationale: string
  failureReason: string | null
  hash: string
  createdAt: number
  /**
   * The instant after which a still-pending Promotion is provably abandoned.
   * The Host that recorded the intent owns it until then, so reconciliation in
   * another Host never fails a promotion that is still creating its Git ref.
   * The lease is derived from Git's own hard command timeout, so it cannot
   * expire while a live Host is still inside the two bounded Git calls that
   * separate the recorded intent from its settlement.
   */
  leaseExpiresAt: number
  settledAt: number | null
}

export type PromotionEligibilityStatus =
  | 'eligible'
  | 'blocked'
  | 'promoted'
  | 'uncertain'
  /**
   * A completed Promotion whose Git ref no longer matches its record. The
   * SQLite record and the ref are two independent facts and anyone with write
   * access can delete or move a `refs/forgeyard/` ref; Forgeyard reports the
   * disagreement rather than resolving it.
   */
  | 'diverged'

export interface PromotionEligibility {
  status: PromotionEligibilityStatus
  eligible: boolean
  reason: string | null
  /** The exact digest an operator must confirm to promote. */
  reviewDigest: string | null
  decisionId: DecisionId | null
  plannedRef: string | null
  promotionId: PromotionId | null
  outputRef: string | null
  outputCommit: string | null
  failureReason: string | null
}

export interface PromoteRequest {
  attemptId: AttemptId
  actor: string
  rationale: string
  /** Explicit operator confirmation of the exact approved review digest. */
  expectedReviewDigest: string
}

export interface ReviewState {
  reviewDigest: string
  liveGitFingerprint: string
  latestRunId: string | null
  requiredVerificationCount: number
  passingVerificationCount: number
  canApprove: boolean
  /** Whether the live reviewed state still matches its recorded authority exactly. */
  reviewedStateCurrent: boolean
  approvalStale: boolean
  reason: string | null
}

export interface AttemptView {
  attempt: AttemptRecord
  evidence: EvidenceRecord[]
  verifications: VerificationRecord[]
  decisions: DecisionRecord[]
  review: ReviewState
  promotions: PromotionRecord[]
  promotion: PromotionEligibility
}

export type TaskReadinessStatus =
  /** Every declared dependency is satisfied. Admission is reported separately by `startable`. */
  | 'ready'
  /** At least one dependency is unsatisfied, unsettled, or diverged. */
  | 'blocked'
  /**
   * An upstream Task is rejected. Rejection is terminal — `RETRYABLE_STATES`
   * excludes it and migration 002 enforces the same set — so no Attempt of this
   * node can ever become startable. The remedy is a new Mission.
   */
  | 'dead'

export interface TaskReadiness {
  status: TaskReadinessStatus
  /**
   * True exactly when dependencies are ready and this Task has no initial
   * Attempt yet. `startAttempt` refuses when false.
   */
  startable: boolean
  /** Operator-facing explanation. Always set for `blocked` and `dead`. */
  reason: string | null
  /** Node keys of unmet dependencies, for the Cockpit's edge rendering. */
  blockedBy: string[]
  /**
   * The upstream promoted commit this node freezes as its base, resolved only
   * when `status === 'ready'`. Null for a root node, which uses the Mission
   * base ref.
   */
  baseCommit: string | null
  /** The upstream Attempt whose Promotion produced `baseCommit`. */
  baseFromAttemptId: AttemptId | null
}

export interface TaskNodeView {
  task: TaskRecord
  /** Every Attempt of this Task, oldest first — the per-node history. */
  attempts: AttemptView[]
  readiness: TaskReadiness
  /** This node's own state: the latest Attempt state, or 'ready' when none. */
  nodeState: AttemptState | 'ready'
}

/**
 * Mission-level rollup over every node. Evaluated with a total, ordered,
 * first-match-wins rule so the public value is deterministic for mixed states:
 * attention-demanding states outrank quiescent ones, and a Mission never
 * reports `complete` or `ready` while any node still needs an operator.
 */
export type MissionRollupState =
  | 'running'
  | 'awaiting_decision'
  | 'needs_review'
  | 'dead'
  | 'stopped'
  | 'complete'
  | 'ready'
  | 'blocked'

export interface MissionView {
  mission: MissionRecord
  /** Exactly one view per materialized node, in frozen `PipeSnapshot.nodes` order. */
  tasks: TaskNodeView[]
  derivedState: MissionRollupState
}

export interface ForgeyardSnapshot {
  schemaVersion: number
  dshVersion: string
  missions: MissionView[]
}

export interface StartAttemptRequest {
  taskId: TaskId
}

export interface MissionNodeRequest {
  /** Operator-chosen key frozen into the Pipe snapshot after validation/trim. */
  key: string
  /** Instruction for this node's Task. */
  task: string
  /** One direct-argv verifier command for this bounded slice. */
  verificationCommand: string
  /** Explicit dependency node keys: [] for root, [rootKey] for the follow-up. */
  dependsOn: string[]
}

export interface MissionCreateRequest {
  title: string
  objective: string
  repositoryPath: string
  baseRef: string
  /** Exactly one root node or two nodes forming one serial root -> follow-up edge. */
  nodes: MissionNodeRequest[]
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  agentPreset: string | null
  permissionPreset: string | null
}

export interface DecisionRequest {
  attemptId: AttemptId
  type: 'APPROVE' | 'REJECT' | 'CANCEL'
  actor: string
  rationale: string
}

export interface RetryRequest {
  attemptId: AttemptId
  actor: string
  rationale: string
}

export interface AttemptSessionRef {
  attemptId: AttemptId
  taskId: TaskId
  missionId: MissionId
  ordinal: number
}

export type ForgeyardFailureCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'GIT_ERROR'
  | 'DSH_ERROR'
  | 'VERIFICATION_REQUIRED'
  | 'REVIEW_STALE'
  | 'PROMOTION_BLOCKED'
  | 'INTERNAL'

export interface ForgeyardFailure {
  code: ForgeyardFailureCode
  message: string
}

export type ForgeyardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ForgeyardFailure }
