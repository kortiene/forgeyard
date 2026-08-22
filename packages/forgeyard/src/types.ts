/** Public, client-safe Forgeyard domain and Remote vocabulary. */

export type MissionId = string
export type TaskId = string
export type AttemptId = string
export type EvidenceId = string
export type VerificationId = string
export type DecisionId = string

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

export interface ReviewState {
  reviewDigest: string
  liveGitFingerprint: string
  latestRunId: string | null
  requiredVerificationCount: number
  passingVerificationCount: number
  canApprove: boolean
  approvalStale: boolean
  reason: string | null
}

export interface AttemptView {
  attempt: AttemptRecord
  evidence: EvidenceRecord[]
  verifications: VerificationRecord[]
  decisions: DecisionRecord[]
  review: ReviewState
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
  | 'INTERNAL'

export interface ForgeyardFailure {
  code: ForgeyardFailureCode
  message: string
}

export type ForgeyardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ForgeyardFailure }
