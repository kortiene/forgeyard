# Milestone 2 acceptance runbook

Milestone 2 adds one capability:

> Starting from a successfully verified Attempt with a terminal, digest-bound
> `APPROVE` Decision, an operator can explicitly promote the exact approved
> deliverable into a durable Forgeyard-owned local Git commit and ref, without
> modifying the original repository checkout.

Approval and promotion stay separate. `APPROVE` authorizes a reviewed state;
`promote` is a second, explicitly confirmed action that produces the durable
output. Read [ADR-0004](adr/0004-local-promotion-boundary.md) for the boundary
itself and [SECURITY.md](../SECURITY.md) for its trust limits.

## The promotion projection

A Git tree cannot hold everything the reviewed workspace holds. Forgeyard
declares the difference instead of hiding it. Every entry of the reviewed
raw-workspace manifest receives exactly one outcome:

| Outcome | What it means |
| --- | --- |
| `promoted` | a non-ignored regular file or symlink, carried as a Git blob with its Git mode |
| `git-admin` | the linked-worktree `.git` entry and anything below it |
| `ignored` | a Git-ignored file or symlink, including verifier-created state |
| `directory-implied` | a directory Git recreates from a promoted path |
| `directory-dropped` | a directory with no promoted descendant, including an empty one |

`promoted.count + excluded.count` always equals the reviewed manifest entry
count. A path Git reports as neither tracked, untracked, nor ignored — or an
entry Git reports that the reviewed workspace does not hold as a file or symlink
— fails the promotion closed.

These reviewed facts are **never carried**, and the record says so explicitly:

- Git-ignored files and directories;
- directories with no promoted descendant, including empty directories;
- the linked-worktree `.git` administrative entry;
- file permission bits other than the single Git executable bit;
- symbolic-link permission bits;
- owner and group identity;
- access, modification, and change timestamps;
- device, inode, and hard-link identity.

Promoted files whose reviewed permission bits are not the canonical `0644` or
`0755` that Git's modes denote are listed individually in
`unrepresentableModes`, with a complete hash and a bounded preview.

A tracked file the deliverable **deleted** is part of the deliverable precisely
by being absent from the promoted tree.

## What promotion produces

- one commit whose tree is exactly the projection and whose single parent is the
  Attempt's frozen base commit, so `git diff <base>..<ref>` is the deliverable;
- author and committer `Forgeyard <forgeyard@promotion.invalid>` dated at the
  approval instant, which makes the commit name a deterministic function of the
  approved state;
- a commit message carrying `Forgeyard-Attempt`, `-Task`, `-Mission`,
  `-Base-Commit`, `-Worktree-Head`, `-Execution-Snapshot`, `-Decision`,
  `-Review-Digest`, `-Evidence-Digest`, `-Verification-Digest`,
  `-Projection-Hash`, and the promoted/excluded counts;
- the ref `refs/forgeyard/promotions/<attemptId>`, created with Git's own
  compare-and-swap requiring the ref to be absent.

Forgeyard writes no other ref name and never pushes. The operator checkout keeps
its branch, HEAD, index, and working tree; the shared object database and the
`refs/forgeyard/` namespace are the only things that gain content.

Inspect the output with ordinary Git:

```sh
git -C <repository> log -1 --format=%B refs/forgeyard/promotions/<attemptId>
git -C <repository> ls-tree -r refs/forgeyard/promotions/<attemptId>
git -C <repository> diff <baseCommit>..refs/forgeyard/promotions/<attemptId>
```

## Eligibility

`promote` succeeds only when all of the following hold at the moment of the
request:

1. the Attempt state is `approved` and it carries a terminal `APPROVE` Decision;
2. the stored Evidence, Verification, execution snapshot, and Git Evidence pass
   the same integrity checks approval required;
3. the original base checkout still matches its frozen HEAD and status;
4. the live Attempt worktree fingerprint still equals the approved Evidence
   fingerprint, and the live raw-workspace hash equals the reviewed
   `workspaceHash`;
5. the recomputed live review digest equals the Decision's review digest;
6. the operator's `expectedReviewDigest` equals that same digest;
7. no unfailed Promotion already exists for this Attempt.

`FAIL`, `ERROR`, `INCOMPLETE`, missing Verification, `REJECT`, `RETRY`,
`CANCEL`, `needs_review`, a changed worktree, a changed base checkout, and an
outdated digest all fail closed with `PROMOTION_BLOCKED` (or `GIT_ERROR` when
Git itself refuses).

## Failure and restart semantics

| Situation | Result |
| --- | --- |
| the ref already exists | `GIT_ERROR`; a `failed` Promotion is recorded and the existing ref is untouched |
| Git commits the ref but the call fails (a timeout, a lost subprocess result) | the ref is read back, names this promotion's commit, and the Promotion settles `promoted`; the durable output stands and is never filed as a failure |
| the ref write fails and the ref cannot be read either | nothing is guessed: the Promotion stays `pending` and `uncertain`, and its lease hands the outcome to reconciliation |
| two Hosts reconcile the same expired Promotion at once | it settles exactly once; the loser reports the authoritative outcome instead of failing its reconciliation or its `promote` request |
| two Hosts open a shared database needing migration 003 | the migration runner re-reads what is applied inside its write transaction, so the loser skips it instead of failing startup |
| a concurrent promotion of the same Attempt | one succeeds; the other is `PROMOTION_BLOCKED` by the SQLite partial unique index before Git is touched |
| a repeated promotion of a completed one | `PROMOTION_BLOCKED` with a stable message naming the existing ref and commit |
| interrupted before the ref existed | once its lease expires the Promotion reconciles to `failed` ("no durable output exists") and the Attempt may be promoted again |
| another Host is mid-promotion, between its recorded intent and its ref | the Promotion holds a live lease; reconciliation leaves it `pending`, the Cockpit reports `uncertain`, and no second promotion starts |
| interrupted after the ref existed | the Promotion reconciles to `promoted` |
| the ref holds a different object at restart | the Promotion reconciles to `failed`, naming both object names; Forgeyard never overwrites it |
| the repository is unreadable at restart | the Promotion stays `pending` and the Cockpit reports it as `uncertain`; nothing is promoted until it reconciles |

A `failed` Promotion is retained for audit and releases the Attempt, so an
explicit retry is possible once the operator has resolved the cause. Because the
commit is deterministic, the retry names the same commit the failed attempt had
already computed.

## Cockpit flow

1. Open an approved Attempt's review. The **Promotion** panel shows the status
   pill, the approved digest, the planned ref, the output commit (or
   `Not promoted`), and any previous failure reason.
2. Press **Promote approved deliverable…**. The panel expands into an explicit
   confirmation showing the exact digest and ref.
3. Supply an actor and a rationale, then press **Confirm promotion**. The request
   carries the displayed digest; a digest that moved fails closed.
4. The panel then shows the promoted record: the ref, the commit, the promoted
   count, the ignored count, the dropped-directory count, the unrepresentable
   mode count, the projection hash, and whether a ledger preview was bounded.
5. If the Host refuses the promotion, the panel reports the error *and* reloads
   authoritative state. A refusal is a durable Host outcome — a recorded failure,
   an existing ref, a Promotion left uncertain — so the panel must never keep
   rendering the eligible state it showed before the request and invite the
   operator to press promote again against a Host that has already refused.

## Running the gate

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check          # build + unit/contract/real-Git/vertical-slice tests + profile smoke
pnpm smoke:browser  # assembled-browser round trip
pnpm smoke:native   # provider-driven Attempt, approval, and promotion
```

`pnpm check`'s profile smoke boots the real pinned DSH Web profile and, on a host
with a usable sandbox backend, drives Mission → Attempt → Retry → Attempt 2 →
`PASS` → `APPROVE` → **promote**, then stops the Host and verifies from the
operator's own checkout that the ref resolves to the recorded commit, the commit
carries the recorded tree, its only parent is the Attempt base commit, no
operator branch moved, and the checkout is unchanged and clean. On a host with no
usable sandbox backend it instead proves that approval and promotion both stay
blocked.

`pnpm smoke:native` additionally proves the promoted commit holds the exact
model-authored `answer.txt` bytes and an untouched `verify.mjs`, read straight
out of Git, and that repeating the promotion is refused.

The Milestone 1 environmental requirements still apply in full: see
[the Milestone 1 runbook](milestone-1-acceptance.md) for the case-sensitive
filesystem, sandbox backend, browser, and provider prerequisites, and for how to
read a `MISSING CAPABILITY` result.

## Interpreting a fail-closed promotion result

| Message | Meaning | Action |
| --- | --- | --- |
| `Only an Attempt with a terminal APPROVE Decision can be promoted; this Attempt is …` | the Attempt is not approved | approve it first, or accept that it is not deliverable |
| `The confirmed review digest does not match …` | the operator confirmed a digest the Attempt was not approved for | reopen the Attempt and confirm the digest the panel shows |
| `The worktree or recorded fingerprint changed after Evidence collection …` | the reviewed workspace was edited after approval | the approved state no longer exists; retry the Task |
| `The original base checkout changed: …` | the operator repository moved after the Attempt snapshot | restore the checkout, or retry the Task from the new base |
| `the reviewed workspace holds …, which Git reports as neither tracked, untracked, nor ignored` | Git's view and the reviewed bytes disagree | inspect the worktree; Forgeyard will not guess whether the path is deliverable |
| `The Forgeyard promotion ref was not created: … reference already exists` | a ref already occupies the name | inspect it; delete it only after confirming what it is, then promote again |
| `This Attempt was already promoted to … at …` | the durable output already exists | use the existing ref |
| `A previous promotion did not settle …` | a promotion is uncertain | make the repository readable and let Forgeyard reconcile it |
| `A promotion of this Attempt holds a live lease …` | another Host may be promoting this Attempt right now, or one was interrupted moments ago | wait for the lease to lapse, then promote again; Forgeyard reconciles the Promotion against its Git ref first |

None of these are treated as success, and none of them modify the operator
checkout.
