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

The `pending` row carries a **lease**, and reconciliation may only settle a row
whose lease has expired. Absent means "no durable output exists" only if nothing
can still be creating one: several Hosts may share one SQLite authority, and
reading no ref inside another Host's window between its recorded intent and its
`git update-ref` proves nothing. Failing the row there would release the
uniqueness constraint while that Host went on to create a durable ref it could no
longer settle — an existing output recorded as `failed`, and every later retry
colliding with the ref it does not know about. The lease is derived from Git's
own hard command timeout: exactly two bounded Git commands separate the intent
from its settlement, so a lease of twice that bound plus a margin cannot expire
while a live Host is still in flight, and it caps how long an abandoned intent
blocks its Attempt after a Host dies. Finding nothing pending is not a reason to
stop looking: a peer sharing the database can record an intent and die with its
own timer, and nothing pushes that row to anyone else, so an idle Host keeps
polling rather than dropping its timer. A leased Promotion is reported as
`uncertain` and reconciled by the next pass once the lease lapses — a pass
Forgeyard arms itself, for the instant the question becomes answerable. It has
to: the Cockpit hides the promote action while an Attempt is ineligible, so no
operator gesture reaches the on-demand reconciliation inside `promote`, and a
Host that restarts before the lease lapses would otherwise leave the Attempt
blocked until it restarted again. A row whose lease has lapsed and still cannot
be settled is retried on a bounded interval rather than spinning.

A ref write that *fails* is equally uninformative: Git can commit its ref
transaction and still fail the call that ran it, so the error alone never decides
whether a durable output exists. Forgeyard reads the ref back and settles only
what the ref proves — this promotion's exact deterministic commit settles
`promoted`, absence settles `failed`, and any other object settles `failed`
naming both. If reading the ref fails too, nothing is guessed in either
direction: the Promotion stays `pending` and its lease hands the question to
reconciliation. A Promotion settles exactly once, by whichever Host gets there
first; the loser reports that authoritative outcome instead of failing.

A completed Promotion is not self-certifying either. The SQLite record and the
ref are two independent facts, and anyone with write access to the repository can
delete or move a `refs/forgeyard/` ref outside Forgeyard, so eligibility reads the
ref back before reporting an Attempt as promoted. A ref that is absent or holds
another object is reported as `diverged`, naming both facts; Forgeyard neither
recreates nor overwrites it, and a ref that cannot be read right now is reported
as unverified rather than as either answer. Each promotion also builds its tree in
its own exclusively created scratch directory: the tree is written before any row
claims the uniqueness constraint, so nothing else keeps two concurrent calls on
one Attempt from deleting each other's index and pathspec files.

The lease is a bound, not a fence. Git's command timeout bounds time spent
*inside* a Git call; it cannot bound a stopped process, a frozen container, or a
long garbage collection between the recorded intent and the write. Forgeyard
therefore re-reads its own ownership immediately before creating the ref and
refuses to write once the lease has lapsed, which is the last instant it
controls. A stall between that check and Git's own ref transaction remains
theoretically possible: the residual outcome is one durable ref recorded as
`failed`, which the deterministic commit makes self-correcting — the next
promotion computes the same commit, finds the ref already holding it, and records
it truthfully. Two Hosts that settle one Promotion in opposite directions are
reported as a disagreement rather than quietly reconciled.

Promotion refs are written with `--no-deref`, and a promotion name that is
already a symbolic ref is rejected outright. Git otherwise follows a symref, and
a `refs/forgeyard/promotions/<attempt>` pointed at `refs/heads/<anything>` would
make Forgeyard create that branch — a write outside `refs/forgeyard/`. `--no-deref`
alone is not enough, because a symref whose target does not exist has no object
value and Git silently replaces it.

That check is not atomic with the write, and on Git 2.43 it cannot be made so:
`update-ref --stdin` rejects a `verify` and a `create` for one ref in a single
transaction ("multiple updates for ref not allowed"), the `symref-verify`
primitive that would express it did not arrive until Git 2.45, and a replaced
dangling symref leaves a reflog byte-identical to a fresh creation, so it cannot
even be detected afterwards. What `--no-deref` *does* settle atomically is every
symref with a value: one pointing at an existing ref is refused by the
compare-and-swap itself. The residual is therefore narrow and is stated rather
than papered over — a symref pointing at nothing, planted by a repository writer
inside the window between the check and the write, is replaced. It requires
write access to the repository, which SECURITY.md already places outside the
trust boundary, and it cannot produce a write outside `refs/forgeyard/`. A ref is also not believed on its text alone:
the commit object it names is proven to exist and to be a commit, so a pruned or
damaged object database is reported instead of advertised as a durable output.

The same rejection applies when *reading*. Git dereferences symbolic refs
recursively by default, so a promotion name replaced by a symref to a branch
that happens to sit on the recorded commit resolves to exactly the expected
object name — and then silently follows that branch when it advances. The
resolved value alone therefore cannot distinguish a Forgeyard-owned output from
a moving target aimed outside the namespace, and a symref found at a promotion
name is reported as a disagreement rather than accepted. Because Forgeyard only
ever creates a direct ref, a symref at that name also proves no Forgeyard output
exists there, so a promotion that meets one fails immediately instead of waiting
out a lease that could not teach it anything more. Reconciliation settles such a
row for the same reason, rather than treating the rejection as a repository it
cannot read and repeating the pass forever.

Forgeyard distinguishes a settled question from one it merely cannot answer yet.
A repository that is not the recorded one, and a ref that is present but provably
unusable, are both definitive: looking again will not change them. They are
reported as `diverged` rather than continuing to advertise a promoted output, and
a pending row in the second class is settled and released rather than retried
forever. A repository it simply cannot read right now is neither, and is reported
as unconfirmed. The distinction is carried by typed errors rather than by
matching on messages.

Every retained Promotion is audit authority, including a `failed` one, so all of
them are integrity-checked before an Attempt is promotable again — a corrupted
failure history must not sit underneath a fresh promotion.

Background reconciliation does not hold the engine's mutation queue while it
probes Git. Only its settlements take the queue. A recovery pass can meet several
stalled repositories in a row, each command bounded at 120s, and holding the
queue across that would leave every Remote request — including the Cockpit's
first snapshot — waiting behind it, so a Host recovering quietly would look like
a Host that is down.

An absent ref and a broken one are also different facts. `rev-parse --verify
--quiet` exits identically for both — status 1, nothing on stdout — and only a
stderr warning separates a ref file holding a malformed object name from a name
nobody has used. Reading the second as the first would settle a Promotion as "no
durable output exists" and send every retry into a collision with the ref that is
still sitting there, so the namespace being occupied is treated as the
disagreement it is.

Validation follows the promotion's parent edge, not just its tree. The commit
names a frozen base parent, and a walk that stops at the commit reported a
pruned base as a durable output while `git show` on it could not parse. Exactly
two generations are walked: the promotion and its parent, which is the edge the
record claims and not the repository's whole history.

Promotion text is rejected unless SQLite can store it unchanged. An unpaired
UTF-16 surrogate is written as U+FFFD, so text hashed before that write can never
match the text read back: the Promotion would create its durable ref and then
fail its own integrity check forever, reporting invalid authority over a real
output. Refusing the input is the last point at which that is recoverable.

The promotion commit pins `i18n.commitEncoding=UTF-8` alongside disabling
signing. A repository-local encoding adds an `encoding` header and changes the
object name for the same tree, parent, message, identity, and date; ambient
configuration must not decide what a promotion is called, because the recovery
story depends on a retry recomputing exactly the commit that preceded it.

Nor is a ref believed because its commit object exists: `cat-file -e` proves only
that one object is present, so a pruned tree or blob beneath it would still be
advertised as a durable output. The commit's whole object graph is walked instead.

The lease budgets for every Git command the post-intent path runs, and that count
is measured by a test rather than asserted in a comment — it was written when the
path was two commands long, silently fell behind as commands were added, and a
hand recount while fixing it was still off by more than double. The pre-write
repository identity check is deliberately filesystem-only for the same reason:
re-canonicalizing would re-run the whole transparency audit, eighteen more
bounded commands, and triple the lease. With the shipped 120s Git timeout the
lease is about sixteen minutes, which is the recovery latency an Attempt pays if
its Host dies mid-promotion; that release is automatic. Renewing the lease
between commands would cut it to a single command's bound, and is a design change
to make deliberately rather than a constant to shave.

Migration 003 is the first migration that can meet a database another Host is
already upgrading. The runner therefore re-reads what has actually been applied
*inside* its `BEGIN IMMEDIATE` transaction, so a Host whose startup version read
lost the race skips the migration the winner committed rather than re-executing
`CREATE TABLE` and failing its own initialization. That in-lock read also repeats
the startup rejection: a Host that finds the shared database migrated past what
it supports refuses to initialize rather than running against a newer schema.

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
