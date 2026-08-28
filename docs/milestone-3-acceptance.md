# Milestone 3 acceptance runbook

Milestone 3 adds one capability:

> One Mission can carry **two explicitly serial Tasks** — a root node `A` and a
> follow-up node `B` declaring `dependsOn: ['A']` — where `B` becomes startable
> only after `A` reaches an approved, promoted, **re-verified** output, and `B`
> is then admitted with `A`'s exact promoted commit frozen as its base.

Read [the Milestone 3 proposal](milestone-3-proposal.md) for the decisions
behind the serial contract, [ADR-0004](adr/0004-local-promotion-boundary.md)
for the promotion boundary `B` depends on, and
[the Milestone 2 runbook](milestone-2-acceptance.md) for the promotion
machinery itself. The Milestone 1 environmental prerequisites (case-sensitive
filesystem, sandbox backend, browser, provider credential) still apply in full:
see [the Milestone 1 runbook](milestone-1-acceptance.md).

## The serial contract in brief

A Mission is created with an explicit node array, not a singular Task:

```ts
nodes: [
  { key: 'A', task: '…', verificationCommand: 'node verify.mjs', dependsOn: [] },
  { key: 'B', task: '…', verificationCommand: 'node verify.mjs', dependsOn: ['A'] },
]
```

Exactly one or two nodes. The root carries `dependsOn: []`; a second node must
carry exactly `[root.key]`. Keys are unique after trimming. Every arity, text,
key, edge, and verification-command check runs **before** any Git or
provider-policy work, so a malformed Pipe never touches the operator
repository. `store.insertMissionAndTasks` then materializes the Mission and
every Task in one `BEGIN IMMEDIATE`, asserting the Pipe hash, one-to-one
node/Task mapping, specification correspondence, and dependency-ID
correspondence. No SQL migration exists for Milestone 3: the authority already
lived in `missions.pipe_json`, `tasks.source_node_key`, and
`tasks.dependencies_json`.

Three invariants are load-bearing; breaking any of them silently corrupts the
view rather than failing a gate:

1. **`TaskNodeView.attempts` is oldest-first by wire contract.** Display code
   sorts newest-first for rendering — never hand a display-sorted array to
   `.at(-1)`-style "latest Attempt" logic, or you will select the *oldest*
   Attempt and suppress warnings on every node that reached approval through a
   retry.
2. **The `tasks` table is immutable by trigger.** Tests corrupt fixtures by
   inserting rows, never by `UPDATE`.
3. **Node order comes from the frozen Pipe** (`missions.pipe_json`), never from
   storage order, insertion time, or Task ID.

## How a dependency is decided

`ForgeyardEngine.upstreamOutput` is the **single source of truth** for a
dependency edge. The readiness projection renders its `reason` verbatim in the
Cockpit, and Attempt admission refuses with the **same text** — on any edge
that resolves, the panel and the engine cannot disagree. One delimited
exception exists for corrupted rows (which creation never writes; only a
fixture inserted against the immutability triggers can produce one): a
dependency ID that does not resolve at all makes the panel fail soft with
`This node's recorded dependencies do not resolve within its Mission: …` plus
a trailing `The dependency records are inconsistent and must be inspected.`,
while the engine refusal names only the unresolvable ID — and the sibling
*not-an-earlier-node* corruption case does share one text on both sides.
`upstreamOutput` reads the upstream node's `AttemptView[]`
whose `promotion` field came from `promotionEligibility`, so a dependency is
satisfied only by output that function **would still advertise right now**:
re-verified against the live `refs/forgeyard/promotions/<attemptId>` ref, not
merely recorded as `promoted` in SQLite.

| Upstream condition | B readiness | Reason (verbatim prefix) |
| --- | --- | --- |
| no Attempt yet, or no terminal approved Attempt | `blocked` | `Node A has not run yet; it must reach an approved, promoted Attempt first.` / `…its latest Attempt is <state>.` |
| latest Attempt `cancelled` | `blocked` | `Node A has not reached a terminal approved Attempt; its latest Attempt is cancelled.` — cancellation is **terminal** for the Task (no Retry, no second initial Attempt), so the remedy is a new Mission; it is reported `blocked` rather than `dead` by design (proposal Q3) |
| latest Attempt `approved`, not promoted | `blocked` | `Node A is approved but its output has not been promoted yet; promote it first.` |
| `approved` but promotion currently blocked (e.g. drifted review) | `blocked` | `Node A is approved but cannot be promoted: <the actual promotionEligibility reason>` — never the generic advice, because naming an action that would fail is worse than saying nothing |
| promotion recorded but ref not re-verifiable **right now** (e.g. repository unreadable) | `blocked` | `Node A's promoted output could not be re-verified, so it cannot be frozen as a base yet. <reason>` — the shared `PROMOTION_UNCONFIRMED_REASON_PREFIX` constant is what links the panel and this refusal |
| promotion `pending`/`uncertain`, or `diverged` (ref deleted, moved, or symbolic) | `blocked` | the promotion record's own divergence/uncertainty reason, surfacing the exact ref and disagreement |
| latest upstream Attempt `rejected` | **`dead`** | `Node A was rejected, which is terminal for that Task; create a new Mission for another line of work.` — rejection is terminal per Milestone 1, so Forgeyard must never offer a `RETRY` the engine refuses |
| promoted **and** ref re-verified | `ready` | `reason: null`, `baseCommit` = A's `outputCommit`, `baseFromAttemptId` = A's Attempt |

Admission (`startAttempt`) re-runs this resolution on **both** the initial and
the Retry path, so a diverged upstream blocks a retry successor exactly as it
blocks a first Attempt, and B's already-admitted Attempt stays immutable on its
frozen base regardless of what the upstream ref does later.

## What each gate proves for Milestone 3

The eleven criteria in
[the proposal](milestone-3-proposal.md#acceptance-criteria) map to concrete,
executed evidence as follows. **No criterion is credited to prose**; where a
criterion lacks executed coverage, the gap is stated rather than papered over.

| # | Criterion | Where it is asserted |
| --- | --- | --- |
| 1 | two-node materialization; B's `dependencies` holds A's `TaskId` | `smoke:profile` (real pinned profile, generated Remote) creates the serial Mission and asserts the frozen Pipe, node/Task correspondence, and `dependencies`; `tests/vertical-slice/store-authority.test.ts` asserts every atomicity and correspondence failure mode of `insertMissionAndTasks`; `one-verified-attempt` asserts Pipe-order node views |
| 2 | B `blocked` and `startAttempt(B)` refused by the Host engine | `smoke:profile` asserts the Remote refusal (`INVALID_STATE`, same text as the panel); `one-promoted-change` "admits a serial follow-up only on the re-verified…" asserts `startAttempt` rejects `/Node A has not run yet/`; `one-verified-attempt` refuses admission on initial **and** retry paths |
| 3 | A executes in its own Session/worktree, passes, is approved and promoted | **in a serial Mission, only the vertical slice executes A** (`one-promoted-change`: start → verify → `APPROVE` → promote of the serial A, deterministic harness-authored worktree content). `smoke:profile` proves the *machinery* on the real pinned profile but its executed-and-promoted Attempt belongs to the **single-node** Mission; the serial Mission in that run is only materialized and refusal-checked. `smoke:native` would drive the real-model version but is currently quota-blocked (below) and is single-node regardless |
| 4 | B `ready` only after promotion **and** ref re-verification; deleting/moving the ref re-blocks B | `one-promoted-change` deletes the ref (`git update-ref -d`) and asserts B returns to `blocked` with the divergence surfaced verbatim; a sibling test makes the repository unreadable and asserts the *unconfirmed* (not diverged) re-block and recovery |
| 5 | B's `executionSnapshot.baseCommit` equals A's `outputCommit`; worktree HEAD resolves to it | `one-promoted-change` asserts both fields plus `git rev-parse HEAD` inside B's worktree |
| 6 | distinct Session/worktree; `A.outputCommit` is an ancestor of B's HEAD; A's commit a single child of the Mission base | `one-promoted-change` asserts distinct Session/worktree and `merge-base --is-ancestor` in both directions; single-parent exactness is the Milestone 2 promotion invariant, asserted there (vertical slice and `smoke:profile`'s `rev-list --parents` check) and inherited unchanged by A's promotion |
| 7 | Cockpit renders nodes, edge, readiness, reason, propagated base; rollup asserted per stage incl. the mixed state | the **values** are asserted without the graph: `mission-view-contract.test.ts` pins the whole precedence table including "promoted A plus startable B is `ready`, not `complete`", and the vertical slice asserts `derivedState` and each readiness at every serial stage. The **graphical** tests do not render a serial fixture: `client-bundle-render.test.tsx` asserts the two-node *creation payload* but renders single-node snapshots, and `smoke:browser` waits for the single reshaped node card. See honest gap 3 |
| 8 | all Evidence/Verification/Decision records for both nodes, and A's Promotion, remain inspectable and append-only | append-only is proven **generically** by the store-authority immutability triggers; the serial tests assert both nodes' views, readiness, and A's/B's Promotion records, but do **not** separately walk both nodes' Evidence/Verification/Decision arrays through the plural Mission view |
| 9 | rejected upstream ⇒ terminal `dead` with an accurate remedy; no impossible `RETRY` offered | **partially covered, honestly:** the rollup's `dead` mapping is pinned by `mission-view-contract` fixtures, and `upstreamOutput` implements the reason — but **no automated test drives a rejected upstream to B's `dead` readiness end-to-end**, and no funded profile run has exercised it either. Until one does, treat this criterion as designed-and-reviewable, not executed. See "Honest gaps" below |
| 10 | operator branch/index/HEAD/checkout unchanged; no push/PR/merge/CI | `smoke:profile` verifies `for-each-ref`, clean `status --porcelain=v2`, and branch/HEAD from the operator's own checkout after the Host exits; the vertical slice repeats this per scenario |
| 11 | approved-but-unpromoted terminal B shows an explicit warning; promoting B stays available and succeeds | `client-bundle-render` asserts the warning appears (including after a retry-approved node), and disappears once promoted or blocked; `one-promoted-change` promotes B and asserts `merge-base --is-ancestor A.outputCommit B.outputCommit` |

## Inspecting the serial chain with ordinary Git

The chain has three commits: the Mission base `main` checkout, A's promoted
output, and B's worktree HEAD (B is terminal and unpromoted in the fixture, so
**B has no `outputCommit`** — the chain is asserted through B's worktree, not a
B Promotion record).

Collect the identifiers from supported surfaces only: the Cockpit's Promotion
panel (ref and commit), the node cards' readiness line (propagated
`baseCommit`), or the public `snapshot`/`missionView` Typert Remotes. Then,
from the operator's own checkout:

```sh
# A's durable output, exactly as recorded
git -C <repository> rev-parse --verify refs/forgeyard/promotions/<attemptA>^{commit}

# A's commit is a single child of the Mission base
git -C <repository> rev-list --parents -n 1 <A.outputCommit>

# B was admitted on exactly that commit
git -C <B worktree> rev-parse HEAD          # == <A.outputCommit>

# The chain is real: base -> A.outputCommit is an ancestry edge, not a claim
git -C <repository> merge-base --is-ancestor <missionBase> <A.outputCommit>

# The deliverables, read straight out of Git
git -C <repository> diff <missionBase>..<A.outputCommit>
git -C <B worktree> diff <A.outputCommit>   # B's tracked changes only
git -C <B worktree> status --short --untracked-files=all   # B's new files

# A's promoted tree already enumerates its additions; B's worktree does not:
# `git diff <commit>` compares tracked paths and never lists untracked files,
# so if B's deliverable is pure additions the diff alone shows nothing.
git -C <repository> ls-tree -r --name-only <A.outputCommit>
```

Promoting B afterwards (criterion 11's second half) extends the same chain with
ordinary Git facts — no Forgeyard machinery is involved in reading it:

```sh
git -C <repository> merge-base --is-ancestor <A.outputCommit> <B.outputCommit> \
  && echo "B descends from A"
git -C <repository> ls-tree -r --name-only <B.outputCommit>   # B's additions, enumerated
```

Every command above is a read-only query against the shared object database —
none can move anything. The precise write boundary Forgeyard itself holds: it
writes **no ref name outside `refs/forgeyard/promotions/`** and never moves an
operator branch, HEAD, index, or checkout, but admission and promotion do add
ordinary Git content — new objects in the shared object database, linked
worktree administration under `.git/worktrees/`, and the promotion ref itself.

## Re-blocking on divergence

To reproduce the re-block yourself, take a serial Mission with A promoted and B
ready or admitted, then break the authoritative output outside Forgeyard:

```sh
git -C <repository> update-ref -d refs/forgeyard/promotions/<attemptA>   # deleted
# or: git -C <repository> update-ref refs/forgeyard/promotions/<attemptA> <otherCommit>
# or plant a symbolic ref on the name
```

Then reload the Mission view. Expected behavior, each asserted by the
vertical-slice suite:

- B's readiness returns to `blocked` with `blockedBy: ['A']`, `baseCommit:
  null`, and a reason naming **the exact ref** and the disagreement — readiness
  re-reads the ref; it never trusts the SQLite `promoted` row.
- B's **already-admitted** Attempt is untouched: still frozen on
  `A.outputCommit`, still immutable. Divergence blocks *future* admission
  (including a Retry successor, which re-resolves its base), never rewrites
  history.
- A's own Promotion panel reports `diverged`, naming the recorded commit and
  what the ref holds now. Forgeyard never recreates or overwrites the ref.

Two distinct honest outcomes exist, and the runbook distinguishes them because
they call for different operator action:

| Outcome | Meaning | Action |
| --- | --- | --- |
| `diverged` | the ref was read and disagrees with the record (deleted, moved, or symbolic) | inspect the repository; the record and the ref are two independent facts and Forgeyard resolves neither for you |
| unconfirmed (`could not be re-verified`) | the ref could not be read *right now* (e.g. an unreadable repository); the record stands | make the repository readable; B becomes startable again with no operator action |

## The terminal-node undelivered-output warning

An approved **terminal** node's output still carries deliverable work, and
promotion is the only way to deliver it: approval cannot be retried into a
fresh Attempt, and a drifted reviewed state makes that exact output
**permanently unpromotable**. The Cockpit therefore warns, with `role="status"`
inside the node card:

> **Approved output not yet promoted.** This approved work is undelivered.
> Promoting it remains available; if its reviewed state drifts first, this
> exact output becomes permanently unpromotable and cannot be recovered by a
> retry.

The warning appears only while it is actionable — the node's **latest** Attempt
(in wire order, oldest-first) is `approved`, it holds **zero Promotion records
of any kind**, and `promotionEligibility` still reports `eligible` — and it
disappears once the node is promoted or the reason line already says something
truer (blocked, lost). Two consequences an operator should know:

- After a promotion attempt that **failed before creating the ref**, the
  retained `failed` Promotion record suppresses the node-card warning even
  though the output is still undelivered and — per the Milestone 2 semantics —
  the Attempt is released and an explicit promotion retry remains possible.
  The Attempt review's Promotion panel still shows the failure and the
  eligibility; only the node card goes quiet. This is a known cosmetic blind
  spot, not a delivery guarantee.
- The warning keys on the wire contract's oldest-first `attempts` order. Feed
  it a display-sorted copy and it will silently select the *oldest* Attempt
  and vanish on every node that reached approval through a retry — the
  retry-chain survival case is what the render suite pins.

Promoting a terminal node is never *required*; it stays
*available* and succeeds when chosen, proving the rule governs what Forgeyard
requires, not what it permits.

## Running the gate

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --dir profiles/local install --ignore-workspace --no-lockfile   # profile bundle link
pnpm check          # check:scripts + dual-face build + 164 tests + profile smoke
pnpm smoke:browser  # assembled-browser round trip (Chromium opt-in may be needed, below)
pnpm smoke:native   # provider-driven Attempt, approval, and promotion
```

`pnpm check`'s profile smoke proves, for Milestone 3 specifically, on the real
pinned DSH Web profile through the generated Remotes: the two-node Mission
materializes atomically with the frozen `A,B` Pipe and
`dependsOn: ['A']`; B is `blocked` with `startable: false`, `blockedBy:
['A']`, and the shared-text reason; `startAttempt(B)` is **refused by the
Host** with that same text; nothing changes in storage after the refusal; and
the Mission rolls up `ready` from the mixed state. The single-node Mission in
the same run proves the admission → verification → decision → promotion
machinery B's dependency resolves against. The full A-executes → B-executes
serial chain is additionally driven by the vertical-slice suite inside
`pnpm check`, and the reshaped node card (`article[aria-label="Task node
<key>"]`) is driven in real Chromium by `pnpm smoke:browser`.

The result is environment-specific. Do not infer a pass from the presence of a
test; re-read [docs/ci.md](ci.md) for exactly what the credential-free
`safety-gate` workflow does and does not prove.

## Assurance boundary: parsing, loading, executing

A green `safety-gate` run establishes that `check:scripts` **parsed** every
`scripts/**/*.mjs` harness with `node --check`, the package built, the 164-test
suite passed, and the profile smoke executed. Parsing a harness is not loading
or executing it: a green `check:scripts` proves `smoke:browser` and
`smoke:native` are syntactically valid for the supported Node runtime; it does
**not** resolve their imports or claim their provider-, browser-, or
sandbox-driven acceptance behavior ran. They remain the manual operator gates.

The same discipline applies to checks themselves: **absence of a red check is
not evidence of a green one.** On PR #11 the `pull_request` trigger did not
fire at all — no run, no checks — while GitHub reported all systems
operational, and only `workflow_dispatch` produced a run. Always verify a
`success` run exists on the *exact head commit* before claiming CI status for
it.

## Host-capability notes (observed 2026-08-28)

These are the observed states of the operator gates on the acceptance host,
re-verified on the date above:

- **`pnpm check` PASSED** — 13 files / 164 tests, dual-face build, and the
  profile smoke's sandbox-available branch (confined verifier `PASS`, approval,
  one explicit promotion re-verified from the operator's checkout, plus the
  serial materialization slice).
- **`pnpm smoke:browser` PASSED (10 checks, real Chromium)** — but only with
  `FORGEYARD_CHROMIUM_NO_SANDBOX=1`. This host sets
  `kernel.apparmor_restrict_unprivileged_userns=1` (AppArmor), and `sysctl`
  needs root. Without the flag the harness **fails closed** with
  `MISSING CAPABILITY: this host cannot start Chromium's own sandbox`. The
  flag affects only the *test browser's* sandbox — never a product sandbox,
  which still requires `enforcement: 'full'` — and the harness never sets it
  on its own. Evidence screenshots are left under `/tmp/forgeyard-browser-evidence-*`.
- **`pnpm smoke:native` fails closed on provider quota** —
  `MISSING CAPABILITY: the native model turn errored (turn/end code=QUOTA):
  Insufficient Balance`. Session binding, worktree isolation, Mission/Task
  creation, and the model-turn plumbing all worked; the configured
  `deepseek-official` route has no credit. This is an account limitation, not
  a product defect, and must **not** be routed around: fund the account
  (`DEEPSEEK_API_KEY`) or point `FORGEYARD_ACCEPT_PROVIDER` /
  `FORGEYARD_ACCEPT_MODEL` at a funded file-based route, then re-run.
- **No case-sensitive volume provisioning is needed on this host** — the
  filesystem is already case-sensitive. The macOS instructions in
  [the Milestone 1 runbook](milestone-1-acceptance.md) apply only where it is
  not.

## Honest gaps at acceptance time

1. **No funded provider route has exercised a real model turn under Milestone
   3.** `smoke:native` remains single-node (Milestones 1–2) and is
   quota-blocked besides; the serial chain's execution exists only in the
   deterministic vertical slice, whose worktree content is harness-authored.
   `smoke:profile` executes and promotes an Attempt on the real pinned
   profile, but of the **single-node** Mission — the serial Mission in that
   run is materialized and refusal-checked only. The quota block is the only
   obstacle to the real-model run.
2. **Criterion 9's engine path has no end-to-end test** (see the criteria
   map): rejected upstream ⇒ `dead` readiness is implemented and its rollup is
   pinned by fixtures, but no test drives a real `REJECT` on an upstream node
   and asserts B's resulting readiness. Closing this is a bounded follow-up
   and should precede any Milestone 4 proposal that builds on rejection
   semantics.
3. **No graphical test renders a serial fixture.** The render suites mount
   single-node snapshots; the two-node browser tests assert the *creation
   payload*, and `smoke:browser` waits for the single reshaped node card. A
   regression that dropped the second node card, the dependency edge, the
   blocking reason, or the propagated base from the Cockpit would pass every
   cited graphical check. The engine-level readiness and rollup values are
   pinned; their rendering is not. A two-node render fixture is a bounded
   follow-up.

## Interpreting a blocked readiness

| Reason (prefix) | Meaning | Action |
| --- | --- | --- |
| `Node A has not run yet…` | the upstream has no Attempt yet, or its latest is not terminal (running, awaiting a Decision) | run A to a terminal Decision first |
| `…its latest Attempt is cancelled.` | the upstream's only Attempt was cancelled — **terminal**, like rejection, but reported `blocked` by design | create a new Mission; no Retry or second initial Attempt exists for a cancelled Task |
| `Node A is approved but its output has not been promoted yet; promote it first.` | approval exists, delivery does not | promote A from its Attempt review, confirming the exact digest |
| `Node A is approved but cannot be promoted: …` | A's promotion is currently blocked (e.g. drifted review) | fix the named cause — the reason is A's actual `promotionEligibility` reason, not generic advice |
| `Node A's promoted output could not be re-verified…` | the ref could not be read right now (unconfirmed) | restore repository readability; no other action needed |
| `… but that ref no longer exists` / `… now resolves to …` | the promoted ref was deleted, moved, or made symbolic (diverged) | inspect the repository; Forgeyard will not recreate the ref |
| `Node A was rejected, which is terminal for that Task…` | the upstream line of work is closed (`dead`) | create a new Mission; no Retry exists for a rejected Task |

None of these are failures of the Mission view, and none of them modify the
operator checkout.
