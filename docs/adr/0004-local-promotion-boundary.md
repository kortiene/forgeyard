# ADR-0004: The local promotion boundary

- Status: Accepted for Milestone 2
- Date: 2026-08-24
- DSH release: `0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`)

## Context

Milestone 1 ends at `APPROVE`. Approval authorizes one exact reviewed state
inside Forgeyard and produces no artifact an operator can carry anywhere. The
reviewed state lives only in a retained Attempt worktree, which is a directory
whose meaning depends on Forgeyard's SQLite records still existing.

Milestone 2 needs the smallest safe delivery boundary: a durable, inspectable
local Git output that provably corresponds to the approved review, without
pushing anything and without touching the operator's checkout.

Three facts from the Milestone 1 implementation shape the design.

1. **`decisions` admits exactly one row per Attempt** (`decisions_one_terminal_idx`),
   inserts are blocked once an Attempt is terminal (`decisions_terminal_sealed`),
   and `attempts` rows are frozen after a terminal Decision
   (`attempts_terminal_immutable`). Promotion state therefore cannot live on the
   Attempt, and a `PROMOTE` Decision type is structurally impossible without
   editing accepted Milestone 1 migrations.
2. **The reviewed workspace is strictly larger than any Git tree.** The trusted
   fingerprint covers a root-inclusive raw manifest: every directory, regular
   file, symlink target, byte hash, and review-relevant metadata, including
   ignored files and empty directories. A Git tree carries paths, blob bytes,
   symlink targets, and one permission bit.
3. **The terminal Decision already fenced the Attempt's DSH execution tree.** It
   cancelled the Agent, drained continuable descendants and owner-scoped Jobs,
   and installed a global `agent/pre-step` rejection for the Session.

## Decision

### Promotion is a separate explicit action

`APPROVE` authorizes; `promote` delivers. The Cockpit renders eligibility, and
the operator must open a confirmation panel and submit an actor, a rationale,
and the exact `expectedReviewDigest` the panel displayed. A digest that moved
between rendering and confirmation fails closed.

### Promotion is a first-class `Promotion` record

Migration 003 adds one forward-only `promotions` table. It is the minimum honest
representation, for the reasons above: Decisions cannot carry it, terminal
Attempts cannot be updated, and promotion has a real two-phase lifecycle
(`pending` → `promoted` | `failed`) that append-only Decision semantics cannot
express. The immutable authority columns are hashed; only `status`,
`failure_reason`, and `settled_at` may change, exactly once, under
`promotions_settle_once`. Partial unique indexes allow at most one unfailed
Promotion per Attempt and per Forgeyard ref, so a concurrent promotion loses in
SQLite before it can race Git.

### The promotion projection is declared, total, and proven

Forgeyard never equates a Git diff with the reviewed workspace. It computes an
explicit projection over the reviewed raw manifest in which every entry receives
exactly one outcome:

| Outcome | Meaning |
| --- | --- |
| `promoted` | a non-ignored regular file or symlink, carried as a Git blob |
| `git-admin` | the linked-worktree `.git` entry and anything below it |
| `ignored` | a Git-ignored file or symlink |
| `directory-implied` | a directory Git recreates from a promoted path |
| `directory-dropped` | a directory with no promoted descendant |

`promoted.count + excluded.count` must equal the reviewed manifest entry count.
Git's own view (`ls-files`, `--others`, `--others --ignored`) must explain every
manifest file and symlink; a path Git reports as neither tracked, untracked, nor
ignored — or an entry Git reports that the reviewed workspace does not hold —
fails the promotion closed rather than being silently dropped.

Every reviewed fact a Git tree cannot carry is enumerated in the record's
`notCarried` statement and its exclusion ledger: ignored content, dropped
directories, the `.git` pointer, permission bits other than the executable bit,
symlink modes, ownership, timestamps, and inode identity. Promoted entries whose
reviewed permission bits are not the canonical `0644`/`0755` Git denotes are
listed individually in `unrepresentableModes`.

Correspondence is proven, not assumed. Forgeyard reads each promoted entry once,
computing both the SHA-256 the trusted manifest recorded and the Git object name
for the same bytes, and refuses a read whose complete filesystem identity moved
or whose SHA-256 differs from the manifest. It then builds the tree in a scratch
index and accepts it only when Git independently produced the identical object
name and Git mode for every declared path, checked against both the index and a
re-read of the written tree.

### The output is a deterministic commit under a Forgeyard-owned ref

The commit is `commit-tree <projected tree> -p <Attempt base commit>` with a
pinned author/committer identity (`Forgeyard <forgeyard@promotion.invalid>`) and
the approval instant as its date, so the same approved deliverable always names
the same commit. Its message carries the Attempt, Task, Mission, base commit,
worktree head, execution snapshot, Decision, review digest, Evidence and
Verification digests, and the projection hash.

The ref is `refs/forgeyard/promotions/<attemptId>`, created with Git's own
compare-and-swap requiring the ref to be absent. Forgeyard refuses to write any
other ref name and never pushes. The operator's checkout keeps its branch, HEAD,
index, and working tree; the shared object database and the Forgeyard ref
namespace are the only things that gain content, which is the durable output by
design.

### Promotion does not re-enter the Attempt's DSH Session

The terminal Decision already cancelled and drained that execution tree, and the
global pre-step guard rejects its later model steps. Claiming maintenance again
would resume a sealed Session rather than fence anything. Promotion therefore
reads only Forgeyard's own SQLite authority, the filesystem, and Git. It
revalidates immediately before writing: stored review integrity, the original
base checkout snapshot, the live Git fingerprint against the approved Evidence
fingerprint, the live raw-workspace hash against the reviewed `workspaceHash`,
and the recomputed review digest against the Decision's digest. It re-checks the
fingerprint and the base checkout again after the objects are written and before
any ref exists.

### Crash and retry semantics are explicit

Objects are written before the `pending` row, because unreferenced Git objects
are inert and a retry recreates identical ones. The `pending` row is written
before the ref. On restart Forgeyard reconciles every pending Promotion against
its ref: equal to the recorded commit settles `promoted`; absent settles `failed`
("no durable output exists") and releases the Attempt for an explicit retry; a
different object settles `failed` naming both object names and refuses to
overwrite. A repeated promotion of a completed one is rejected with a stable
message naming the existing ref and commit.

## Alternatives rejected

- **A `PROMOTE` Decision type.** Requires editing accepted migrations, conflates
  authorization with delivery, and cannot express a two-phase lifecycle.
- **A separate Forgeyard-owned bare repository.** Isolates the object database
  but makes the deliverable unusable from the operator's own checkout and adds
  an object-transfer step with no safety gain at this boundary.
- **`git add --all` in the Attempt worktree.** Lets Git re-derive the deliverable
  set, so Forgeyard could not prove the tree equals its declared projection.
- **Promoting the Attempt worktree's own commits.** Promotion delivers reviewed
  content, not Attempt history. The worktree HEAD is recorded for audit instead.

## Consequences

- Approval remains non-delivering. There is still no push, merge, pull request,
  CI trigger, artifact upload, or deployment.
- A repository whose reviewed state cannot be projected exactly — a path Git and
  the filesystem disagree about, an unsupported file type, incomplete Evidence —
  cannot be promoted at all. That is the intended failure mode.
- The exclusion ledger's previews are bounded by the review byte budget while
  its hashes always cover the complete lists, so a very large ignored tree
  remains promotable with a complete, verifiable digest and a bounded rendering.
- The shared object database grows. Unreferenced objects from a failed promotion
  are ordinary Git garbage.

## Kill criterion

If proving exact correspondence between the reviewed raw workspace and a Git
tree stops being possible under a supported repository shape, Forgeyard must
narrow the supported shape or define a different deliverable representation. It
must not widen the projection by guessing, and it must not report a promotion
whose content it cannot prove.
