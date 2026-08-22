CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  repository_json TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  pipe_json TEXT NOT NULL,
  pipe_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  source_node_key TEXT NOT NULL,
  specification_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  ordinal INTEGER NOT NULL,
  execution_snapshot_json TEXT NOT NULL,
  execution_snapshot_hash TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  dsh_session_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'worktree_ready', 'session_bound', 'running', 'verifying',
    'awaiting_decision', 'approved', 'rejected', 'retried', 'cancelled', 'interrupted', 'needs_review'
  )),
  started_at INTEGER,
  ended_at INTEGER,
  git_fingerprint TEXT,
  terminal_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(task_id, ordinal)
) STRICT;

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('git', 'verification-command')),
  collector_id TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('COMPLETE', 'INCOMPLETE')),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  run_id TEXT NOT NULL,
  requirement_index INTEGER NOT NULL,
  requirement_json TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  evidence_set_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL', 'ERROR', 'INCOMPLETE')),
  rationale TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(attempt_id, run_id, requirement_index)
) STRICT;

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  type TEXT NOT NULL CHECK (type IN ('APPROVE', 'REJECT', 'RETRY', 'CANCEL')),
  review_digest TEXT NOT NULL,
  actor TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

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

CREATE TRIGGER attempts_authority_immutable
BEFORE UPDATE OF task_id, ordinal, execution_snapshot_json, execution_snapshot_hash,
  base_commit, worktree_path, dsh_session_id, created_at ON attempts
BEGIN SELECT RAISE(ABORT, 'attempt authority is immutable'); END;

CREATE TRIGGER attempts_terminal_immutable
BEFORE UPDATE OF state ON attempts
WHEN OLD.state IN ('approved', 'rejected', 'retried', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'completed attempts cannot become running again'); END;
