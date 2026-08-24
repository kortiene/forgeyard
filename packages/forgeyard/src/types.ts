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
  settledAt: number | null
}

export type PromotionEligibilityStatus = 'eligible' | 'blocked' | 'promoted' | 'uncertain'

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

export interface MissionView {
  mission: MissionRecord
  task: TaskRecord
  attempts: AttemptView[]
  derivedState: string
}

export interface ForgeyardSnapshot {
  schemaVersion: number
  dshVersion: string
  missions: MissionView[]
}

export interface StartAttemptRequest {
  taskId: TaskId
}

export interface MissionCreateRequest {
  title: string
  objective: string
  repositoryPath: string
  baseRef: string
  task: string
  verificationCommand: string
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
