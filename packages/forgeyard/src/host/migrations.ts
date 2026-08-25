/**
 * Immutable migration sources kept in Host source for single-file bundling.
 * The same SQL is mirrored in packages/forgeyard/migrations.
 */
export const MIGRATION_001 = String.raw`
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
CREATE TABLE missions (id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL, repository_json TEXT NOT NULL, base_ref TEXT NOT NULL, policy_json TEXT NOT NULL, pipe_json TEXT NOT NULL, pipe_hash TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE tasks (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), source_node_key TEXT NOT NULL, specification_json TEXT NOT NULL, dependencies_json TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL, execution_snapshot_json TEXT NOT NULL, execution_snapshot_hash TEXT NOT NULL, base_commit TEXT NOT NULL, worktree_path TEXT NOT NULL UNIQUE, dsh_session_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('preparing','worktree_ready','session_bound','running','verifying','awaiting_decision','approved','rejected','retried','cancelled','interrupted','needs_review')), started_at INTEGER, ended_at INTEGER, git_fingerprint TEXT, terminal_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(task_id, ordinal)) STRICT;
CREATE TABLE evidence (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('git','verification-command')), collector_id TEXT NOT NULL, collector_version TEXT NOT NULL, payload_json TEXT NOT NULL, hash TEXT NOT NULL, completeness TEXT NOT NULL CHECK (completeness IN ('COMPLETE','INCOMPLETE')), created_at INTEGER NOT NULL) STRICT;
CREATE TABLE verifications (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), run_id TEXT NOT NULL, requirement_index INTEGER NOT NULL, requirement_json TEXT NOT NULL, evaluator TEXT NOT NULL, evaluator_version TEXT NOT NULL, evidence_ids_json TEXT NOT NULL, evidence_set_digest TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('PASS','FAIL','ERROR','INCOMPLETE')), rationale TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(attempt_id, run_id, requirement_index)) STRICT;
CREATE TABLE decisions (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), type TEXT NOT NULL CHECK (type IN ('APPROVE','REJECT','RETRY','CANCEL')), review_digest TEXT NOT NULL, actor TEXT NOT NULL, rationale TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE INDEX tasks_mission_idx ON tasks(mission_id);
CREATE INDEX attempts_task_idx ON attempts(task_id, ordinal);
CREATE INDEX evidence_attempt_run_idx ON evidence(attempt_id, run_id, created_at, id);
CREATE INDEX verification_attempt_run_idx ON verifications(attempt_id, run_id, requirement_index);
CREATE INDEX decisions_attempt_idx ON decisions(attempt_id, created_at, id);
CREATE TRIGGER missions_immutable_update BEFORE UPDATE ON missions BEGIN SELECT RAISE(ABORT, 'missions are immutable'); END;
CREATE TRIGGER missions_immutable_delete BEFORE DELETE ON missions BEGIN SELECT RAISE(ABORT, 'missions are immutable'); END;
CREATE TRIGGER tasks_immutable_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'tasks are immutable'); END;
CREATE TRIGGER tasks_immutable_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'tasks are immutable'); END;
CREATE TRIGGER evidence_immutable_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER evidence_immutable_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER verifications_immutable_update BEFORE UPDATE ON verifications BEGIN SELECT RAISE(ABORT, 'verifications are append-only'); END;
CREATE TRIGGER verifications_immutable_delete BEFORE DELETE ON verifications BEGIN SELECT RAISE(ABORT, 'verifications are append-only'); END;
CREATE TRIGGER decisions_immutable_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER decisions_immutable_delete BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER attempts_authority_immutable BEFORE UPDATE OF task_id, ordinal, execution_snapshot_json, execution_snapshot_hash, base_commit, worktree_path, dsh_session_id, created_at ON attempts BEGIN SELECT RAISE(ABORT, 'attempt authority is immutable'); END;
CREATE TRIGGER attempts_terminal_immutable BEFORE UPDATE OF state ON attempts WHEN OLD.state IN ('approved','rejected','retried','cancelled') BEGIN SELECT RAISE(ABORT, 'completed attempts cannot become running again'); END;
`

export const MIGRATION_002 = String.raw`
ALTER TABLE attempts ADD COLUMN worktree_device TEXT;
ALTER TABLE attempts ADD COLUMN worktree_inode TEXT;
ALTER TABLE attempts ADD COLUMN raw_workspace_baseline_json TEXT;
ALTER TABLE attempts ADD COLUMN raw_workspace_baseline_hash TEXT;
ALTER TABLE attempts ADD COLUMN retry_of_attempt_id TEXT REFERENCES attempts(id);
ALTER TABLE attempts ADD COLUMN successor_attempt_id TEXT REFERENCES attempts(id);

CREATE UNIQUE INDEX attempts_retry_predecessor_idx ON attempts(retry_of_attempt_id) WHERE retry_of_attempt_id IS NOT NULL;
CREATE UNIQUE INDEX attempts_retry_successor_idx ON attempts(successor_attempt_id) WHERE successor_attempt_id IS NOT NULL;
CREATE UNIQUE INDEX decisions_one_terminal_idx ON decisions(attempt_id);

DROP TRIGGER attempts_authority_immutable;
DROP TRIGGER attempts_terminal_immutable;

CREATE TRIGGER attempts_authority_immutable
BEFORE UPDATE OF task_id, ordinal, execution_snapshot_json, execution_snapshot_hash,
  base_commit, worktree_path, retry_of_attempt_id, dsh_session_id, created_at ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt authority is immutable'); END;

CREATE TRIGGER attempts_initial_insert_guard
BEFORE INSERT ON attempts
WHEN NEW.retry_of_attempt_id IS NULL AND (
  NEW.ordinal <> 1 OR EXISTS (SELECT 1 FROM attempts WHERE task_id=NEW.task_id)
)
BEGIN SELECT RAISE(ABORT, 'an initial Attempt must have ordinal 1'); END;

CREATE TRIGGER attempts_insert_phase_guard
BEFORE INSERT ON attempts
WHEN NEW.state <> 'preparing'
  OR NEW.started_at IS NOT NULL OR NEW.ended_at IS NOT NULL
  OR NEW.git_fingerprint IS NOT NULL OR NEW.terminal_reason IS NOT NULL
  OR NEW.worktree_device IS NOT NULL OR NEW.worktree_inode IS NOT NULL
  OR NEW.raw_workspace_baseline_json IS NOT NULL OR NEW.raw_workspace_baseline_hash IS NOT NULL
  OR NEW.successor_attempt_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a new Attempt must begin as an unbound preparing row'); END;

CREATE TRIGGER attempts_retry_insert_guard
BEFORE INSERT ON attempts
WHEN NEW.retry_of_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM attempts AS predecessor
  WHERE predecessor.id=NEW.retry_of_attempt_id
    AND predecessor.task_id=NEW.task_id
    AND predecessor.ordinal + 1=NEW.ordinal
    AND predecessor.successor_attempt_id IS NULL
    AND predecessor.state IN ('awaiting_decision','interrupted','needs_review')
)
BEGIN SELECT RAISE(ABORT, 'retry successor does not match an eligible predecessor'); END;

CREATE TRIGGER attempts_insert_binding_pairs
BEFORE INSERT ON attempts
WHEN ((NEW.worktree_device IS NULL) <> (NEW.worktree_inode IS NULL))
  OR ((NEW.raw_workspace_baseline_json IS NULL) <> (NEW.raw_workspace_baseline_hash IS NULL))
  OR ((NEW.worktree_device IS NULL) <> (NEW.raw_workspace_baseline_json IS NULL))
BEGIN SELECT RAISE(ABORT, 'worktree identity and raw baseline must be bound together'); END;

CREATE TRIGGER attempts_worktree_binding_once
BEFORE UPDATE OF worktree_device, worktree_inode, raw_workspace_baseline_json, raw_workspace_baseline_hash ON attempts
WHEN OLD.worktree_device IS NOT NULL OR OLD.worktree_inode IS NOT NULL
  OR OLD.raw_workspace_baseline_json IS NOT NULL OR OLD.raw_workspace_baseline_hash IS NOT NULL
  OR NEW.worktree_device IS NULL OR NEW.worktree_inode IS NULL
  OR NEW.raw_workspace_baseline_json IS NULL OR NEW.raw_workspace_baseline_hash IS NULL
BEGIN SELECT RAISE(ABORT, 'worktree identity and raw baseline can only be bound once'); END;

CREATE TRIGGER attempts_successor_link_once
BEFORE UPDATE OF successor_attempt_id ON attempts
WHEN OLD.successor_attempt_id IS NOT NULL OR NEW.successor_attempt_id IS NULL
  OR NEW.state <> 'retried'
  OR NOT EXISTS (
    SELECT 1 FROM attempts AS successor
    WHERE successor.id=NEW.successor_attempt_id AND successor.retry_of_attempt_id=OLD.id
  )
BEGIN SELECT RAISE(ABORT, 'retry successor can only be linked once during RETRY'); END;

CREATE TRIGGER evidence_terminal_sealed
BEFORE INSERT ON evidence
WHEN EXISTS (SELECT 1 FROM attempts WHERE id=NEW.attempt_id AND state IN ('approved','rejected','retried','cancelled'))
BEGIN SELECT RAISE(ABORT, 'terminal Attempt Evidence is sealed'); END;

CREATE TRIGGER verifications_terminal_sealed
BEFORE INSERT ON verifications
WHEN EXISTS (SELECT 1 FROM attempts WHERE id=NEW.attempt_id AND state IN ('approved','rejected','retried','cancelled'))
BEGIN SELECT RAISE(ABORT, 'terminal Attempt Verifications are sealed'); END;

CREATE TRIGGER decisions_terminal_sealed
BEFORE INSERT ON decisions
WHEN EXISTS (SELECT 1 FROM attempts WHERE id=NEW.attempt_id AND state IN ('approved','rejected','retried','cancelled'))
BEGIN SELECT RAISE(ABORT, 'terminal Attempt Decisions are sealed'); END;

CREATE TRIGGER decisions_source_state_guard
BEFORE INSERT ON decisions
WHEN NOT EXISTS (
  SELECT 1 FROM attempts
  WHERE id=NEW.attempt_id AND (
    (NEW.type='APPROVE' AND state='awaiting_decision')
    OR (NEW.type='REJECT' AND state IN ('awaiting_decision','interrupted','needs_review'))
    OR (NEW.type='RETRY' AND state IN ('awaiting_decision','interrupted','needs_review'))
    OR (NEW.type='CANCEL' AND state IN ('running','awaiting_decision','interrupted','needs_review'))
  )
)
BEGIN SELECT RAISE(ABORT, 'Decision type is invalid for the Attempt state'); END;

CREATE TRIGGER attempts_terminal_requires_matching_decision
BEFORE UPDATE OF state ON attempts
WHEN NEW.state IN ('approved','rejected','retried','cancelled') AND NOT EXISTS (
  SELECT 1 FROM decisions
  WHERE attempt_id=OLD.id AND type=CASE NEW.state
    WHEN 'approved' THEN 'APPROVE'
    WHEN 'rejected' THEN 'REJECT'
    WHEN 'retried' THEN 'RETRY'
    WHEN 'cancelled' THEN 'CANCEL'
  END
)
BEGIN SELECT RAISE(ABORT, 'terminal Attempt state requires a matching Decision'); END;

CREATE TRIGGER attempts_retry_requires_linked_successor
BEFORE UPDATE OF state ON attempts
WHEN NEW.state='retried' AND (
  NEW.successor_attempt_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM attempts AS successor
    WHERE successor.id=NEW.successor_attempt_id AND successor.retry_of_attempt_id=OLD.id
  )
)
BEGIN SELECT RAISE(ABORT, 'RETRY requires an atomically linked successor Attempt'); END;

CREATE TRIGGER attempts_nonretry_forbids_successor
BEFORE UPDATE OF state ON attempts
WHEN NEW.state IN ('approved','rejected','cancelled') AND NEW.successor_attempt_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'only a RETRY may link a successor Attempt'); END;

CREATE TRIGGER attempts_terminal_immutable
BEFORE UPDATE ON attempts
WHEN OLD.state IN ('approved','rejected','retried','cancelled')
BEGIN SELECT RAISE(ABORT, 'completed attempts are immutable'); END;

CREATE TRIGGER attempts_immutable_delete
BEFORE DELETE ON attempts
BEGIN SELECT RAISE(ABORT, 'attempts are retained for audit'); END;
`

export const MIGRATION_003 = String.raw`
CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  review_digest TEXT NOT NULL,
  execution_snapshot_hash TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  worktree_head TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  verification_digest TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  output_ref TEXT NOT NULL,
  output_commit TEXT NOT NULL,
  output_tree TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'promoted', 'failed')),
  actor TEXT NOT NULL,
  rationale TEXT NOT NULL,
  failure_reason TEXT,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- The instant after which a still-pending Promotion is provably abandoned.
  -- Reconciliation may only settle a pending row from its Git ref once this
  -- lease has expired, so a promotion still in flight in another Host is never
  -- failed out from under it. Written once, with the intent, and never moved.
  lease_expires_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT;

CREATE INDEX promotions_attempt_idx ON promotions(attempt_id, created_at, id);

-- At most one unfailed Promotion may exist for an Attempt, and at most one
-- unfailed Promotion may own a Forgeyard ref. A failed Promotion is retained
-- for audit and releases both, so an explicit retry is possible.
CREATE UNIQUE INDEX promotions_active_attempt_idx ON promotions(attempt_id) WHERE status <> 'failed';
CREATE UNIQUE INDEX promotions_active_ref_idx ON promotions(output_ref) WHERE status <> 'failed';

CREATE TRIGGER promotions_insert_guard
BEFORE INSERT ON promotions
WHEN NEW.status <> 'pending' OR NEW.failure_reason IS NOT NULL OR NEW.settled_at IS NOT NULL
  OR NEW.lease_expires_at <= NEW.created_at
  OR NOT EXISTS (
    SELECT 1 FROM attempts
    WHERE id=NEW.attempt_id AND state='approved'
      AND execution_snapshot_hash=NEW.execution_snapshot_hash
      AND base_commit=NEW.base_commit
  )
  OR NOT EXISTS (
    SELECT 1 FROM decisions
    WHERE id=NEW.decision_id AND attempt_id=NEW.attempt_id
      AND type='APPROVE' AND review_digest=NEW.review_digest
  )
BEGIN SELECT RAISE(ABORT, 'a Promotion must begin as one pending record bound to the Attempt''s terminal APPROVE Decision'); END;

CREATE TRIGGER promotions_authority_immutable
BEFORE UPDATE OF id, attempt_id, decision_id, review_digest, execution_snapshot_hash, base_commit,
  worktree_head, evidence_digest, verification_digest, projection_json, projection_hash, object_format,
  output_ref, output_commit, output_tree, actor, rationale, hash, created_at, lease_expires_at ON promotions
BEGIN SELECT RAISE(ABORT, 'promotion authority is immutable'); END;

CREATE TRIGGER promotions_settle_once
BEFORE UPDATE OF status, failure_reason, settled_at ON promotions
WHEN OLD.status <> 'pending' OR NEW.status NOT IN ('promoted', 'failed') OR NEW.settled_at IS NULL
  OR (NEW.status='promoted' AND NEW.failure_reason IS NOT NULL)
  OR (NEW.status='failed' AND NEW.failure_reason IS NULL)
BEGIN SELECT RAISE(ABORT, 'a pending Promotion settles exactly once as promoted or failed'); END;

CREATE TRIGGER promotions_immutable_delete
BEFORE DELETE ON promotions
BEGIN SELECT RAISE(ABORT, 'promotions are retained for audit'); END;
`

export const MIGRATIONS = [
  { version: 1, name: '001_initial', sql: MIGRATION_001 },
  { version: 2, name: '002_authority_hardening', sql: MIGRATION_002 },
  { version: 3, name: '003_local_promotion', sql: MIGRATION_003 },
] as const
