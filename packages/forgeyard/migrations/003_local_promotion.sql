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
  output_ref, output_commit, output_tree, actor, rationale, hash, created_at ON promotions
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
