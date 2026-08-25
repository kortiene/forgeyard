import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  AttemptRecord,
  DecisionRecord,
  EvidenceRecord,
  ExecutionSnapshot,
  MissionRecord,
  RawWorkspaceManifest,
  ResolvedPolicySnapshot,
  TaskRecord,
} from '../../packages/forgeyard/src/types.ts'
import { canonicalJson, hashRecord, sha256 } from '../../packages/forgeyard/src/host/hash.ts'
import { MIGRATION_001, MIGRATION_002, MIGRATIONS } from '../../packages/forgeyard/src/host/migrations.ts'
import {
  assertAttemptRecordIntegrity,
  ForgeyardStore,
} from '../../packages/forgeyard/src/host/store.ts'

const POLICY: ResolvedPolicySnapshot = {
  provider: 'provider',
  model: 'model',
  reasoningEffort: null,
  agentPreset: 'default',
  permissionPreset: 'workspace-write',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'ask',
  toolPolicy: { version: 1, mode: 'frozen-schema', allowedToolNames: ['shell'], schemaHash: 'f'.repeat(64) },
}

describe('Forgeyard SQLite authority migration and retry transaction', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  async function databasePath(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `forgeyard-store-${name}-`))
    roots.push(root)
    return join(root, 'state', 'forgeyard.sqlite')
  }

  it('keeps earlier migrations immutable and upgrades an existing v1 database to authority schema 3', async () => {
    const migrationFile = await readFile(join(import.meta.dirname, '../../packages/forgeyard/migrations/001_initial.sql'), 'utf8')
    expect(migrationFile).not.toContain('worktree_device')
    expect(MIGRATION_001).not.toContain('worktree_device')
    // Milestone 2 is forward-only: promotion authority exists in migration 003
    // alone and never edits the accepted Milestone 1 schema.
    const hardening = await readFile(join(import.meta.dirname, '../../packages/forgeyard/migrations/002_authority_hardening.sql'), 'utf8')
    expect(migrationFile).not.toContain('promotions')
    expect(hardening).not.toContain('promotions')
    expect(MIGRATION_001).not.toContain('promotions')
    expect(MIGRATION_002).not.toContain('promotions')

    const path = await databasePath('upgrade')
    await mkdir(dirname(path), { recursive: true })
    const legacy = new DatabaseSync(path)
    legacy.exec('PRAGMA foreign_keys=ON')
    legacy.exec(MIGRATION_001)
    legacy.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (1,?,?)').run('001_initial', 1)
    legacy.exec('PRAGMA user_version=1')
    const { mission, task } = fixtures()
    insertLegacyMissionTask(legacy, mission, task)
    const attempt = attemptFixture(task.id, 'attempt_legacy', 1, null)
    legacy.prepare(`INSERT INTO attempts
      (id,task_id,ordinal,execution_snapshot_json,execution_snapshot_hash,base_commit,worktree_path,
       dsh_session_id,state,started_at,ended_at,git_fingerprint,terminal_reason,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      attempt.id, attempt.taskId, attempt.ordinal, canonicalJson(attempt.executionSnapshot),
      attempt.executionSnapshotHash, attempt.baseCommit, attempt.worktreePath, attempt.dshSessionId,
      'running', 1, null, null, null, attempt.createdAt, attempt.updatedAt,
    )
    legacy.close()

    const store = new ForgeyardStore(path)
    try {
      expect((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
      expect((store.database.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all()))
        .toEqual([
          { version: 1, name: '001_initial' },
          { version: 2, name: '002_authority_hardening' },
          { version: 3, name: '003_local_promotion' },
        ])
      const upgraded = store.attempt(attempt.id)
      expect(upgraded).toMatchObject({ worktreeDevice: null, rawWorkspaceBaseline: null, retryOfAttemptId: null })
      expect(() => assertAttemptRecordIntegrity(upgraded as AttemptRecord)).toThrow(/no durable worktree identity/u)
    } finally {
      store.close()
    }
  })

  it('skips a migration another Host committed while this one was starting', async () => {
    const path = await databasePath('concurrent-migration')
    const first = new ForgeyardStore(path)
    first.close()

    // Reproduce the loser's exact durable state in a shared database: the
    // winning Host applied and recorded 003 inside its write transaction, and
    // this Host read `user_version` before that commit landed. Re-executing the
    // migration on that stale read would fail this Host's whole startup.
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version=2')
    raw.close()

    const second = new ForgeyardStore(path)
    try {
      expect((second.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
      // Applied exactly once, by the Host that won the write transaction.
      expect(second.database.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all())
        .toEqual([
          { version: 1, name: '001_initial' },
          { version: 2, name: '002_authority_hardening' },
          { version: 3, name: '003_local_promotion' },
        ])
    } finally {
      second.close()
    }
  })

  it('keeps the Host migration mirror semantically identical to the checked-in SQL', async () => {
    // The Host bundles its migrations as source strings for single-file
    // packaging, so the checked-in .sql files could silently drift from what a
    // real database is actually built with. Build both and compare schemas.
    const fromFiles = new DatabaseSync(':memory:')
    const fromMirror = new DatabaseSync(':memory:')
    try {
      for (const migration of MIGRATIONS) {
        const file = join(
          import.meta.dirname,
          `../../packages/forgeyard/migrations/${migration.name}.sql`,
        )
        fromFiles.exec(await readFile(file, 'utf8'))
        fromMirror.exec(migration.sql)
      }
      const schemaOf = (database: DatabaseSync): unknown[] =>
        (database.prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        ).all() as Array<Record<string, unknown>>)
          .map(row => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replaceAll(/\s+/gu, '') : row.sql }))
      expect(schemaOf(fromMirror)).toEqual(schemaOf(fromFiles))
      expect(MIGRATIONS.map(migration => migration.version)).toEqual([1, 2, 3])
    } finally {
      fromFiles.close()
      fromMirror.close()
    }
  })

  it('atomically materializes one Task per frozen serial Pipe node', async () => {
    const path = await databasePath('serial-pipe')
    const store = new ForgeyardStore(path)
    try {
      const { mission, tasks } = serialFixtures()
      store.insertMissionAndTasks(mission, tasks)
      expect(store.mission(mission.id)).toEqual(mission)
      const stored = store.tasksForMission(mission.id)
      expect(stored).toHaveLength(2)
      expect(new Map(stored.map(task => [task.sourceNodeKey, task]))).toEqual(
        new Map(tasks.map(task => [task.sourceNodeKey, task])),
      )
      expect(stored.find(task => task.sourceNodeKey === 'root')?.dependencies).toEqual([])
      expect(stored.find(task => task.sourceNodeKey === 'follow-up')?.dependencies).toEqual([tasks[0].id])
    } finally {
      store.close()
    }
  })

  it('rejects inconsistent Pipe/Task authority before writing any row', async () => {
    const path = await databasePath('serial-pipe-invalid')
    const store = new ForgeyardStore(path)
    try {
      const fixture = serialFixtures()
      const duplicateKeyPipe = {
        nodes: [fixture.mission.pipe.nodes[0], {
          ...fixture.mission.pipe.nodes[1], key: fixture.mission.pipe.nodes[0]?.key as string,
        }],
      }
      const invalidEdgePipe = {
        nodes: [fixture.mission.pipe.nodes[0], { ...fixture.mission.pipe.nodes[1], dependsOn: [] }],
      }
      const cases: Array<{ label: string; mission: MissionRecord; tasks: TaskRecord[]; message: RegExp }> = [
        {
          label: 'no Tasks',
          mission: fixture.mission,
          tasks: [],
          message: /one Task per one- or two-node Pipe/u,
        },
        {
          label: 'Task count mismatch',
          mission: fixture.mission,
          tasks: [fixture.tasks[0]],
          message: /one Task per one- or two-node Pipe/u,
        },
        {
          label: 'duplicate Pipe node key',
          mission: { ...fixture.mission, pipe: duplicateKeyPipe, pipeHash: hashRecord(duplicateKeyPipe) },
          tasks: fixture.tasks,
          message: /Pipe node key .* duplicated/u,
        },
        {
          label: 'non-serial Pipe edge',
          mission: { ...fixture.mission, pipe: invalidEdgePipe, pipeHash: hashRecord(invalidEdgePipe) },
          tasks: fixture.tasks,
          message: /follow-up Pipe node must depend exactly/u,
        },
        {
          label: 'invalid Pipe hash',
          mission: { ...fixture.mission, pipeHash: '0'.repeat(64) },
          tasks: fixture.tasks,
          message: /Pipe hash is invalid/u,
        },
        {
          label: 'wrong Mission',
          mission: fixture.mission,
          tasks: [fixture.tasks[0], { ...fixture.tasks[1], missionId: 'mission_other' }],
          message: /different Mission/u,
        },
        {
          label: 'duplicate node key',
          mission: fixture.mission,
          tasks: [fixture.tasks[0], { ...fixture.tasks[1], sourceNodeKey: fixture.tasks[0].sourceNodeKey }],
          message: /Task node key .* duplicated/u,
        },
        {
          label: 'specification mismatch',
          mission: fixture.mission,
          tasks: [fixture.tasks[0], {
            ...fixture.tasks[1],
            specification: { ...fixture.tasks[1].specification, instruction: 'Different instruction' },
          }],
          message: /specification does not match/u,
        },
        {
          label: 'dependency mismatch',
          mission: fixture.mission,
          tasks: [fixture.tasks[0], { ...fixture.tasks[1], dependencies: [] }],
          message: /dependencies do not match/u,
        },
      ]
      for (const item of cases) {
        expect(() => store.insertMissionAndTasks(item.mission, item.tasks), item.label).toThrow(item.message)
        expect(store.missions(), item.label).toEqual([])
        expect(store.tasksForMission(item.mission.id), item.label).toEqual([])
      }
    } finally {
      store.close()
    }
  })

  it('rolls back the Mission and first Task when a later Task insert fails', async () => {
    const path = await databasePath('serial-pipe-rollback')
    const store = new ForgeyardStore(path)
    try {
      const existing = seed(store)
      const fixture = serialFixtures()
      const collidingTasks: [TaskRecord, TaskRecord] = [
        fixture.tasks[0],
        { ...fixture.tasks[1], id: existing.task.id },
      ]
      expect(() => store.insertMissionAndTasks(fixture.mission, collidingTasks)).toThrow()
      expect(store.mission(fixture.mission.id)).toBeUndefined()
      expect(store.tasksForMission(fixture.mission.id)).toEqual([])
      expect(store.mission(existing.mission.id)).toEqual(existing.mission)
      expect(store.task(existing.task.id)).toEqual(existing.task)
    } finally {
      store.close()
    }
  })

  it('binds the raw workspace baseline with filesystem identity exactly once', async () => {
    const path = await databasePath('baseline')
    const store = new ForgeyardStore(path)
    try {
      const { task } = seed(store)
      const attempt = attemptFixture(task.id, 'attempt_initial', 1, null)
      store.createAttempt(attempt)
      const baseline = baselineFixture()
      const bound = store.bindWorktreeIdentity(attempt.id, '10', '20', baseline, baseline.hash)
      expect(bound).toMatchObject({
        worktreeDevice: '10',
        worktreeInode: '20',
        rawWorkspaceBaselineHash: baseline.hash,
      })
      expect(bound.rawWorkspaceBaseline).toEqual(baseline)
      expect(() => store.bindWorktreeIdentity(attempt.id, '10', '20', baseline, baseline.hash))
        .toThrow(/only be bound once/u)
      const forged = { ...baseline, hash: '0'.repeat(64) }
      expect(() => store.bindWorktreeIdentity('missing', '10', '20', forged, forged.hash))
        .toThrow(/baseline integrity/u)
    } finally {
      store.close()
    }
  })

  it('commits predecessor Decision/state/link and successor authority in one retry transaction', async () => {
    const path = await databasePath('retry')
    const store = new ForgeyardStore(path)
    try {
      const { task } = seed(store)
      const predecessor = attemptFixture(task.id, 'attempt_one', 1, null)
      store.createAttempt(predecessor)
      const baseline = baselineFixture()
      store.bindWorktreeIdentity(predecessor.id, '10', '20', baseline, baseline.hash)
      store.transition(predecessor.id, 'worktree_ready')
      store.transition(predecessor.id, 'session_bound')
      store.transition(predecessor.id, 'running')
      store.transition(predecessor.id, 'verifying')
      store.transition(predecessor.id, 'awaiting_decision')

      const invalid = attemptFixture(task.id, 'attempt_invalid', 2, predecessor.id)
      invalid.executionSnapshotHash = '0'.repeat(64)
      const decision = retryDecision(predecessor.id)
      expect(() => store.recordRetryAndCreateSuccessor(decision, invalid, 'retry'))
        .toThrow(/snapshot hash/u)
      expect(store.attempt(predecessor.id)).toMatchObject({ state: 'awaiting_decision', successorAttemptId: null })
      expect(store.attempt(invalid.id)).toBeUndefined()
      expect(store.decisions(predecessor.id)).toEqual([])

      const successor = attemptFixture(task.id, 'attempt_two', 2, predecessor.id)
      const committed = store.recordRetryAndCreateSuccessor(decision, successor, 'retry requested')
      expect(committed.predecessor).toMatchObject({ state: 'retried', successorAttemptId: successor.id })
      expect(committed.successor).toMatchObject({ state: 'preparing', retryOfAttemptId: predecessor.id })
      expect(store.decisions(predecessor.id).map(item => item.type)).toEqual(['RETRY'])
      expect(() => store.createAttempt(attemptFixture(task.id, 'attempt_extra', 1, null)))
        .toThrow(/initial Attempt/u)

      const sealed = gitEvidence(predecessor.id)
      expect(() => store.appendEvidence(sealed)).toThrow(/terminal Attempt Evidence is sealed/u)
      expect(() => store.database.prepare(`INSERT INTO decisions
        (id,attempt_id,type,review_digest,actor,rationale,created_at) VALUES (?,?,?,?,?,?,?)`).run(
        'decision_second', predecessor.id, 'RETRY', 'digest', 'operator', 'again', 3,
      )).toThrow(/terminal Attempt Decisions|Decision type is invalid/u)
      expect(() => store.database.prepare('UPDATE attempts SET terminal_reason=? WHERE id=?').run('tampered', predecessor.id))
        .toThrow(/completed attempts are immutable/u)
    } finally {
      store.close()
    }
  })
})

function fixtures(): { mission: MissionRecord; task: TaskRecord } {
  const pipe = {
    nodes: [{ key: 'implement', task: 'Do work', verify: [{ key: 'verify-1', command: 'true', argv: ['true'] }] }],
  }
  const mission: MissionRecord = {
    id: 'mission_one',
    title: 'Mission',
    objective: 'Objective',
    repository: {
      path: '/repo', baseRef: 'main', checkoutHead: 'a'.repeat(40), checkoutStatusHash: sha256(''),
      gitDir: '/repo/.git', gitCommonDir: '/repo/.git',
      pathDevice: '1', pathInode: '2', gitDirDevice: '1', gitDirInode: '3',
      gitCommonDirDevice: '1', gitCommonDirInode: '3', ownerUid: '1000',
    },
    baseRef: 'main',
    defaultPolicy: POLICY,
    pipe,
    pipeHash: hashRecord(pipe),
    createdAt: 1,
  }
  const task: TaskRecord = {
    id: 'task_one',
    missionId: mission.id,
    sourceNodeKey: 'implement',
    specification: {
      title: 'Mission', objective: 'Objective', instruction: 'Do work',
      verification: [{ key: 'verify-1', command: 'true', argv: ['true'] }],
    },
    dependencies: [],
    createdAt: 1,
  }
  return { mission, task }
}

function serialFixtures(): { mission: MissionRecord; tasks: [TaskRecord, TaskRecord] } {
  const base = fixtures()
  const verify = base.task.specification.verification
  const pipe = {
    nodes: [
      { key: 'root', task: 'Do root work', verify, dependsOn: [] },
      { key: 'follow-up', task: 'Do follow-up work', verify, dependsOn: ['root'] },
    ],
  }
  const mission: MissionRecord = {
    ...base.mission,
    id: 'mission_serial',
    title: 'Serial Mission',
    objective: 'Materialize one atomic serial Pipe.',
    pipe,
    pipeHash: hashRecord(pipe),
    createdAt: 2,
  }
  const root: TaskRecord = {
    ...base.task,
    id: 'task_serial_root',
    missionId: mission.id,
    sourceNodeKey: 'root',
    specification: {
      title: mission.title,
      objective: mission.objective,
      instruction: pipe.nodes[0].task,
      verification: verify,
    },
    dependencies: [],
    createdAt: mission.createdAt,
  }
  const followUp: TaskRecord = {
    ...base.task,
    id: 'task_serial_follow_up',
    missionId: mission.id,
    sourceNodeKey: 'follow-up',
    specification: {
      title: mission.title,
      objective: mission.objective,
      instruction: pipe.nodes[1].task,
      verification: verify,
    },
    dependencies: [root.id],
    createdAt: mission.createdAt,
  }
  return { mission, tasks: [root, followUp] }
}

function seed(store: ForgeyardStore): { mission: MissionRecord; task: TaskRecord } {
  const value = fixtures()
  store.insertMissionAndTasks(value.mission, [value.task])
  return value
}

function insertLegacyMissionTask(database: DatabaseSync, mission: MissionRecord, task: TaskRecord): void {
  database.prepare(`INSERT INTO missions
    (id,title,objective,repository_json,base_ref,policy_json,pipe_json,pipe_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    mission.id, mission.title, mission.objective, canonicalJson(mission.repository), mission.baseRef,
    canonicalJson(mission.defaultPolicy), canonicalJson(mission.pipe), mission.pipeHash, mission.createdAt,
  )
  database.prepare(`INSERT INTO tasks
    (id,mission_id,source_node_key,specification_json,dependencies_json,created_at)
    VALUES (?,?,?,?,?,?)`).run(
    task.id, task.missionId, task.sourceNodeKey, canonicalJson(task.specification), canonicalJson(task.dependencies), task.createdAt,
  )
}

function attemptFixture(taskId: string, id: string, ordinal: number, retryOfAttemptId: string | null): AttemptRecord {
  const createdAt = ordinal
  const executionSnapshot: ExecutionSnapshot = {
    version: 1,
    attemptId: id,
    ordinal,
    task: fixtures().task.specification,
    repository: fixtures().mission.repository,
    baseCommit: 'b'.repeat(40),
    policy: POLICY,
    verification: fixtures().task.specification.verification,
    createdAt,
  }
  return {
    id,
    taskId,
    ordinal,
    executionSnapshot,
    executionSnapshotHash: hashRecord(executionSnapshot),
    baseCommit: executionSnapshot.baseCommit,
    worktreePath: `/worktrees/${id}`,
    worktreeDevice: null,
    worktreeInode: null,
    rawWorkspaceBaseline: null,
    rawWorkspaceBaselineHash: null,
    retryOfAttemptId,
    successorAttemptId: null,
    dshSessionId: `session_${id}`,
    state: 'preparing',
    startedAt: null,
    endedAt: null,
    gitFingerprint: null,
    terminalReason: null,
    createdAt,
    updatedAt: createdAt,
  }
}

function baselineFixture(): RawWorkspaceManifest {
  const entries: RawWorkspaceManifest['entries'] = [{
    path: '.', type: 'directory', mode: '16832', uid: '1000', gid: '1000', device: '10', inode: '20',
    nlink: '2', size: '64', mtimeNs: '1', ctimeNs: '1', contentHash: null, linkHash: null,
  }]
  const canonical = canonicalJson({ entries, rootPath: '.', version: 1 })
  return { version: 1, rootPath: '.', entries, canonical, hash: sha256(canonical) }
}

function retryDecision(attemptId: string): DecisionRecord {
  return {
    id: 'decision_retry', attemptId, type: 'RETRY', reviewDigest: 'review-digest',
    actor: 'operator', rationale: 'try again', createdAt: 2,
  }
}

function gitEvidence(attemptId: string): EvidenceRecord {
  const payload: EvidenceRecord['payload'] = {
    kind: 'git',
    baseCommit: 'b'.repeat(40),
    headCommit: 'b'.repeat(40),
    fingerprint: {
      baseCommit: 'b'.repeat(40), headCommit: 'b'.repeat(40), statusHash: 'a', diffHash: 'b',
      untrackedHash: 'c', workspaceHash: 'd', digest: 'e',
    },
    changedFiles: [], diff: '', diffBytes: 0, diffTruncated: false, ignoredFilesExcluded: false,
  }
  const core = {
    attemptId, runId: 'run_one', kind: payload.kind, collectorId: 'collector', collectorVersion: '1',
    payload, completeness: 'COMPLETE' as const, createdAt: 2,
  }
  return { id: 'evidence_after_terminal', ...core, hash: hashRecord(core) }
}
