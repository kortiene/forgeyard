import { platform, arch } from 'node:os'
import type {
  AttemptRecord,
  CommandEvidencePayload,
  EvidenceRecord,
  VerificationRecord,
  VerificationRequirement,
  VerificationStatus,
} from '../types.ts'
import type { GitAuthority, PreparedWorktree } from './git.ts'
import { canonicalJson, forgeyardId, hashRecord, sha256 } from './hash.ts'
import { bounded, type ProcessRunner } from './process.ts'
import type { VerifierConfinement, VerifierConfinementResult } from './verifier.ts'

const COLLECTOR_ID = 'forgeyard.trusted-collector'
const COLLECTOR_VERSION = '1.0.0'
const EVALUATOR_ID = 'forgeyard.exit-code-evaluator'
const EVALUATOR_VERSION = '1.0.0'

export interface EvidenceConfig {
  commandTimeoutMs: number
  outputBytes: number
  spillBytes: number
}

function recordEvidence(
  attempt: AttemptRecord,
  runId: string,
  payload: EvidenceRecord['payload'],
  completeness: EvidenceRecord['completeness'],
): EvidenceRecord {
  const createdAt = Date.now()
  const core = {
    attemptId: attempt.id,
    runId,
    kind: payload.kind,
    collectorId: COLLECTOR_ID,
    collectorVersion: COLLECTOR_VERSION,
    payload,
    completeness,
    createdAt,
  }
  return { id: forgeyardId('evidence'), ...core, hash: hashRecord(core) }
}

function statusOf(payload: CommandEvidencePayload, complete: boolean): { status: VerificationStatus; rationale: string } {
  if (!complete) return { status: 'INCOMPLETE', rationale: 'The trusted collector could not retain complete command output.' }
  if (payload.spawnError !== null) return { status: 'ERROR', rationale: `Verifier could not start: ${payload.spawnError}` }
  if (payload.timedOut) return { status: 'ERROR', rationale: 'Verifier exceeded its frozen deadline.' }
  if (payload.signal !== null || payload.exitCode === null) return { status: 'ERROR', rationale: `Verifier terminated without an exit code (${payload.signal ?? 'unknown'}).` }
  if (payload.exitCode === 0) return { status: 'PASS', rationale: 'Trusted verifier exited with code 0.' }
  return { status: 'FAIL', rationale: `Trusted verifier exited with code ${payload.exitCode}.` }
}

/** Only this Host-side collector can create trusted Evidence records. */
export class TrustedEvidenceCollector {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly git: GitAuthority,
    private readonly config: EvidenceConfig,
    private readonly confinement: VerifierConfinement,
  ) {}

  async collectGit(attempt: AttemptRecord, prepared: PreparedWorktree, runId: string): Promise<EvidenceRecord> {
    const collected = await this.git.collect(prepared)
    return recordEvidence(attempt, runId, collected.payload, collected.completeness)
  }

  async collectCommand(
    attempt: AttemptRecord,
    requirement: VerificationRequirement,
    runId: string,
    signal?: AbortSignal,
  ): Promise<{ evidence: EvidenceRecord; verification: VerificationRecord }> {
    let confined: VerifierConfinementResult | null = null
    let confinementError: string | null = null
    try {
      confined = await this.confinement.confine(attempt, requirement.argv)
    } catch (error) {
      confinementError = error instanceof Error ? error.message : String(error)
    }
    const result = confined === null
      ? {
          exitCode: null,
          signal: null,
          durationMs: 0,
          timedOut: false,
          spawnError: `Verifier confinement failed: ${confinementError ?? 'unknown error'}`,
          stdout: { text: '', bytes: 0, hash: sha256(''), truncated: false, complete: true },
          stderr: { text: '', bytes: 0, hash: sha256(''), truncated: false, complete: true },
        }
      : await this.runner.run({
          argv: confined.argv,
          cwd: attempt.worktreePath,
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: this.config.commandTimeoutMs,
          memoryLimitBytes: this.config.outputBytes,
          spillLimitBytes: this.config.spillBytes,
          env: { CI: '1', NO_COLOR: '1', FORGEYARD_ATTEMPT_ID: attempt.id },
        })
    const stdout = bounded(result.stdout.text, this.config.outputBytes)
    const stderr = bounded(result.stderr.text, this.config.outputBytes)
    const payload: CommandEvidencePayload = {
      kind: 'verification-command',
      requirementKey: requirement.key,
      command: requirement.command,
      argv: [...requirement.argv],
      cwd: attempt.worktreePath,
      environment: [
        { name: 'platform', value: platform() },
        { name: 'arch', value: arch() },
        { name: 'node', value: process.version },
        { name: 'CI', value: '1' },
        { name: 'NO_COLOR', value: '1' },
        { name: 'FORGEYARD_ATTEMPT_ID', value: attempt.id },
        { name: 'subprocess-policy', value: 'DSH scrubbed ambient environment + explicit facts' },
        { name: 'sandbox-mode', value: confined?.mode ?? attempt.executionSnapshot.policy.sandboxMode },
        { name: 'sandbox-enforcement', value: confined?.enforcement ?? 'refused' },
        { name: 'sandbox-workspace', value: confined?.workspaceRoot ?? attempt.worktreePath },
        { name: 'executed-argv-sha256', value: confined === null ? 'not-executed' : sha256(canonicalJson(confined.argv)) },
      ],
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdout: stdout.text,
      stdoutBytes: result.stdout.bytes,
      stdoutHash: result.stdout.hash,
      stdoutTruncated: stdout.truncated || result.stdout.truncated,
      stderr: stderr.text,
      stderrBytes: result.stderr.bytes,
      stderrHash: result.stderr.hash,
      stderrTruncated: stderr.truncated || result.stderr.truncated,
      timedOut: result.timedOut,
      spawnError: result.spawnError,
    }
    const complete = result.stdout.complete && result.stderr.complete
      && !stdout.truncated && !stderr.truncated && !result.stdout.truncated && !result.stderr.truncated
    const evidence = recordEvidence(attempt, runId, payload, complete ? 'COMPLETE' : 'INCOMPLETE')
    const evaluation = statusOf(payload, complete)
    const createdAt = Date.now()
    const evidenceSetDigest = sha256(evidence.hash)
    const core = {
      attemptId: attempt.id,
      runId,
      requirementIndex: attempt.executionSnapshot.verification.findIndex(item => item.key === requirement.key),
      requirement,
      evaluator: EVALUATOR_ID,
      evaluatorVersion: EVALUATOR_VERSION,
      evidenceIds: [evidence.id],
      evidenceSetDigest,
      status: evaluation.status,
      rationale: evaluation.rationale,
      createdAt,
    }
    const verification: VerificationRecord = {
      id: forgeyardId('verification'),
      ...core,
      hash: hashRecord(core),
    }
    return { evidence, verification }
  }
}
