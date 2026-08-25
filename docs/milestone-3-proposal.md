# Milestone 3 proposal — One Useful Pipe

- Status: **Proposed, not implemented.** This document exists to resolve design
  questions *before* code, per the Milestone 3 mandate.
- DSH release: `0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`) — unchanged.

## Why this milestone, and why it is small

Milestones 1 and 2 proved the execution and governance architecture:
`Mission → Task → Attempt → worktree → Session → Evidence → Verification →
Decision → Promotion`. What they did **not** prove is that Forgeyard is a
*workspace* rather than a single-attempt review tool.

The honest gap: `PipeSnapshot` exists but `createMission` hard-codes one
`implement` node (`engine.ts:298`) and materializes exactly one Task with
`dependencies: []` (`engine.ts:316`). Nothing reads `dependencies` — a grep
across `src/host` finds only the write path in `store.ts` and the schema in
`migrations.ts`. There is no readiness calculation, no scheduling, and no output
propagation. `MissionCreateRequest` exposes a single `verificationCommand` even
though `VerificationRequirement[]` can already represent several.

Milestone 3 closes exactly that gap for **two serial nodes** and stops.

## Resolved design questions

These were open at handoff. Each is resolved with a reason drawn from the
current implementation.

### 1. Does every Pipe node require approval and promotion?

**Only nodes whose output feeds another node.** Promotion is a *delivery*
boundary, and ADR-0004 is explicit that `APPROVE` authorizes while `promote`
delivers. Forcing promotion on a terminal node would create durable refs nobody
consumes, which is ref-namespace litter, not governance.

The rule: a node with at least one downstream dependent **must** reach an
approved *and* promoted output before any dependent becomes ready, because the
promoted commit is what the dependent freezes. A terminal node needs only an
explicit Decision, exactly as today. In the Milestone 3 fixture, Task A is
upstream (must promote) and Task B is terminal (need not).

### 2. Is the existing Promotion ref the authoritative intermediate output?

**Yes, and it is already the right shape.** `refs/forgeyard/promotions/<attemptId>`
resolves to a deterministic commit whose tree was proven, entry by entry, to
equal the reviewed projection, whose parent is the Attempt's frozen base
(`promotions.output_commit`, `output_tree`, `base_commit`), and which the profile
smoke re-verifies from the operator's own repository *after the Host exits*.
That is a stronger intermediate-output guarantee than a Pipe layer could invent,
and it required no new machinery.

Milestone 3 must **not** introduce a second output concept. Task B's base is
literally `promotions.output_commit` for Task A's promoted Attempt.

### 3. How should a failed upstream Task affect downstream readiness?

**Downstream stays `blocked` and is never auto-started or auto-cancelled.**
Readiness is a *computed projection*, never stored state, so it cannot drift
from the records it summarizes. Proposed downstream states:

| Upstream condition | Downstream readiness |
| --- | --- |
| no Attempt yet, or Attempt running | `blocked` (dependency unsatisfied) |
| Attempt `rejected` / `cancelled` | `blocked` (with the upstream terminal reason surfaced) |
| `approved` but not promoted | `blocked` (output does not exist yet) |
| promoted, `status = 'promoted'` | `ready` (base commit resolved) |
| Promotion `failed` | `blocked` (an explicit upstream retry is required) |

A rejected upstream must **not** cascade a cancellation onto the downstream
Task: cancellation is an operator Decision with an actor and rationale, and
Forgeyard does not manufacture Decisions. The operator retries upstream, and
downstream becomes ready when a promoted output exists. This keeps the
fail-closed posture without inventing a scheduler.

### 4. May Task B remediate Task A?

**No — initially limited to an independent follow-up implementation.**
Remediation means Task B rewrites A's output, which immediately raises questions
Milestone 3 should not answer: does B's promotion supersede A's ref, is A's
Promotion still authoritative, and what does the commit chain mean when two
nodes claim one deliverable? Those are real questions, but answering them is
another milestone of integrity machinery — precisely what the strategic
assessment warns against.

Task B builds **on top of** A's promoted commit as its frozen base and produces
its own independent output. The commit chain stays a clean line:
`base → A.outputCommit → B.outputCommit`.

### 5. What is the smallest schema evolution?

**Very likely none.** This is the most important finding for scoping.

`tasks` already has `source_node_key` and `dependencies_json` (migration
`001_initial.sql:19-26`), and `store.ts:71` already parses `dependencies` into
`TaskRecord.dependencies: TaskId[]`. The columns were designed for this and have
been carried, unused, since Milestone 1. `missions.pipe_json` already stores a
multi-node `PipeSnapshot`.

`AttemptRecord.baseCommit` is already an arbitrary commit OID, and
`GitAuthority.createWorktree(repository, baseCommit, attemptId)`
(`git.ts:641`) already accepts any commit — it is not tied to `mission.baseRef`.
So freezing Task B's base to A's promoted commit needs **no** Git-authority
change; it changes only which OID `planAttempt` resolves.

The only real question is whether an Attempt must record *why* its base differs
from the Mission base ref. That is derivable (`task.dependencies` → upstream
Promotion → `output_commit`), and a derived fact should not be duplicated into a
column. **Proposal: attempt no migration.** If implementation proves a stored
provenance column is genuinely required, add one forward-only `004` migration
and never edit `001`–`003`.

## Acceptance criteria

A Milestone 3 acceptance run must demonstrate, on a real pinned profile:

1. One Mission materializes **Task A and Task B**, with B declaring A in
   `dependencies`, from a two-node `PipeSnapshot`.
2. B is **`blocked`** and `startAttempt(B)` is **refused** while A is
   unsatisfied — refused by the Host engine, not merely hidden in the Cockpit.
3. A executes in its own Session and isolated worktree, reaches passing trusted
   Evidence, is approved, and is promoted to
   `refs/forgeyard/promotions/<attemptA>`.
4. B becomes **`ready`** only after A's Promotion reaches `status = 'promoted'`.
5. B's `executionSnapshot.baseCommit` **equals A's `outputCommit` exactly**, and
   B's worktree HEAD resolves to it.
6. B executes in a **distinct** Session and worktree; `git rev-list` shows
   `base → A.outputCommit → B.outputCommit` as a single chain.
7. The Cockpit renders both nodes, the dependency edge, per-node readiness with
   its blocking reason, Attempt state, and the propagated output commit.
8. Every Evidence, Verification, Decision, and Promotion record for both nodes
   remains inspectable and append-only.
9. The operator's branch, index, HEAD, and checkout are unchanged throughout,
   and no push, PR, merge, or CI is triggered.

## Explicitly out of scope

Serial only. **No** parallel scheduling, no worker or fleet abstraction, no
remote transport, no GitHub delivery, no generalized orchestration DAG engine,
no retry-cascade policy, and no remediation semantics. If a node needs to fan
out, that is a later milestone with its own acceptance.

## Risk

The main risk is **scope drift into a scheduler**. Readiness must stay a pure
function computed from existing records at snapshot time. The moment readiness
becomes stored, mutable state, Forgeyard acquires distributed-state machinery it
has no single-machine need for — the exact failure mode the strategic
assessment names. Two nodes, one edge, computed readiness.
