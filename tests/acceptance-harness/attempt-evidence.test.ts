import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- the acceptance harness is plain ESM JavaScript, not part of a tsconfig project.
import { ANSWER_PATH, EXPECTED_ANSWER, VERIFIER_PATH, assertTrustedPass, durationMs, gitBlobId, recordedBlobId } from '../../scripts/harness/attempt-evidence.mjs'

const WORKTREE = '/case-sensitive/worktrees/attempt-1'
const REQUIRED_BLOB = execFileSync('git', ['hash-object', '--stdin'], { input: EXPECTED_ANSWER }).toString().trim()
const PLACEHOLDER_BLOB = execFileSync('git', ['hash-object', '--stdin'], { input: 'PLACEHOLDER\n' }).toString().trim()

function diffFor(path: string, before: string, after: string): string {
  const beforeBlob = execFileSync('git', ['hash-object', '--stdin'], { input: before }).toString().trim()
  const afterBlob = execFileSync('git', ['hash-object', '--stdin'], { input: after }).toString().trim()
  return [
    `diff --git a/${path} b/${path}`,
    `index ${beforeBlob}..${afterBlob} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    `-${before.trimEnd()}`,
    `+${after.trimEnd()}`,
    '',
  ].join('\n')
}

/** A trusted AttemptView shaped exactly like a complete, confined, passing run. */
function passingView({
  changedFiles = [{ status: 'M', path: ANSWER_PATH }],
  diff = diffFor(ANSWER_PATH, 'PLACEHOLDER\n', EXPECTED_ANSWER),
  diffTruncated = false,
  exitCode = 0,
}: {
  changedFiles?: { status: string; path: string }[]
  diff?: string
  diffTruncated?: boolean
  exitCode?: number
} = {}) {
  return {
    review: { latestRunId: 'run-1', canApprove: true, reviewDigest: 'digest-1' },
    evidence: [
      {
        runId: 'run-1',
        completeness: 'COMPLETE',
        payload: { kind: 'git', changedFiles, diff, diffTruncated },
      },
      {
        runId: 'run-1',
        completeness: 'COMPLETE',
        payload: {
          kind: 'verification-command',
          exitCode,
          environment: [
            { name: 'sandbox-enforcement', value: 'full' },
            { name: 'sandbox-workspace', value: WORKTREE },
            { name: 'sandbox-mode', value: 'workspace-write' },
            { name: 'executed-argv-sha256', value: 'a'.repeat(64) },
          ],
        },
      },
    ],
  }
}

describe('gitBlobId', () => {
  it('reproduces the identity git itself records for the promised bytes', () => {
    expect(gitBlobId(EXPECTED_ANSWER)).toBe(REQUIRED_BLOB)
    expect(gitBlobId('42')).not.toBe(REQUIRED_BLOB)
    expect(gitBlobId('PLACEHOLDER\n')).toBe(PLACEHOLDER_BLOB)
  })
})

describe('recordedBlobId', () => {
  it('reads the post-image id out of the recorded full-index diff', () => {
    const diff = diffFor(ANSWER_PATH, 'PLACEHOLDER\n', EXPECTED_ANSWER)
    expect(recordedBlobId(diff, ANSWER_PATH)).toBe(REQUIRED_BLOB)
  })

  it('scopes each file to its own section in a multi-file diff', () => {
    const diff = diffFor(ANSWER_PATH, 'PLACEHOLDER\n', EXPECTED_ANSWER)
      + diffFor(VERIFIER_PATH, 'process.exit(1)\n', 'process.exit(0)\n')
    expect(recordedBlobId(diff, ANSWER_PATH)).toBe(REQUIRED_BLOB)
    expect(recordedBlobId(diff, VERIFIER_PATH)).toBe(gitBlobId('process.exit(0)\n'))
  })

  it('returns null when the file has no recorded section', () => {
    expect(recordedBlobId(diffFor(VERIFIER_PATH, 'a\n', 'b\n'), ANSWER_PATH)).toBeNull()
  })
})

describe('assertTrustedPass', () => {
  it('accepts a complete, confined PASS that records exactly the promised change', () => {
    const result = assertTrustedPass(passingView(), WORKTREE, 'Attempt 1')
    expect(result.reviewDigest).toBe('digest-1')
    expect(result.answerStatus).toBe('M')
    expect(result.otherChangedPaths).toEqual([])
  })

  it('rejects a PASS whose recorded answer.txt is not the promised bytes', () => {
    // The verifier only checks the trimmed value, so "42" without the trailing
    // newline exits 0 while failing the acceptance contract.
    const view = passingView({ diff: diffFor(ANSWER_PATH, 'PLACEHOLDER\n', '42') })
    expect(() => assertTrustedPass(view, WORKTREE, 'Attempt 1'))
      .toThrow(/ACCEPTANCE FAILURE.*records answer\.txt as blob/su)
  })

  it('rejects a PASS the model manufactured by editing the verifier', () => {
    const view = passingView({
      changedFiles: [{ status: 'M', path: ANSWER_PATH }, { status: 'M', path: VERIFIER_PATH }],
      diff: diffFor(ANSWER_PATH, 'PLACEHOLDER\n', 'WRONG\n') + diffFor(VERIFIER_PATH, 'process.exit(1)\n', 'process.exit(0)\n'),
    })
    expect(() => assertTrustedPass(view, WORKTREE, 'Attempt 1'))
      .toThrow(/ACCEPTANCE FAILURE.*changed the verifier verify\.mjs/su)
  })

  it('rejects a PASS whose recorded diff was truncated', () => {
    const view = passingView({ diffTruncated: true })
    expect(() => assertTrustedPass(view, WORKTREE, 'Attempt 1')).toThrow(/diff is truncated/u)
  })

  it('still rejects an unconfined or failing verifier', () => {
    expect(() => assertTrustedPass(passingView({ exitCode: 1 }), WORKTREE, 'Attempt 1'))
      .toThrow(/exit code is 1, not 0/u)
    expect(() => assertTrustedPass(passingView(), '/some/other/worktree', 'Attempt 1'))
      .toThrow(/not the Attempt worktree/u)
  })

  it('reports, without rejecting, other paths the run touched', () => {
    const view = passingView({ changedFiles: [{ status: 'M', path: ANSWER_PATH }, { status: '?', path: 'scratch.log' }] })
    expect(assertTrustedPass(view, WORKTREE, 'Attempt 1').otherChangedPaths).toEqual(['? scratch.log'])
  })
})

describe('durationMs', () => {
  it('falls back when the override is absent or blank', () => {
    expect(durationMs('X', undefined, 1_000)).toBe(1_000)
    expect(durationMs('X', '   ', 1_000)).toBe(1_000)
  })

  it('accepts a finite positive override', () => {
    expect(durationMs('X', '5000', 1_000)).toBe(5_000)
  })

  it('rejects values that would make a deadline unreachable', () => {
    for (const raw of ['abc', 'Infinity', '-1', '0', 'NaN']) {
      expect(() => durationMs('FORGEYARD_MODEL_DEADLINE_MS', raw, 1_000))
        .toThrow(/must be a finite positive number of milliseconds/u)
    }
  })
})
