import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AttemptId,
  AttemptRecord,
  AttemptState,
  DecisionRecord,
  EvidenceRecord,
  MissionId,
  MissionRecord,
  PromotionId,
  PromotionRecord,
  PromotionStatus,
  TaskId,
  TaskRecord,
  VerificationRecord,
} from '../types.ts'
import { canonicalJson, hashRecord, sha256 } from './hash.ts'
import { MIGRATIONS } from './migrations.ts'

type Row = Record<string, string | number | null>

const TERMINAL = new Set<AttemptState>(['approved', 'rejected', 'retried', 'cancelled'])
const DECISION_STATE = {
  APPROVE: 'approved',
  REJECT: 'rejected',
  RETRY: 'retried',
  CANCEL: 'cancelled',
} as const satisfies Record<DecisionRecord['type'], AttemptState>
const TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = {
  preparing: ['worktree_ready', 'needs_review', 'interrupted'],
  worktree_ready: ['session_bound', 'needs_review', 'interrupted'],
  session_bound: ['running', 'needs_review', 'interrupted'],
  running: ['verifying', 'needs_review', 'interrupted', 'cancelled'],
  verifying: ['awaiting_decision', 'needs_review', 'interrupted'],
  awaiting_decision: ['verifying', 'approved', 'rejected', 'retried', 'cancelled', 'needs_review'],
  approved: [],
  rejected: [],
  retried: [],
  cancelled: [],
  interrupted: ['verifying', 'rejected', 'retried', 'cancelled', 'needs_review'],
  needs_review: ['verifying', 'rejected', 'retried', 'cancelled'],
}

function parse<T>(input: string | number | null | undefined): T {
  if (typeof input !== 'string') throw new Error('Forgeyard database JSON column is not text')
  return JSON.parse(input) as T
}

function missionOf(row: Row): MissionRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    objective: String(row.objective),
    repository: parse(row.repository_json),
    baseRef: String(row.base_ref),
    defaultPolicy: parse(row.policy_json),
    pipe: parse(row.pipe_json),
    pipeHash: String(row.pipe_hash),
    createdAt: Number(row.created_at),
  }
}

function taskOf(row: Row): TaskRecord {
  return {
    id: String(row.id),
    missionId: String(row.mission_id),
    sourceNodeKey: String(row.source_node_key),
    specification: parse(row.specification_json),
    dependencies: parse(row.dependencies_json),
    createdAt: Number(row.created_at),
  }
}

function attemptOf(row: Row): AttemptRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ordinal: Number(row.ordinal),
    executionSnapshot: parse(row.execution_snapshot_json),
    executionSnapshotHash: String(row.execution_snapshot_hash),
    baseCommit: String(row.base_commit),
    worktreePath: String(row.worktree_path),
    worktreeDevice: row.worktree_device === null ? null : String(row.worktree_device),
    worktreeInode: row.worktree_inode === null ? null : String(row.worktree_inode),
    rawWorkspaceBaseline: row.raw_workspace_baseline_json === null ? null : parse(row.raw_workspace_baseline_json),
    rawWorkspaceBaselineHash: row.raw_workspace_baseline_hash === null ? null : String(row.raw_workspace_baseline_hash),
    retryOfAttemptId: row.retry_of_attempt_id === null ? null : String(row.retry_of_attempt_id),
    successorAttemptId: row.successor_attempt_id === null ? null : String(row.successor_attempt_id),
    dshSessionId: String(row.dsh_session_id),
    state: String(row.state) as AttemptState,
    startedAt: row.started_at === null ? null : Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    gitFingerprint: row.git_fingerprint === null ? null : String(row.git_fingerprint),
    terminalReason: row.terminal_reason === null ? null : String(row.terminal_reason),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function evidenceOf(row: Row): EvidenceRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attempt_id),
    runId: String(row.run_id),
    kind: String(row.kind) as EvidenceRecord['kind'],
    collectorId: String(row.collector_id),
    collectorVersion: String(row.collector_version),
    payload: parse(row.payload_json),
    hash: String(row.hash),
    completeness: String(row.completeness) as EvidenceRecord['completeness'],
    createdAt: Number(row.created_at),
  }
}

function verificationOf(row: Row): VerificationRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attempt_id),
    runId: String(row.run_id),
    requirementIndex: Number(row.requirement_index),
    requirement: parse(row.requirement_json),
    evaluator: String(row.evaluator),
    evaluatorVersion: String(row.evaluator_version),
    evidenceIds: parse(row.evidence_ids_json),
    evidenceSetDigest: String(row.evidence_set_digest),
    status: String(row.status) as VerificationRecord['status'],
    rationale: String(row.rationale),
    hash: String(row.hash),
    createdAt: Number(row.created_at),
  }
}

function promotionOf(row: Row): PromotionRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attempt_id),
    decisionId: String(row.decision_id),
    reviewDigest: String(row.review_digest),
    executionSnapshotHash: String(row.execution_snapshot_hash),
    baseCommit: String(row.base_commit),
    worktreeHead: String(row.worktree_head),
    evidenceDigest: String(row.evidence_digest),
    verificationDigest: String(row.verification_digest),
    projection: parse(row.projection_json),
    projectionHash: String(row.projection_hash),
    objectFormat: String(row.object_format) as PromotionRecord['objectFormat'],
    outputRef: String(row.output_ref),
    outputCommit: String(row.output_commit),
    outputTree: String(row.output_tree),
    status: String(row.status) as PromotionStatus,
    actor: String(row.actor),
    rationale: String(row.rationale),
    failureReason: row.failure_reason === null ? null : String(row.failure_reason),
    hash: String(row.hash),
    createdAt: Number(row.created_at),
    leaseExpiresAt: Number(row.lease_expires_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
  }
}

function decisionOf(row: Row): DecisionRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attempt_id),
    type: String(row.type) as DecisionRecord['type'],
    reviewDigest: String(row.review_digest),
    actor: String(row.actor),
    rationale: String(row.rationale),
    createdAt: Number(row.created_at),
  }
}

export function assertAttemptRecordIntegrity(record: AttemptRecord): void {
  if (record.executionSnapshot.attemptId !== record.id || record.executionSnapshot.ordinal !== record.ordinal
    || record.executionSnapshot.baseCommit !== record.baseCommit
    || hashRecord(record.executionSnapshot) !== record.executionSnapshotHash) {
    throw new Error(`Attempt ${record.id} execution snapshot hash is invalid`)
  }
  const baseline = record.rawWorkspaceBaseline
  const hasIdentity = record.worktreeDevice !== null && record.worktreeInode !== null
  const hasBaseline = baseline !== null && record.rawWorkspaceBaselineHash !== null
  if (hasIdentity !== hasBaseline
    || (record.worktreeDevice === null) !== (record.worktreeInode === null)
    || (baseline === null) !== (record.rawWorkspaceBaselineHash === null)) {
    throw new Error(`Attempt ${record.id} has a partial worktree authority binding`)
  }
  if (!hasIdentity && record.state !== 'preparing') {
    throw new Error(`Attempt ${record.id} has no durable worktree identity and raw baseline binding`)
  }
  if (baseline !== null) {
    const canonical = canonicalJson({ entries: baseline.entries, rootPath: baseline.rootPath, version: baseline.version })
    if (baseline.version !== 1 || baseline.rootPath !== '.' || baseline.canonical !== canonical
      || sha256(baseline.canonical) !== baseline.hash || baseline.hash !== record.rawWorkspaceBaselineHash) {
      throw new Error(`Attempt ${record.id} raw workspace baseline hash is invalid`)
    }
  }
}

export function assertEvidenceRecordIntegrity(record: EvidenceRecord): void {
  const core = {
    attemptId: record.attemptId,
    runId: record.runId,
    kind: record.kind,
    collectorId: record.collectorId,
    collectorVersion: record.collectorVersion,
    payload: record.payload,
    completeness: record.completeness,
    createdAt: record.createdAt,
  }
  if (record.payload.kind !== record.kind || hashRecord(core) !== record.hash) {
    throw new Error(`Evidence ${record.id} content hash is invalid`)
  }
}

export function assertVerificationRecordIntegrity(record: VerificationRecord): void {
  const core = {
    attemptId: record.attemptId,
    runId: record.runId,
    requirementIndex: record.requirementIndex,
    requirement: record.requirement,
    evaluator: record.evaluator,
    evaluatorVersion: record.evaluatorVersion,
    evidenceIds: record.evidenceIds,
    evidenceSetDigest: record.evidenceSetDigest,
    status: record.status,
    rationale: record.rationale,
    createdAt: record.createdAt,
  }
  if (hashRecord(core) !== record.hash) throw new Error(`Verification ${record.id} content hash is invalid`)
}

/**
 * The immutable half of a Promotion. `status`, `failureReason`, and `settledAt`
 * are the single settle-once lifecycle transition and are deliberately outside
 * the hash so the durable output binding cannot be rewritten by settling.
 * `leaseExpiresAt` is outside it for the same reason from the other end: the
 * lease bounds recovery, it is not part of the promoted deliverable's authority.
 * The schema — not the hash — is what keeps all four from moving.
 */
export type PromotionAuthority = Omit<
  PromotionRecord,
  'id' | 'projection' | 'status' | 'failureReason' | 'hash' | 'leaseExpiresAt' | 'settledAt'
>

export function promotionCore(record: PromotionAuthority): Record<string, unknown> {
  return {
    attemptId: record.attemptId,
    decisionId: record.decisionId,
    reviewDigest: record.reviewDigest,
    executionSnapshotHash: record.executionSnapshotHash,
    baseCommit: record.baseCommit,
    worktreeHead: record.worktreeHead,
    evidenceDigest: record.evidenceDigest,
    verificationDigest: record.verificationDigest,
    projectionHash: record.projectionHash,
    objectFormat: record.objectFormat,
    outputRef: record.outputRef,
    outputCommit: record.outputCommit,
    outputTree: record.outputTree,
    actor: record.actor,
    rationale: record.rationale,
    createdAt: record.createdAt,
  }
}

export function assertPromotionRecordIntegrity(record: PromotionRecord): void {
  const projection = record.projection
  const canonical = canonicalJson({ ...projection, canonical: undefined, hash: undefined })
  if (projection.version !== 1 || projection.canonical !== canonical
    || sha256(projection.canonical) !== projection.hash || projection.hash !== record.projectionHash) {
    throw new Error(`Promotion ${record.id} projection hash is invalid`)
  }
  if (projection.promoted.count + projection.excluded.count !== projection.manifestEntryCount) {
    throw new Error(`Promotion ${record.id} projection does not classify every reviewed workspace entry`)
  }
  if (hashRecord(promotionCore(record)) !== record.hash) {
    throw new Error(`Promotion ${record.id} content hash is invalid`)
  }
}

/** Relational authority for Forgeyard. DSH Session persistence remains separate. */
export class ForgeyardStore {
  readonly database: DatabaseSync

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(path)
    try { chmodSync(path, 0o600) } catch { /* Filesystems may not expose POSIX modes. */ }
    this.database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    const version = this.schemaVersion()
    const supported = MIGRATIONS.at(-1)?.version ?? 0
    if (version > supported) throw new Error(`forgeyard.sqlite schema ${version} is newer than this Host supports`)
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue
      // Several Hosts may open one database. Another can commit this exact
      // migration between the version read above and this write transaction,
      // which would leave a stale reader executing `CREATE TABLE` a second time
      // and failing its own startup. `BEGIN IMMEDIATE` serializes the two, so
      // what has actually been applied is re-read inside the lock.
      this.immediate(() => {
        const applied = this.schemaVersion()
        // A newer Host may have migrated past this one entirely while it waited
        // for the lock. Skipping would let this Host run against a schema it
        // does not support, so the startup rejection is repeated in the lock.
        if (applied > supported) {
          throw new Error(`forgeyard.sqlite schema ${applied} is newer than this Host supports`)
        }
        if (migration.version <= applied) return
        if (applied > 0 && this.migrationApplied(migration.version)) {
          // Another Host applied and recorded it; only the version lags behind.
          this.database.exec(`PRAGMA user_version=${migration.version}`)
          return
        }
        this.database.exec(migration.sql)
        this.database.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, Date.now())
        this.database.exec(`PRAGMA user_version=${migration.version}`)
      })
    }
  }

  private schemaVersion(): number {
    return Number((this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  }

  /**
   * Whether this migration is already recorded as applied. Only meaningful once
   * migration 001 has created `schema_migrations`, so callers check the version.
   */
  private migrationApplied(version: number): boolean {
    return this.database.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version) !== undefined
  }

  close(): void {
    this.database.close()
  }

  immediate<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.database.exec('COMMIT')
      return value
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  insertMissionAndTask(mission: MissionRecord, task: TaskRecord): void {
    this.immediate(() => {
      this.database.prepare(`INSERT INTO missions
        (id,title,objective,repository_json,base_ref,policy_json,pipe_json,pipe_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        mission.id, mission.title, mission.objective, canonicalJson(mission.repository), mission.baseRef,
        canonicalJson(mission.defaultPolicy), canonicalJson(mission.pipe), mission.pipeHash, mission.createdAt,
      )
      this.database.prepare(`INSERT INTO tasks
        (id,mission_id,source_node_key,specification_json,dependencies_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(
        task.id, task.missionId, task.sourceNodeKey, canonicalJson(task.specification),
        canonicalJson(task.dependencies), task.createdAt,
      )
    })
  }

  mission(id: MissionId): MissionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM missions WHERE id=?').get(id) as Row | undefined
    return row === undefined ? undefined : missionOf(row)
  }

  missions(): MissionRecord[] {
    return (this.database.prepare('SELECT * FROM missions ORDER BY created_at,id').all() as Row[]).map(missionOf)
  }

  task(id: TaskId): TaskRecord | undefined {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined
    return row === undefined ? undefined : taskOf(row)
  }

  taskForMission(missionId: MissionId): TaskRecord | undefined {
    const row = this.database.prepare('SELECT * FROM tasks WHERE mission_id=? ORDER BY created_at,id LIMIT 1').get(missionId) as Row | undefined
    return row === undefined ? undefined : taskOf(row)
  }

  createAttempt(attempt: AttemptRecord): void {
    if (attempt.retryOfAttemptId !== null || attempt.successorAttemptId !== null || attempt.ordinal !== 1
      || attempt.state !== 'preparing' || attempt.startedAt !== null || attempt.endedAt !== null
      || attempt.gitFingerprint !== null || attempt.terminalReason !== null
      || attempt.worktreeDevice !== null || attempt.worktreeInode !== null
      || attempt.rawWorkspaceBaseline !== null || attempt.rawWorkspaceBaselineHash !== null) {
      throw new Error('createAttempt only admits the first Attempt; retries require the atomic retry operation')
    }
    this.immediate(() => this.insertAttemptRow(attempt))
  }

  private insertAttemptRow(attempt: AttemptRecord): void {
    assertAttemptRecordIntegrity(attempt)
    this.database.prepare(`INSERT INTO attempts
      (id,task_id,ordinal,execution_snapshot_json,execution_snapshot_hash,base_commit,worktree_path,
       worktree_device,worktree_inode,raw_workspace_baseline_json,raw_workspace_baseline_hash,
       retry_of_attempt_id,successor_attempt_id,dsh_session_id,state,started_at,ended_at,git_fingerprint,
       terminal_reason,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      attempt.id, attempt.taskId, attempt.ordinal, canonicalJson(attempt.executionSnapshot),
      attempt.executionSnapshotHash, attempt.baseCommit, attempt.worktreePath,
      attempt.worktreeDevice, attempt.worktreeInode,
      attempt.rawWorkspaceBaseline === null ? null : canonicalJson(attempt.rawWorkspaceBaseline),
      attempt.rawWorkspaceBaselineHash, attempt.retryOfAttemptId, attempt.successorAttemptId,
      attempt.dshSessionId,
      attempt.state, attempt.startedAt, attempt.endedAt, attempt.gitFingerprint, attempt.terminalReason,
      attempt.createdAt, attempt.updatedAt,
    )
  }

  bindWorktreeIdentity(
    attemptId: AttemptId,
    device: string,
    inode: string,
    baseline: NonNullable<AttemptRecord['rawWorkspaceBaseline']>,
    baselineHash: string,
  ): AttemptRecord {
    if (!/^\d+$/u.test(device) || !/^\d+$/u.test(inode)) throw new Error('invalid worktree filesystem identity')
    const expectedCanonical = canonicalJson({ entries: baseline.entries, rootPath: baseline.rootPath, version: baseline.version })
    if (baseline.version !== 1 || baseline.rootPath !== '.' || baseline.canonical !== expectedCanonical
      || baseline.hash !== sha256(baseline.canonical) || baselineHash !== baseline.hash) {
      throw new Error('invalid raw workspace baseline integrity binding')
    }
    return this.immediate(() => {
      const current = this.attempt(attemptId)
      if (current === undefined) throw new Error(`attempt ${attemptId} does not exist`)
      if (current.state !== 'preparing' || current.worktreeDevice !== null || current.worktreeInode !== null
        || current.rawWorkspaceBaseline !== null || current.rawWorkspaceBaselineHash !== null) {
        throw new Error('Attempt worktree identity and raw baseline can only be bound once during preparation')
      }
      this.database.prepare(`UPDATE attempts SET worktree_device=?, worktree_inode=?,
        raw_workspace_baseline_json=?, raw_workspace_baseline_hash=?, updated_at=? WHERE id=?`)
        .run(device, inode, canonicalJson(baseline), baselineHash, Date.now(), attemptId)
      return this.attempt(attemptId) as AttemptRecord
    })
  }

  attempt(id: AttemptId): AttemptRecord | undefined {
    const row = this.database.prepare('SELECT * FROM attempts WHERE id=?').get(id) as Row | undefined
    return row === undefined ? undefined : attemptOf(row)
  }

  attemptBySession(sessionId: string): AttemptRecord | undefined {
    const row = this.database.prepare('SELECT * FROM attempts WHERE dsh_session_id=?').get(sessionId) as Row | undefined
    return row === undefined ? undefined : attemptOf(row)
  }

  attemptsForTask(taskId: TaskId): AttemptRecord[] {
    return (this.database.prepare('SELECT * FROM attempts WHERE task_id=? ORDER BY ordinal').all(taskId) as Row[]).map(attemptOf)
  }

  nextAttemptOrdinal(taskId: TaskId): number {
    const row = this.database.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS value FROM attempts WHERE task_id=?').get(taskId) as Row
    return Number(row.value)
  }

  transition(
    attemptId: AttemptId,
    next: AttemptState,
    patch: { startedAt?: number | null; endedAt?: number | null; gitFingerprint?: string | null; terminalReason?: string | null } = {},
  ): AttemptRecord {
    return this.immediate(() => {
      const current = this.attempt(attemptId)
      if (current === undefined) throw new Error(`attempt ${attemptId} does not exist`)
      if (!TRANSITIONS[current.state].includes(next)) {
        throw new Error(`invalid Attempt transition ${current.state} -> ${next}`)
      }
      const now = Date.now()
      this.database.prepare(`UPDATE attempts SET state=?, started_at=?, ended_at=?, git_fingerprint=?,
        terminal_reason=?, updated_at=? WHERE id=?`).run(
        next,
        patch.startedAt === undefined ? current.startedAt : patch.startedAt,
        patch.endedAt === undefined ? current.endedAt : patch.endedAt,
        patch.gitFingerprint === undefined ? current.gitFingerprint : patch.gitFingerprint,
        patch.terminalReason === undefined ? current.terminalReason : patch.terminalReason,
        now,
        attemptId,
      )
      return this.attempt(attemptId) as AttemptRecord
    })
  }

  appendEvidence(record: EvidenceRecord): void {
    assertEvidenceRecordIntegrity(record)
    this.immediate(() => this.database.prepare(`INSERT INTO evidence
      (id,attempt_id,run_id,kind,collector_id,collector_version,payload_json,hash,completeness,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.attemptId, record.runId, record.kind, record.collectorId, record.collectorVersion,
      canonicalJson(record.payload), record.hash, record.completeness, record.createdAt,
    ))
  }

  evidence(attemptId: AttemptId): EvidenceRecord[] {
    return (this.database.prepare('SELECT * FROM evidence WHERE attempt_id=? ORDER BY created_at,id').all(attemptId) as Row[]).map(evidenceOf)
  }

  latestEvidenceRunId(attemptId: AttemptId): string | null {
    const row = this.database.prepare(`SELECT run_id FROM evidence
      WHERE attempt_id=? AND kind='git' ORDER BY created_at DESC,id DESC LIMIT 1`).get(attemptId) as Row | undefined
    return row === undefined ? null : String(row.run_id)
  }

  appendVerification(record: VerificationRecord): void {
    assertVerificationRecordIntegrity(record)
    this.immediate(() => {
      this.assertVerificationEvidenceLinks(record)
      this.database.prepare(`INSERT INTO verifications
        (id,attempt_id,run_id,requirement_index,requirement_json,evaluator,evaluator_version,
         evidence_ids_json,evidence_set_digest,status,rationale,hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, record.attemptId, record.runId, record.requirementIndex, canonicalJson(record.requirement),
        record.evaluator, record.evaluatorVersion, canonicalJson(record.evidenceIds), record.evidenceSetDigest,
        record.status, record.rationale, record.hash, record.createdAt,
      )
    })
  }

  private assertVerificationEvidenceLinks(record: VerificationRecord): void {
    if (record.evidenceIds.length === 0 || new Set(record.evidenceIds).size !== record.evidenceIds.length) {
      throw new Error(`Verification ${record.id} must reference a non-empty ordered Evidence set without duplicates`)
    }
    const hashes: string[] = []
    for (const id of record.evidenceIds) {
      const row = this.database.prepare('SELECT * FROM evidence WHERE id=?').get(id) as Row | undefined
      if (row === undefined) throw new Error(`Verification ${record.id} references missing Evidence ${id}`)
      const evidence = evidenceOf(row)
      assertEvidenceRecordIntegrity(evidence)
      if (evidence.attemptId !== record.attemptId || evidence.runId !== record.runId
        || evidence.kind !== 'verification-command' || evidence.payload.kind !== 'verification-command'
        || evidence.payload.requirementKey !== record.requirement.key) {
        throw new Error(`Verification ${record.id} references Evidence outside its frozen requirement`)
      }
      hashes.push(evidence.hash)
    }
    if (sha256(hashes.join('\0')) !== record.evidenceSetDigest) {
      throw new Error(`Verification ${record.id} Evidence-set digest is invalid`)
    }
  }

  verifications(attemptId: AttemptId): VerificationRecord[] {
    return (this.database.prepare(`SELECT * FROM verifications WHERE attempt_id=?
      ORDER BY created_at,id`).all(attemptId) as Row[]).map(verificationOf)
  }

  /** Fail-closed validation for every stored input to one review digest. */
  assertReviewRecordIntegrity(attemptId: AttemptId, runId: string): void {
    const attempt = this.attempt(attemptId)
    if (attempt === undefined) throw new Error(`attempt ${attemptId} does not exist`)
    assertAttemptRecordIntegrity(attempt)
    const evidence = this.evidence(attemptId).filter(record => record.runId === runId)
    const verifications = this.verifications(attemptId).filter(record => record.runId === runId)
    for (const record of evidence) assertEvidenceRecordIntegrity(record)
    for (const record of verifications) {
      assertVerificationRecordIntegrity(record)
      this.assertVerificationEvidenceLinks(record)
    }
    const gitEvidence = evidence.filter(record => record.kind === 'git')
    const gitRecord = gitEvidence[0]
    if (gitEvidence.length !== 1 || gitRecord === undefined || gitRecord.payload.kind !== 'git') {
      throw new Error(`Attempt ${attemptId} review run ${runId} has invalid Git Evidence authority`)
    }
    if (gitRecord.payload.baseCommit !== attempt.baseCommit
      || gitRecord.payload.fingerprint.baseCommit !== attempt.baseCommit
      || gitRecord.collectorId !== 'forgeyard.trusted-collector' || gitRecord.collectorVersion !== '1.0.0'
      || gitRecord.payload.headCommit !== gitRecord.payload.fingerprint.headCommit
      || gitRecord.payload.fingerprint.digest !== sha256(canonicalJson({
        ...gitRecord.payload.fingerprint,
        digest: undefined,
      }))
      || (gitRecord.completeness === 'COMPLETE' && gitRecord.payload.diffTruncated)) {
      throw new Error(`Attempt ${attemptId} review run ${runId} has untrusted or inconsistent Git Evidence`)
    }
    if (['awaiting_decision', 'approved', 'rejected', 'retried', 'cancelled'].includes(attempt.state)
      && attempt.gitFingerprint !== gitRecord.payload.fingerprint.digest) {
      throw new Error(`Attempt ${attemptId} stored Git fingerprint does not match its latest review run`)
    }
    if (verifications.length !== attempt.executionSnapshot.verification.length) {
      throw new Error(`Attempt ${attemptId} review run ${runId} does not cover every frozen requirement`)
    }
    const referenced = new Set<string>()
    const requirementIndexes = new Set<number>()
    for (const record of verifications) {
      const expected = attempt.executionSnapshot.verification[record.requirementIndex]
      if (expected === undefined || canonicalJson(record.requirement) !== canonicalJson(expected)) {
        throw new Error(`Verification ${record.id} does not match its frozen requirement index`)
      }
      if (requirementIndexes.has(record.requirementIndex)) {
        throw new Error(`Verification requirement index ${record.requirementIndex} is duplicated`)
      }
      requirementIndexes.add(record.requirementIndex)
      if (record.evaluator !== 'forgeyard.exit-code-evaluator' || record.evaluatorVersion !== '1.0.0'
        || record.evidenceIds.length !== 1) {
        throw new Error(`Verification ${record.id} is not from the trusted v1 evaluator boundary`)
      }
      for (const id of record.evidenceIds) {
        if (referenced.has(id)) throw new Error(`Evidence ${id} is reused by multiple Verification records`)
        referenced.add(id)
      }
      const command = evidence.find(candidate => candidate.id === record.evidenceIds[0])
      if (command === undefined || command.payload.kind !== 'verification-command'
        || command.collectorId !== 'forgeyard.trusted-collector' || command.collectorVersion !== '1.0.0'
        || command.payload.requirementKey !== expected.key
        || command.payload.command !== expected.command
        || canonicalJson(command.payload.argv) !== canonicalJson(expected.argv)
        || command.payload.cwd !== attempt.worktreePath) {
        throw new Error(`Verification ${record.id} does not interpret the exact trusted command Evidence`)
      }
      if (command.completeness === 'COMPLETE' && (
        command.payload.stdoutTruncated || command.payload.stderrTruncated
        || Buffer.byteLength(command.payload.stdout) !== command.payload.stdoutBytes
        || Buffer.byteLength(command.payload.stderr) !== command.payload.stderrBytes
        || sha256(command.payload.stdout) !== command.payload.stdoutHash
        || sha256(command.payload.stderr) !== command.payload.stderrHash
      )) {
        throw new Error(`Verification ${record.id} command output completeness is inconsistent`)
      }
      const expectedStatus = command.completeness !== 'COMPLETE'
        ? 'INCOMPLETE'
        : command.payload.spawnError !== null || command.payload.timedOut
          || command.payload.signal !== null || command.payload.exitCode === null
          ? 'ERROR'
          : command.payload.exitCode === 0 ? 'PASS' : 'FAIL'
      if (record.status !== expectedStatus) {
        throw new Error(`Verification ${record.id} status does not match trusted command Evidence`)
      }
    }
    const commands = evidence.filter(record => record.kind === 'verification-command').map(record => record.id)
    if (evidence.length !== attempt.executionSnapshot.verification.length + 1
      || commands.length !== referenced.size || commands.some(id => !referenced.has(id))) {
      throw new Error(`Attempt ${attemptId} review run ${runId} has unbound verification-command Evidence`)
    }
  }

  recordDecisionAndTransition(
    record: DecisionRecord,
    next: Extract<AttemptState, 'approved' | 'rejected' | 'retried' | 'cancelled'>,
    terminalReason: string,
  ): AttemptRecord {
    if (DECISION_STATE[record.type] !== next) {
      throw new Error(`Decision ${record.type} cannot transition an Attempt to ${next}`)
    }
    return this.immediate(() => {
      const current = this.attempt(record.attemptId)
      if (current === undefined) throw new Error(`attempt ${record.attemptId} does not exist`)
      if (!TRANSITIONS[current.state].includes(next)) throw new Error(`invalid Attempt transition ${current.state} -> ${next}`)
      this.database.prepare(`INSERT INTO decisions
        (id,attempt_id,type,review_digest,actor,rationale,created_at) VALUES (?,?,?,?,?,?,?)`).run(
        record.id, record.attemptId, record.type, record.reviewDigest, record.actor, record.rationale, record.createdAt,
      )
      const now = Date.now()
      this.database.prepare(`UPDATE attempts SET state=?, ended_at=?, terminal_reason=?, updated_at=? WHERE id=?`).run(
        next, now, terminalReason, now, record.attemptId,
      )
      return this.attempt(record.attemptId) as AttemptRecord
    })
  }

  /**
   * The retry audit boundary: the predecessor Decision/state/link and the new
   * immutable successor authority either all commit or none of them do.
   */
  recordRetryAndCreateSuccessor(
    record: DecisionRecord,
    successor: AttemptRecord,
    terminalReason: string,
  ): { predecessor: AttemptRecord; successor: AttemptRecord } {
    if (record.type !== 'RETRY' || record.attemptId !== successor.retryOfAttemptId
      || successor.successorAttemptId !== null || successor.state !== 'preparing') {
      throw new Error('atomic retry requires a RETRY Decision and an unstarted linked successor')
    }
    return this.immediate(() => {
      const predecessor = this.attempt(record.attemptId)
      if (predecessor === undefined) throw new Error(`attempt ${record.attemptId} does not exist`)
      if (!TRANSITIONS[predecessor.state].includes('retried')) {
        throw new Error(`invalid Attempt transition ${predecessor.state} -> retried`)
      }
      if (predecessor.successorAttemptId !== null || predecessor.taskId !== successor.taskId
        || successor.ordinal !== predecessor.ordinal + 1) {
        throw new Error('retry successor does not extend the exact predecessor Attempt')
      }
      this.insertAttemptRow(successor)
      this.database.prepare(`INSERT INTO decisions
        (id,attempt_id,type,review_digest,actor,rationale,created_at) VALUES (?,?,?,?,?,?,?)`).run(
        record.id, record.attemptId, record.type, record.reviewDigest, record.actor, record.rationale, record.createdAt,
      )
      const now = Date.now()
      this.database.prepare(`UPDATE attempts SET state='retried', successor_attempt_id=?, ended_at=?,
        terminal_reason=?, updated_at=? WHERE id=?`).run(
        successor.id, now, terminalReason, now, predecessor.id,
      )
      return {
        predecessor: this.attempt(predecessor.id) as AttemptRecord,
        successor: this.attempt(successor.id) as AttemptRecord,
      }
    })
  }

  decisions(attemptId: AttemptId): DecisionRecord[] {
    return (this.database.prepare('SELECT * FROM decisions WHERE attempt_id=? ORDER BY created_at,id').all(attemptId) as Row[]).map(decisionOf)
  }

  /**
   * Record the intent to promote before any Git ref exists.
   *
   * The row is written inside `BEGIN IMMEDIATE` so a concurrent promotion of
   * the same Attempt (or the same Forgeyard ref) loses on the partial unique
   * indexes rather than racing `git update-ref`.
   */
  insertPendingPromotion(record: PromotionRecord): void {
    if (record.status !== 'pending' || record.failureReason !== null || record.settledAt !== null) {
      throw new Error('a Promotion is recorded as pending before its Git ref is created')
    }
    if (!Number.isSafeInteger(record.leaseExpiresAt) || record.leaseExpiresAt <= record.createdAt) {
      throw new Error('a pending Promotion carries a lease that outlives its recorded intent')
    }
    assertPromotionRecordIntegrity(record)
    this.immediate(() => {
      const attempt = this.attempt(record.attemptId)
      if (attempt === undefined) throw new Error(`attempt ${record.attemptId} does not exist`)
      if (attempt.state !== 'approved') throw new Error(`only an approved Attempt can be promoted (state ${attempt.state})`)
      const decision = this.decisions(record.attemptId).find(item => item.id === record.decisionId)
      if (decision === undefined || decision.type !== 'APPROVE' || decision.reviewDigest !== record.reviewDigest) {
        throw new Error('a Promotion must bind the Attempt\'s exact terminal APPROVE Decision and review digest')
      }
      this.database.prepare(`INSERT INTO promotions
        (id,attempt_id,decision_id,review_digest,execution_snapshot_hash,base_commit,worktree_head,
         evidence_digest,verification_digest,projection_json,projection_hash,object_format,
         output_ref,output_commit,output_tree,status,actor,rationale,failure_reason,hash,created_at,
         lease_expires_at,settled_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, record.attemptId, record.decisionId, record.reviewDigest, record.executionSnapshotHash,
        record.baseCommit, record.worktreeHead, record.evidenceDigest, record.verificationDigest,
        canonicalJson(record.projection), record.projectionHash, record.objectFormat,
        record.outputRef, record.outputCommit, record.outputTree, record.status,
        record.actor, record.rationale, record.failureReason, record.hash, record.createdAt,
        record.leaseExpiresAt, record.settledAt,
      )
    })
  }

  settlePromotion(id: PromotionId, status: 'promoted' | 'failed', failureReason: string | null): PromotionRecord {
    if ((status === 'failed') !== (failureReason !== null)) {
      throw new Error('a failed Promotion records exactly one failure reason')
    }
    return this.immediate(() => {
      const current = this.promotion(id)
      if (current === undefined) throw new Error(`promotion ${id} does not exist`)
      if (current.status !== 'pending') throw new Error(`promotion ${id} already settled as ${current.status}`)
      this.database.prepare('UPDATE promotions SET status=?, failure_reason=?, settled_at=? WHERE id=?')
        .run(status, failureReason === null ? null : failureReason.slice(0, 20_000), Date.now(), id)
      return this.promotion(id) as PromotionRecord
    })
  }

  promotion(id: PromotionId): PromotionRecord | undefined {
    const row = this.database.prepare('SELECT * FROM promotions WHERE id=?').get(id) as Row | undefined
    return row === undefined ? undefined : promotionOf(row)
  }

  promotions(attemptId: AttemptId): PromotionRecord[] {
    return (this.database.prepare('SELECT * FROM promotions WHERE attempt_id=? ORDER BY created_at,id')
      .all(attemptId) as Row[]).map(promotionOf)
  }

  /** The one Promotion that presently owns this Attempt's Forgeyard ref, if any. */
  activePromotion(attemptId: AttemptId): PromotionRecord | undefined {
    const row = this.database.prepare("SELECT * FROM promotions WHERE attempt_id=? AND status<>'failed'")
      .get(attemptId) as Row | undefined
    return row === undefined ? undefined : promotionOf(row)
  }

  pendingPromotions(): PromotionRecord[] {
    return (this.database.prepare("SELECT * FROM promotions WHERE status='pending' ORDER BY created_at,id")
      .all() as Row[]).map(promotionOf)
  }

  recoverUncertainAttempts(): number {
    const nonterminal = this.database.prepare(`SELECT id FROM attempts WHERE state IN
      ('preparing','worktree_ready','session_bound','running','verifying')`).all() as Row[]
    for (const row of nonterminal) {
      this.transition(String(row.id), 'needs_review', { terminalReason: 'Host restarted during an external operation; success was not inferred.' })
    }
    return nonterminal.length
  }

  isTerminal(state: AttemptState): boolean {
    return TERMINAL.has(state)
  }
}
