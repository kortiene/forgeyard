ALTER TABLE attempts ADD COLUMN worktree_device TEXT;
ALTER TABLE attempts ADD COLUMN worktree_inode TEXT;
ALTER TABLE attempts ADD COLUMN raw_workspace_baseline_json TEXT;
ALTER TABLE attempts ADD COLUMN raw_workspace_baseline_hash TEXT;
ALTER TABLE attempts ADD COLUMN retry_of_attempt_id TEXT REFERENCES attempts(id);
ALTER TABLE attempts ADD COLUMN successor_attempt_id TEXT REFERENCES attempts(id);

CREATE UNIQUE INDEX attempts_retry_predecessor_idx
ON attempts(retry_of_attempt_id) WHERE retry_of_attempt_id IS NOT NULL;

CREATE UNIQUE INDEX attempts_retry_successor_idx
ON attempts(successor_attempt_id) WHERE successor_attempt_id IS NOT NULL;

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
WHEN EXISTS (
  SELECT 1 FROM attempts
  WHERE id=NEW.attempt_id AND state IN ('approved','rejected','retried','cancelled')
)
BEGIN SELECT RAISE(ABORT, 'terminal Attempt Evidence is sealed'); END;

CREATE TRIGGER verifications_terminal_sealed
BEFORE INSERT ON verifications
WHEN EXISTS (
  SELECT 1 FROM attempts
  WHERE id=NEW.attempt_id AND state IN ('approved','rejected','retried','cancelled')
)
BEGIN SELECT RAISE(ABORT, 'terminal Attempt Verifications are sealed'); END;

CREATE TRIGGER decisions_terminal_sealed
BEFORE INSERT ON decisions
WHEN EXISTS (
  SELECT 1 FROM attempts
  WHERE id=NEW.attempt_id AND state IN ('approved','rejected','retried','cancelled')
)
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
