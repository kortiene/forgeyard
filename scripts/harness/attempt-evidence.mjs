// Pure acceptance-contract assertions over Host-trusted Forgeyard records.
//
// Kept out of the harness entry point so they can be exercised directly by the
// test suite: these predicates are the only thing standing between "the verifier
// exited 0" and "the model actually produced the promised change".

import { createHash } from 'node:crypto'

export const ANSWER_PATH = 'answer.txt'
export const VERIFIER_PATH = 'verify.mjs'
export const EXPECTED_ANSWER = '42\n'

/**
 * Resolve a duration override to a finite positive millisecond budget. A
 * nonnumeric or non-finite value would make every deadline comparison false and
 * park a polling harness forever, so it is rejected up front instead.
 */
export function durationMs(name, raw, fallback) {
  if (raw === undefined || raw === null || raw.trim().length === 0) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number of milliseconds, not ${JSON.stringify(raw)}`)
  }
  return value
}

/** Git's blob object id for exact bytes — the identity `git hash-object` prints. */
export function gitBlobId(content) {
  const bytes = Buffer.from(content, 'utf8')
  return createHash('sha1').update(`blob ${bytes.length}\u0000`).update(bytes).digest('hex')
}

/**
 * The post-image blob id the trusted Git Evidence recorded for `path`.
 *
 * The Host collects the diff with `--full-index`, so every file section carries
 * `index <before>..<after>`: the recorded content is identified exactly from the
 * Host record alone, never from a worktree read. Returns null when the file has
 * no recorded section or that section carries no index line.
 */
export function recordedBlobId(diff, path) {
  const header = `diff --git a/${path} b/${path}\n`
  const start = diff.indexOf(header)
  if (start === -1) return null
  const rest = diff.slice(start + header.length)
  const end = rest.indexOf('\ndiff --git ')
  const section = end === -1 ? rest : rest.slice(0, end)
  return /^index [0-9a-f]+\.\.([0-9a-f]{7,})(?: |$)/mu.exec(section)?.[1] ?? null
}

/**
 * Assert that a verified AttemptView carries a complete, trusted, fully-confined
 * PASS for the latest run: the model made the exact answer.txt change, Git
 * Evidence recorded it, and the verifier ran exit-0 under full DSH enforcement
 * in the exact worktree.
 *
 * A verifier exit code alone is not enough. `verify.mjs` is an ordinary worktree
 * file the model can edit, so a PASS is only evidence of the required change
 * when the same trusted Git Evidence also shows (a) the verification contract
 * untouched and (b) answer.txt recorded as exactly the promised bytes. Both are
 * read from the Host record, never from the worktree.
 *
 * Returns the current approvable review digest, the recorded answer.txt status,
 * and any other paths the run touched (reported, not rejected).
 */
export function assertTrustedPass(view, worktree, label) {
  const latestRunId = view.review?.latestRunId
  const latest = (view.evidence ?? []).filter((item) => item.runId === latestRunId)
  const git = latest.find((item) => item.payload?.kind === 'git')
  const command = latest.find((item) => item.payload?.kind === 'verification-command')
  if (git === undefined) throw new Error(`${label}: latest run has no trusted Git Evidence`)
  if (command === undefined) throw new Error(`${label}: latest run has no trusted verifier Evidence`)
  if (git.completeness !== 'COMPLETE') throw new Error(`${label}: Git Evidence is ${git.completeness}, not COMPLETE`)
  if (command.completeness !== 'COMPLETE') throw new Error(`${label}: verifier Evidence is ${command.completeness}, not COMPLETE`)
  const env = Object.fromEntries((command.payload.environment ?? []).map((fact) => [fact.name, fact.value]))
  if (env['sandbox-enforcement'] !== 'full') {
    throw new Error(`${label}: verifier ran without full DSH enforcement (sandbox-enforcement=${env['sandbox-enforcement'] ?? 'absent'})`)
  }
  if (env['sandbox-workspace'] !== worktree) {
    throw new Error(`${label}: verifier confined to ${env['sandbox-workspace'] ?? 'absent'}, not the Attempt worktree ${worktree}`)
  }
  if (env['sandbox-mode'] !== 'workspace-write' && env['sandbox-mode'] !== 'read-only') {
    throw new Error(`${label}: verifier sandbox-mode is ${env['sandbox-mode'] ?? 'absent'}, not a confined mode`)
  }
  if (!env['executed-argv-sha256'] || env['executed-argv-sha256'] === 'not-executed') {
    throw new Error(`${label}: verifier argv was never executed under confinement`)
  }
  if (command.payload.exitCode !== 0) throw new Error(`${label}: trusted verifier exit code is ${command.payload.exitCode}, not 0`)

  const changedFiles = git.payload.changedFiles ?? []
  const answerChange = changedFiles.find((file) => file.path === ANSWER_PATH)
  if (answerChange === undefined) {
    throw new Error(`${label}: Git Evidence did not record the ${ANSWER_PATH} change: ${JSON.stringify(changedFiles)}`)
  }
  const verifierChange = changedFiles.find((file) => file.path === VERIFIER_PATH)
  if (verifierChange !== undefined) {
    throw new Error(
      `${label}: ACCEPTANCE FAILURE — the model changed the verifier ${VERIFIER_PATH} `
      + `(status ${verifierChange.status}). A PASS produced under an altered verification contract is not `
      + 'evidence of the required change.',
    )
  }
  if (git.payload.diffTruncated === true) {
    throw new Error(`${label}: trusted Git Evidence diff is truncated; the recorded ${ANSWER_PATH} content cannot be validated`)
  }
  const recorded = recordedBlobId(git.payload.diff ?? '', ANSWER_PATH)
  const required = gitBlobId(EXPECTED_ANSWER)
  if (recorded !== required) {
    throw new Error(
      `${label}: ACCEPTANCE FAILURE — the verifier passed but trusted Git Evidence records ${ANSWER_PATH} as `
      + `blob ${recorded ?? 'no parseable index line'}, not the required ${JSON.stringify(EXPECTED_ANSWER)} (blob ${required}). `
      + `Recorded diff:\n${git.payload.diff ?? '(absent)'}`,
    )
  }

  if (view.review?.canApprove !== true) throw new Error(`${label}: review is not approvable: ${view.review?.reason ?? 'unknown'}`)
  return {
    reviewDigest: view.review.reviewDigest,
    answerStatus: answerChange.status,
    otherChangedPaths: changedFiles.filter((file) => file.path !== ANSWER_PATH).map((file) => `${file.status} ${file.path}`),
  }
}
