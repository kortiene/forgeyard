# Milestone 3 proposal — One Useful Pipe

- Status: **Proposed, not implemented.** This document exists to resolve design
  questions *before* code, per the Milestone 3 mandate.
- DSH release: `0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`) — unchanged.
- Revision 3. Five P1 findings from automated review were verified against the
  implementation and **all five were correct**; see [Corrections](#corrections-in-revision-2).
- **The open question is now closed by operator decision** (see Q1): only nodes
  with a downstream dependent must promote, and the unpromoted-output expiry
  risk is surfaced as a Cockpit warning rather than enforced.

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

### 1. Does every Pipe node require approval and promotion?

**Only nodes whose output feeds another node.** Promotion is a *delivery*
boundary, and ADR-0004 is explicit that `APPROVE` authorizes while `promote`
delivers. Forcing promotion on a terminal node would create durable refs nobody
consumes.

The rule: a node with at least one downstream dependent **must** reach an
approved *and* promoted output before any dependent becomes ready, because the
promoted commit is what the dependent freezes. A terminal node needs only an
explicit Decision. In the Milestone 3 fixture, Task A is upstream (must promote)
and Task B is terminal (need not).

**Consequence for acceptance, which revision 1 got wrong:** `outputCommit`
exists *only* on a `PromotionRecord` (`types.ts:362`). If B is not promoted, B
has no `outputCommit` and no Promotion record, so no acceptance criterion may
refer to either for B. Criteria 6 and 8 are corrected accordingly.

#### Required vs. possible

This rule governs what Forgeyard **requires**, not what it permits. Promotion is
already *possible* for every approved Attempt: `promotionEligibility`
(`engine.ts:1129-1242`) is purely per-Attempt — it reads that Attempt's
promotions, its `APPROVE` Decision, and the live review digest, and has **no**
notion of a graph. The profile smoke already promotes a single-node (therefore
terminal) Mission end to end. An operator may promote a terminal node whenever
they want a durable artifact; Milestone 3 simply does not force it.

Mandating promotion for every node was considered and **rejected**, for three
reasons:

1. **It contradicts ADR-0004.** "`APPROVE` authorizes; `promote` delivers."
   Promotion demands an actor, a rationale, and digest confirmation. Making it
   mandatory means either auto-promoting — stripping operator intent from a
   deliberately fail-closed action — or holding the Mission "incomplete" until a
   human clicks, which is a nag, not a guarantee.
2. **It would push graph-awareness into a graph-free boundary.** Promotion
   eligibility knows nothing about dependencies today, and a uniform rule would
   inject Pipe topology into it to gain nothing an operator cannot already do.
3. **It mints refs nobody consumes**, permanently, under
   `refs/forgeyard/promotions/`.

#### The expiry risk this rule accepts, and how it is surfaced

Deferring promotion is not free, and this is the strongest argument against the
rule. Eligibility fails when
`review.reviewDigest !== decision.reviewDigest` (`engine.ts:1238`), so an
approved terminal node whose worktree later drifts becomes **permanently
unpromotable** — "approve now, promote later" is not a safe assumption. Combined
with rejection finality (Q3), a deliverable can be quietly lost.

Milestone 3 answers this with **honesty, not enforcement**: the Cockpit must
warn when an approved Attempt has no Promotion and its reviewed state is at risk
of going stale, so the operator can choose to promote before drift makes the
choice for them. Forgeyard does not auto-promote to avoid the warning, and does
not add machinery to re-derive a promotable state after drift. See criterion 11.

### 2. Is the existing Promotion ref the authoritative intermediate output?

**Yes — and readiness must re-verify it, not trust the SQLite row.**

`refs/forgeyard/promotions/<attemptId>` resolves to a deterministic commit whose
tree was proven entry-by-entry against the reviewed projection and whose parent
is the Attempt's frozen base. Milestone 3 must **not** invent a second output
concept: Task B's base is literally `promotions.output_commit`.

But a stored `status = 'promoted'` is **not self-certifying**. The engine already
says so in `promotionEligibility` (`engine.ts:1162-1215`): the row and the ref
are two independent facts, and anyone with repository write access can delete,
move, or symref a `refs/forgeyard/` name outside Forgeyard. That path
re-canonicalizes the repository, asserts the recorded repository snapshot,
rejects a symbolic ref, and compares the observed OID — reporting `diverged`
when they disagree.

**Readiness must reuse that same validation.** Marking B ready from a stored
`output_commit` alone would let B freeze a base Forgeyard itself would refuse to
advertise. A node whose upstream promotion is `diverged` or unconfirmed is
**blocked**, with the disagreement surfaced verbatim.

### 3. How should a failed upstream Task affect downstream readiness?

**Downstream stays `blocked`; never auto-started, never auto-cancelled.**
Readiness is a *computed projection*, never stored state.

| Upstream condition | Downstream readiness |
| --- | --- |
| no Attempt yet, or Attempt running | `blocked` (dependency unsatisfied) |
| Attempt `cancelled` / `retried` | `blocked` (no terminal approved output) |
| `approved` but not promoted | `blocked` (output does not exist yet) |
| Promotion `pending` / `uncertain` | `blocked` (not settled) |
| Promotion `failed` | `blocked` (explicit upstream promotion retry required) |
| promoted, but ref re-read `diverged` | `blocked` (**surface the disagreement**) |
| promoted **and** ref re-verified | `ready` (base commit resolved) |
| Attempt `rejected` | **`dead`** — see below |

#### Rejection is terminal for the Task, and revision 1 was wrong about it

Revision 1 said "the operator retries upstream". **That is impossible under the
current authority model**, which I verified:

- `RETRYABLE_STATES` is `{awaiting_decision, interrupted, needs_review}`
  (`engine.ts:164`) — `rejected` is excluded.
- `attempts_retry_insert_guard` (migration 002) enforces the same set in SQL.
- `startAttempt` refuses when any Attempt exists (`engine.ts:326`), and
  `UNIQUE(task_id, ordinal)` plus `attempts_initial_insert_guard` permit exactly
  one initial Attempt per Task, ever.

So a `REJECT` on a Task's only Attempt is a **permanent dead end for that Task**.
This is deliberate Milestone 1 design — rejection means "this line of work is
finished", and `RETRY` is the mechanism for "try again".

Milestone 3 therefore reports a rejected upstream as a distinct terminal
readiness state (`dead`, not `blocked`) whose remedy is explicit and honest:
**create a new Mission**. Forgeyard must not imply a retry the engine will
refuse. Loosening rejection into a retryable state would change accepted
Milestone 1 semantics and its migration-002 constraints — out of scope, and not
justified by a two-node Pipe.

### 4. May Task B remediate Task A?

**No — independent follow-up only. And this is a convention, not an invariant.**

Revision 1 stated the prohibition as though it were guaranteed. It is not.
The Host reviews B **only relative to its frozen base**, so a B that modifies or
deletes a path A introduced would still pass Verification, receive a Decision,
and produce a linear commit chain. Nothing in the existing machinery detects it.

Two honest options, and I recommend the second for Milestone 3:

- **(a) Enforce it.** Add a Host-side invariant rejecting B's promotion when its
  projection overlaps paths in A's projection. This is real, testable integrity
  machinery — and exactly the kind of narrow integrity work the strategic
  assessment says to stop adding before product value is proven.
- **(b) Downgrade it to an instruction-level convention.** Say plainly that
  Milestone 3 does not enforce non-overlap, that B's instruction asks for an
  independent follow-up, and that the acceptance fixture is *constructed* so B
  touches a different path. **Recommended.**

Option (b) keeps the milestone honest without spending it on a guarantee no
current product requirement demands. If overlap later proves harmful in
practice, (a) becomes a justified follow-up with its own acceptance.

### 5. What is the smallest schema evolution?

**No SQL migration — but one JSON shape change.**

`tasks` already has `source_node_key` and `dependencies_json`
(`001_initial.sql:19-26`), already parsed into `TaskRecord.dependencies`
(`store.ts:71`). `AttemptRecord.baseCommit` is already an arbitrary commit OID,
and `GitAuthority.createWorktree(repository, baseCommit, attemptId)`
(`git.ts:641`) already accepts any commit — so freezing B's base to A's promoted
commit changes only which OID `planAttempt` resolves. **No Git-authority change,
no SQL migration.**

However, revision 1 missed that the frozen Pipe cannot express the edge.
`PipeSnapshot` is `{ nodes }` and `PipeNodeSnapshot` is `{ key, task, verify }`
(`types.ts:67-75`) — nothing distinguishes A→B from B→A or two independent
nodes. Deriving `B.dependencies` from array order would be an undocumented
convention inside a hashed, immutable snapshot.

**Add an explicit `dependsOn: string[]` (node keys) to `PipeNodeSnapshot`.** It
lives inside `missions.pipe_json`, so it needs **no SQL migration**, but it does
change `pipeHash` for new Missions. Existing Missions are unaffected: their
stored JSON is read as-is, and absent `dependsOn` reads as `[]`, which is
exactly the single-node truth today.

## Acceptance criteria

A Milestone 3 acceptance run must demonstrate, on a real pinned profile:

1. One Mission materializes **Task A and Task B** from a two-node
   `PipeSnapshot` in which B's node declares `dependsOn: ['A-key']`, and B's
   `TaskRecord.dependencies` contains A's `TaskId`.
2. B is **`blocked`** and `startAttempt(B)` is **refused by the Host engine**
   (not merely hidden in the Cockpit) while A is unsatisfied.
3. A executes in its own Session and isolated worktree, reaches passing trusted
   Evidence, is approved, and is promoted to `refs/forgeyard/promotions/<attemptA>`.
4. B becomes **`ready`** only after A's Promotion is `promoted` **and its ref
   re-verifies** under the same checks `promotionEligibility` applies. A test
   must delete or move A's ref and confirm B returns to `blocked` with the
   divergence surfaced — readiness must not trust the SQLite row alone.
5. B's `executionSnapshot.baseCommit` **equals A's `outputCommit` exactly**, and
   B's worktree HEAD resolves to it.
6. B executes in a **distinct** Session and worktree, and
   `git rev-list --parents` shows **A's `outputCommit` as an ancestor of B's
   worktree HEAD**, with A's promoted commit a single child of the Mission base.
   *(B is terminal and unpromoted, so B has no `outputCommit`; the chain is
   asserted through B's worktree, not a B Promotion record.)*
7. The Cockpit renders both nodes, the dependency edge, per-node readiness with
   its blocking reason, Attempt state, and the propagated base commit.
8. Every Evidence, Verification, and Decision record for both nodes, **and the
   Promotion record for A**, remains inspectable and append-only.
9. A rejected upstream reports the terminal `dead` readiness state with an
   accurate remedy, and Forgeyard never offers a `RETRY` the engine refuses.
10. The operator's branch, index, HEAD, and checkout are unchanged throughout,
    and no push, PR, merge, or CI is triggered.
11. Terminal Task B is **approved but not promoted**, and the Cockpit shows an
    explicit warning that its approved output is undelivered and will become
    permanently unpromotable if its reviewed state drifts. Promoting B must
    remain **available** to the operator and must succeed when chosen, proving
    the rule governs what Forgeyard requires, not what it permits.

## Corrections in revision 2

All five automated P1 findings were verified against the implementation and all
five were correct. Recorded because they materially changed the design:

| Finding | Verified against | Correction |
| --- | --- | --- |
| Readiness must re-validate the promotion ref | `engine.ts:1162-1215` | Readiness reuses the `promotionEligibility` invariants; `diverged` blocks B (Q2, criterion 4) |
| Rejected upstream has **no** retry path | `engine.ts:164,326`, migration 002 | New terminal `dead` state; remedy is a new Mission, not a retry (Q3, criterion 9) |
| Terminal-node rule contradicted criteria 6/8 | `types.ts:362` | B has no `outputCommit`/Promotion; chain asserted via B's worktree (criteria 6, 8) |
| `PipeSnapshot` cannot express an edge | `types.ts:67-75` | Add `dependsOn: string[]`; JSON-only, no SQL migration (Q5) |
| Non-remediation was unenforceable as stated | Host reviews B only vs. its frozen base | Downgraded to an explicit convention, with the enforcement option named (Q4) |

## Explicitly out of scope

Serial only. **No** parallel scheduling, no worker or fleet abstraction, no
remote transport, no GitHub delivery, no generalized orchestration DAG engine,
no retry-cascade policy, no remediation enforcement, no mandatory promotion for
terminal nodes, no auto-promotion, no machinery to re-derive a promotable state
after review drift, and no change to Milestone 1 rejection semantics.

## Risk

The main risk is **scope drift into a scheduler**. Readiness must stay a pure
function computed from existing records — and now also from a live ref re-read —
at snapshot time. The moment readiness becomes stored, mutable state, Forgeyard
acquires distributed-state machinery it has no single-machine need for.

A second risk surfaced by finding 2: the Pipe inherits Milestone 1's
rejection finality. A two-node Pipe where the upstream is rejected is simply
over. That is honest and cheap now; if operators find it unusable in practice,
the answer is a deliberate milestone on Task-level re-attempt semantics, not an
ad-hoc loosening of migration-002 constraints.
