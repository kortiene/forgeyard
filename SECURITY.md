# Forgeyard security model

Forgeyard is for one trusted operator on one machine. It assumes the engineering agent and repository content may be wrong or adversarial, but it does not provide a hostile multi-user, multi-tenant, or remote-execution boundary.

Do not use this milestone on a repository whose loss or disclosure cannot be tolerated without an independent backup and OS-level containment.

## Trust boundaries

- The operator authorizes repository roots, supplies the Mission, starts Verification, reviews Evidence, records Decisions, and explicitly confirms every promotion. DSH Agent maintenance—not operator judgment—guards the idle mutation phase.
- DeepSeek Harness owns model execution, tools, immediate approvals, the effective Session sandbox, and Session persistence.
- Forgeyard Host owns the SQLite domain authority, repository/worktree binding, trusted collectors, Verification evaluation, the review digest, and the promotion projection and its Forgeyard-owned Git output.
- The model and all agent messages are untrusted claims. They cannot create or modify trusted Evidence records.
- Repository code and verification commands are untrusted programs. A `PASS` means that the recorded command exited successfully under the recorded conditions; it is not a proof that the command was honest, sufficient, or side-effect-free.

## Controls

### Repository and worktree authority

Forgeyard:

- resolves the selected path and Git top-level to canonical paths;
- requires a non-bare ordinary base worktree under an operator-controlled allowlist;
- checks base-directory device/inode identity and, on POSIX, operator UID ownership;
- rejects a selected linked worktree or submodule topology in Milestone 1;
- requires the base checkout to be clean, resolves the base ref to an immutable commit OID, freezes its HEAD/status, and rechecks that exact checkout state after worktree creation and again before approval;
- chooses a deterministic Attempt path below its mode-`0700` managed root; model input never chooses that path;
- creates a detached, locked Git worktree with hooks redirected to an empty managed directory and binds a root-inclusive raw filesystem baseline with the worktree device/inode identity;
- validates canonical worktree, Git common-dir, and base-commit identity before binding the Session;
- rejects Git filters and include-based local configuration, attributes, sparse/index-hiding flags, replace refs, object alternates, and gitlink entries that could make Git's view differ from verifier-visible bytes;
- retains uncertain work and quarantines rather than deleting when cleanup authority cannot be proven.

An Attempt worktree is retained for review. Cleanup, when explicitly invoked, requires the exact authorized fingerprint; a changed or uncertain worktree is quarantined.

### Process execution

Git and verifier commands use DSH's managed subprocess service with explicit argv, cwd, environment additions, output limits, spill limits, deadlines, and process-tree termination. Forgeyard never passes a verifier through a shell, and its command parser rejects shell control syntax.

Before a verifier is spawned, Forgeyard resolves the exact live DSH Session and requires its cwd to equal the immutable Attempt worktree. It calls `ctx.sandboxPolicy.resolve({ session, mode })` with the frozen `read-only` or `workspace-write` mode, requires the resolved mode and workspace root to match the Attempt, then calls `ctx.sandbox.confine(argv, policy)`. The wrapped argv runs only when DSH reports `enforcement: 'full'`; a missing Session/backend, `danger-full-access`, path mismatch, or partial enforcement records an error and does not run the original verifier.

Git execution disables terminal prompting, system/global Git configuration, filesystem monitors, external diff/text conversion in evidence collection, and repository hooks for Forgeyard-issued commands.

DSH's subprocess layer scrubs credential-shaped and `DSH_*` ambient environment names. Forgeyard explicitly adds only verifier facts such as `CI=1`, `NO_COLOR=1`, and the Attempt ID. The evidence record includes relevant platform, architecture, Node, and subprocess-policy metadata.

### Evidence, Verification, and Decisions

Evidence is append-only and includes collector identity/version, content hashes, and completeness. Git Evidence is collected twice and rejected if the fingerprint changes between snapshots. The Git fingerprint covers tracked changes and a root-inclusive manifest of every directory, regular file, symlink target, byte hash, and review-relevant filesystem metadata, including ignored files and empty directories. Command Evidence records exact requested argv and cwd, confinement facts and an executed-argv hash, exit/signal/timeout, duration, bounded stdout/stderr, stream hashes, and truncation/completeness facts.

Any output or review-diff truncation makes the corresponding Evidence `INCOMPLETE`, regardless of whether a full-content diagnostic hash could be retained. Incomplete Evidence cannot produce an approvable review.

Verification is a separate immutable evaluator record with `PASS`, `FAIL`, `ERROR`, or `INCOMPLETE`. Agent prose cannot override it. Approval is disabled unless every frozen requirement has one complete, current `PASS` result.

An `APPROVE` Decision is append-only and authorizes one deterministic review digest. Forgeyard recomputes the live Git fingerprint and original-checkout state before approval; a changed base checkout, worktree, Evidence set, Verification set, or execution snapshot makes the review stale. Verification claims the exact live parent Agent's maintenance phase, drains its continuable descendant forest, and cancels/awaits its owner-scoped background Jobs before executing verifiers and collecting final Git Evidence. Every terminal Decision cancels and drains the parent and that DSH-owned execution tree, runs its review/transaction under maintenance, then repeats the drain after the release race. A global public `agent/pre-step` listener rejects later model steps for terminal or recovery-uncertain Forgeyard Sessions, including after cold resume.

### Promotion

Promotion is a separate authority from approval. `APPROVE` authorizes one reviewed state; it delivers nothing. A promotion runs only when the Attempt is `approved`, its terminal `APPROVE` Decision still matches the recomputed live review digest, the stored review authority passes the same integrity checks approval required, the original base checkout still matches its frozen HEAD and status, the live worktree fingerprint equals the approved Evidence fingerprint, the live raw-workspace hash equals the reviewed `workspaceHash`, and the operator confirms that exact digest in the request. Any other state fails closed.

Promotion does not re-enter the Attempt's DSH Session. The terminal Decision already cancelled the Agent, drained its continuable descendants and owner-scoped Jobs, and installed a global `agent/pre-step` rejection for that Session, so claiming maintenance again would resume a sealed Session rather than fence anything. Promotion therefore reads only SQLite, the filesystem, and Git, and re-checks the live fingerprint and base checkout after its objects are written and before any ref exists. A process outside DSH ownership that edits the retained worktree during that window is detected by those checks; it is not prevented by them.

A Git tree cannot carry the whole reviewed workspace. Forgeyard declares a total projection instead of implying otherwise: every reviewed manifest entry is classified as `promoted`, `git-admin`, `ignored`, `directory-implied`, or `directory-dropped`, the counts must sum to the manifest entry count, and the record's `notCarried` statement names every reviewed fact Git drops—ignored content, dropped and empty directories, the `.git` pointer, permission bits other than the executable bit, symlink modes, ownership, timestamps, and inode identity. A manifest entry Git's own view cannot explain, or a Git path the reviewed workspace does not hold, fails the promotion closed. **A promoted commit is therefore not a claim that the reviewed workspace was delivered in full; it is a claim about the declared projection, and the exclusion ledger is part of the record.**

Correspondence is proven rather than assumed. Each promoted entry is read once under no-follow open and full before/after identity checks, computing both the SHA-256 the trusted manifest recorded and the Git object name for the same bytes; a read whose identity moved or whose SHA-256 differs from the manifest fails closed. The tree is built from that explicit path list in a scratch index under `GIT_INDEX_FILE` with `GIT_LITERAL_PATHSPECS`, never with `git add --all` and never with `-f`, and is accepted only when Git independently produced the identical object name and Git mode for every declared path in both the index and a re-read of the written tree.

The output is one commit whose single parent is the Attempt's frozen base commit, authored and committed by a pinned `Forgeyard <forgeyard@promotion.invalid>` identity dated at the approval instant, under the ref `refs/forgeyard/promotions/<attemptId>` created with Git's own compare-and-swap requiring absence. Forgeyard refuses to write any other ref name. It never pushes, merges, opens a pull request, triggers CI, uploads an artifact, or deploys.

The operator's checkout keeps its branch, HEAD, index, and working tree. The shared object database and the `refs/forgeyard/` namespace do gain content — that is the durable output. `refs/forgeyard/**` is outside `refs/heads`, `refs/tags`, and `refs/remotes`, so ordinary `git push`, `git push --all`, and `git fetch` do not carry it; `git push --mirror` and an explicit refspec still would. Treat a promoted ref as local, unsigned, unreviewed-by-anyone-else content until a human inspects it.

At most one unfailed Promotion may exist per Attempt and per ref, enforced by SQLite partial unique indexes inside `BEGIN IMMEDIATE` before Git is touched. Promotion authority columns are hashed and immutable; only the settle-once `status`, `failure_reason`, and `settled_at` transition. An interrupted promotion reconciles against its ref at restart: absent means no durable output exists and the Attempt is released for an explicit retry; equal to the recorded commit settles it promoted; a different object is reported as a failure and never overwritten.

### Local persistence and recovery

`forgeyard.sqlite` uses WAL, foreign keys, a busy timeout, synchronous writes, explicit transactions, and `BEGIN IMMEDIATE` for mutations. The containing directory is created mode `0700` and the database is set mode `0600` where the filesystem supports POSIX modes. Immutable-table triggers, terminal child-record sealing, exact Decision/state constraints, atomic Retry linkage, and settle-once Promotion constraints constrain accidental rewrites. Promotion scratch index and pathspec files live in a mode-`0700` managed directory and are removed after each attempt.

After a Host restart, Forgeyard marks uncertain non-terminal Attempts `needs_review` before installing live-Agent guards and rejects their later model steps, and reconciles every unsettled Promotion against its durable Git ref. It does not infer success, resume a completed state, delete worktrees, retry automatically, or promote automatically. A repository that is unreadable at boot leaves its Promotion `pending`, which the Cockpit reports as uncertain and which blocks another promotion of that Attempt until it reconciles. A terminal action bypasses Agent maintenance only when the public DSH Session lookup proves the opaque Session ID absent; attached or persisted Sessions are resumed and fenced.

## Known limitations

### DSH's same-world sandbox is the verifier boundary

Forgeyard requires DSH to report full file-effect enforcement for every verifier. That result is the selected DSH backend's enforcement claim, not an independent Forgeyard proof or a separate kernel/container boundary. DSH's sandbox vocabulary explicitly does not govern network or process visibility. Run Forgeyard inside an OS account, VM, or container whose filesystem, process, and network authority match the risk of the target repository.

Forgeyard refuses the verifier when the frozen Session mode is `danger-full-access`, the sandbox backend is unavailable, or enforcement is partial. These fail-closed checks do not protect against a defect in the DSH sandbox provider, its host runner, or the host kernel.

### Git worktrees share repository metadata

A Git worktree has an isolated working tree and index but shares the repository's common Git directory and object database. Forgeyard proves that its preparation leaves the base checkout's HEAD and working tree unchanged, but it does not place the common Git directory behind a separate filesystem or container boundary. A process with authority beyond the Attempt worktree can still affect shared refs, objects, configuration, or other worktrees.

Use the default `workspace-write` DSH permission preset only after verifying its enforcement on the host OS. Broader presets materially weaken the isolation claim.

### The allowlist is a local path policy

The allowlist authorizes canonical paths below configured roots. It is not RBAC, repository identity attestation, signed ownership, or protection against a privileged local administrator. POSIX UID ownership checking has no equivalent in the current Windows path. Network filesystems and filesystems with unusual identity or rename semantics have not earned support.

Milestone 1 fails closed for dirty base checkouts, selected linked worktrees, submodules as the base topology, invalid UTF-8 Git paths, and unsupported untracked file types. These restrictions are safety limits, not missing compatibility promises.

### Git interpretation is deliberately restricted

The Git fingerprint includes tracked differences plus the complete raw-workspace manifest; ignored files and empty directories appear with their own changed-file status, while metadata-only changes appear in a bounded raw delta. Any such mutation therefore makes the review stale.

To keep that raw-byte model meaningful, Forgeyard rejects repositories or worktrees that use clean/smudge filters, `.gitattributes` or `info/attributes`, include-based local configuration, sparse checkout/index visibility flags, replace refs, object alternates, or gitlink entries. These are Milestone 1 safety restrictions, not general Git compatibility.

### Admission and verification timing remain operator-coordinated

DSH rc.2's `sessions.prompt` response proves queue admission, not completion, and Forgeyard does not infer completion from conversation text. An explicit Verification or approval request resolves the exact live Agent and calls `Agent.runMaintenance`. That call starts only from the true idle phase, rejects while a turn or another maintenance task owns the Agent, and parks later waking input until Forgeyard releases the phase.

The maintenance claim plus public descendant/Job drain is the DSH-owned mutation fence, not merely an idle observation. It does not make prompt admission a completion event or stop unrelated OS processes outside DSH ownership. The first trusted-review boundary permanently closes continuable-child admission below that live Agent activation. A busy or unprovable Agent makes the request fail closed and the operator may retry after the native Session settles.

DSH rc.2 does not accept a permission preset atomically in `sessions.create`. A newly published Forgeyard Agent is not prompted until Forgeyard applies the frozen preset, reads it back, validates model/tool authority, and installs guards. Forgeyard serializes its own Remote reads and mutations across this edge, but another trusted local DSH client can observe the native Session in the narrow interval. A narrow upstream improvement would add an optional permission preset to public Session creation and apply it before Agent publication. This limitation is acceptable only under Milestone 1's single trusted operator assumption.

DSH rc.2 also has no observer-side permanent Session seal/dispose call. Forgeyard's terminal fence and global pre-step rejection prevent later model steps from regaining Forgeyard authority, but the native Session remains inspectable and a user with filesystem access can still edit its retained worktree. Such edits make the recorded review stale; they do not reopen the terminal Attempt.

### Model selection changes the DSH future default

In rc.2, the public `sessions.selectModel` call also updates DSH's default selection for future Sessions. Forgeyard freezes and checks the Attempt's effective provider/model, but concurrent Session creation can observe that shared default mutation. Use one trusted operator and review the current DSH model selection when multiple tools create Sessions.

### Local data is not encrypted or remotely durable

SQLite and DSH Session persistence are separate local stores. Mode bits are best-effort, neither store is encrypted by Forgeyard, and no backup, replication, audit export, retention policy, or disaster recovery service is provided. WAL sidecar files carry the same sensitivity as the main database.

Model/provider calls may transmit repository or Session content according to DSH provider configuration. Forgeyard does not add egress controls, redact prompts, or attest the provider. Verification commands and Git are also non-hermetic: their executable bytes, dynamically loaded libraries, clocks, and host services are not captured as a reproducible build environment.

The Cockpit has no authentication or RBAC, and `promote` is reachable on the same unauthenticated local Remote surface as every other Forgeyard operation. Anything that can reach DSH Web can therefore create a Forgeyard promotion ref and objects in an already-authorized repository. It still cannot promote a state Forgeyard did not approve, cannot overwrite an existing ref, and cannot push. Security relies on DSH Web's exposure and the host environment; do not bind it to an untrusted network.

### Delivery authority stops at the local repository

`APPROVE` authorizes only the exact reviewed state inside Forgeyard. Promotion adds exactly one delivery step: a local commit and a `refs/forgeyard/promotions/` ref in the already-authorized repository. Forgeyard does not push, merge, open a pull request, upload artifacts, invoke CI, or deploy, and it has no remote credential of its own.

A promoted commit is unsigned. Forgeyard disables commit signing so the commit name stays deterministic, so the pinned author identity is a Forgeyard label rather than an attestation. Anyone with write access to the repository can create, delete, or move a `refs/forgeyard/` ref outside Forgeyard; the SQLite record and the ref are two independent facts, and Forgeyard reports a disagreement rather than resolving it. Promotion refs are written with `--no-deref` and a promotion name that is already a symbolic ref is rejected, so Forgeyard never writes through a symref to somewhere else. That rejection is not atomic with the write on Git 2.43, which offers no primitive that would make it so: a *dangling* symref planted by a repository writer inside that window is replaced. It cannot cause a write outside `refs/forgeyard/`, and it needs the repository write access this paragraph already excludes from the trust boundary. ADR 0004 records the evidence.

Promoting does not review. A `PASS` still only means the recorded command exited successfully under the recorded conditions, and promotion carries that same limitation into a durable artifact. Inspect a promoted commit before merging it anywhere.

## Operational guidance

- Back up the base repository before first use and keep valuable remotes protected from the Forgeyard OS account.
- Configure `FORGEYARD_REPOSITORY_ROOT` to the narrowest dedicated parent; never use `/`, a home directory, or a broad workspace root without reviewing everything it authorizes.
- Keep `forgeyard-worktrees/` outside the selected base repository.
- Prefer a dedicated local OS account or disposable VM/container, with egress restricted separately when verifier code is untrusted.
- Keep DSH at the exact audited pin and run all compatibility, real-Git, and vertical-slice tests before an upgrade.
- Inspect `needs_review` Attempts and quarantine directories manually. Do not delete an uncertain path merely because a database record looks terminal.
- Treat any `INCOMPLETE` or truncated Evidence as non-approvable. Hashes and retained previews are diagnostic only and never waive completeness.
- Read a promotion's exclusion ledger before relying on the promoted commit. Ignored build output, empty directories, and restrictive file permissions are deliberately not carried.
- Inspect `refs/forgeyard/promotions/` with ordinary Git (`git log`, `git ls-tree -r`, `git diff <base>..<ref>`) and delete a promotion ref only after confirming what it is.
- Never resolve a promotion reported as `failed` because a ref already exists by deleting that ref blindly.

## Reporting a security issue

This greenfield repository does not yet publish a private security-contact channel. Until one exists, do not open a public issue containing credentials, repository content, local paths, Session transcripts, SQLite files, verifier output, or exploit details. Contact the repository owner through an already trusted private channel and include the exact Forgeyard commit, DSH pin, host OS, permission preset, and whether the affected Attempt/worktree was preserved.
