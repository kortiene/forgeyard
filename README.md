# Forgeyard

A DeepSeek Harness-native environment for controlled agentic engineering.

Forgeyard wraps native DeepSeek Harness Sessions with durable engineering Missions, isolated Git Attempts, objective Evidence, Verification, and explicit Decisions.

DeepSeek Harness executes the work.

Forgeyard makes the work governable.

## Milestone 1: One Verified Attempt

This repository is deliberately limited to the first product test: create one Mission, materialize its initial Task, freeze an Attempt, run a native DeepSeek Harness Session in an isolated Git worktree, collect trusted Evidence, evaluate Verification, and record an explicit Decision.

The implementation is an experimental, single-machine modular monolith. It is not a claim of production-ready autonomous development, exactly-once execution, enterprise orchestration, or a distributed agent fleet. Treat a checkout as verified only after its own `pnpm check` result has been inspected; this README does not record a permanent pass claim.

Forgeyard owns:

- durable Mission, Task, Attempt, Evidence, Verification, and Decision records;
- immutable execution snapshots and deterministic review digests;
- repository authorization, base-commit resolution, and isolated Attempt worktrees;
- trusted Git and verifier-command collectors;
- the Cockpit views and the exact Attempt-to-Session association.

DeepSeek Harness owns:

- the conversation, model loop, tools, approvals, shell/editor, trajectory, subagents, context management, and live interaction;
- Session persistence, model/provider adapters, permission presets, and sandbox enforcement.

There is no second chat surface. The Cockpit contributes only the native `sidebar.footer.action`, `shell.overlay`, and `conversation.session.header.actions` seats and enters a Session with `ctx.sessions.open(sessionId)`.

## Authority and review model

`forgeyard.sqlite` is the Forgeyard domain authority. It enables WAL, foreign keys, a busy timeout, explicit transactions, and `BEGIN IMMEDIATE` for state changes. DeepSeek Harness Session storage remains independent.

An Attempt freezes the Task, exact Git base commit, provider/model selection, reasoning setting, DSH agent and permission presets, sandbox facts, the exact visible tool-schema set, and verification requirement. It also receives a deterministic worktree path, a raw-workspace baseline, and a new opaque DSH Session ID. Retry preflights the successor first, then atomically records the predecessor's `RETRY` Decision, terminal state, successor link, and new preparing Attempt in one SQLite transaction; it never reuses the old Session or worktree authority.

Only Host-side collectors create trusted Evidence. Agent messages are claims, not Evidence. Approval requires complete `PASS` Verification for every frozen requirement and binds the Decision to a digest of the execution snapshot, live Git fingerprint, ordered Evidence hashes, and ordered Verification hashes. Any reviewed-state change makes the approval stale and fails closed.

The SQLite schema is version 2. Migration 001 remains immutable; migration 002 adds the worktree identity/raw-baseline binding, retry links, one terminal Decision constraint, and terminal child-record sealing.

On Host restart, uncertain non-terminal Attempts become `needs_review`. Forgeyard neither infers success nor retries automatically, and it retains the worktree for inspection.

## Prerequisites

- Node.js `^22.19.0` or `>=24.0.0`;
- pnpm `11.7.0` through Corepack;
- Git on `PATH`;
- a local DeepSeek Harness provider/model configuration that can use the profile's selected route;
- a DSH sandbox backend that reports full enforcement for the frozen `read-only` or `workspace-write` mode;
- an existing operator-controlled directory to use as the repository allowlist root.

DeepSeek Harness and every directly used DSH package are pinned to `0.1.1-rc.2`, source tag `dsh-v0.1.1-rc.2`, commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. See [DSH compatibility](docs/dsh-compatibility.md) before changing any pin.

## Install and build

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` compiles the Host face, generates the Typert Host and browser Remote artifacts, and emits the static Web client face. The rc.2 Typert generator needs the contained build workaround recorded in [ADR-0002](docs/adr/0002-rc2-out-of-tree-typert-generation.md); it is not a private runtime integration or a DSH fork.

## Local DSH Web profile

The repository includes a development profile at `profiles/local`. Its bundle order is:

1. `@deepseek-ai/dsh-base`
2. `@deepseek-ai/dsh-web-app`
3. `forgeyard`

Install the profile-local link after building:

```sh
pnpm --dir profiles/local install --ignore-workspace --no-lockfile
```

For the checked-in development layout, use the repository root as a temporary DSH home so `profiles/local` is discovered. Set the allowlist to the narrowest existing parent that contains repositories Forgeyard may operate on:

```sh
export DSH_HOME="$PWD"
export FORGEYARD_REPOSITORY_ROOT="/absolute/operator-controlled/repositories"
./node_modules/.bin/dsh --profile local --dump-config
./node_modules/.bin/dsh --profile local
```

Inspect the composed configuration before booting. The Web process prints its listening address. Provider credentials and model availability are configured through DeepSeek Harness, not Forgeyard.

The checked-in smoke gate boots the real pinned DSH Web profile, loads the Forgeyard Host face, serves the assembled Web application, calls the generated Forgeyard Typert Remotes, and drives two native Attempts with distinct Sessions/worktrees through trusted Evidence, Verification, `RETRY`, and a terminal Decision. It also proves the base checkout stayed clean and checks the Host schema:

```sh
pnpm smoke:profile
```

On a host with a usable DSH sandbox backend, Attempt 2's verifier passes and the exact digest is approved. On a host without one, both Attempts require `ERROR`, approval is proven blocked, Attempt 1 remains immutable with `RETRY`, and Attempt 2 records `REJECT`; the verifier never runs unconfined.

The DSH contract suite separately executes the emitted browser bundle in a browser DOM, mounts its three slot contributions, opens the Cockpit, invokes `ctx.sessions.open(id)`, and returns through the Session-header action to the exact Attempt. The assembled-browser acceptance harness then drives that same round trip in a real Chromium against the real pinned graphical profile:

```sh
pnpm smoke:browser
```

The provider-driven acceptance harness requires a usable configured provider and full DSH sandbox enforcement. It runs two real native Attempts: Attempt 1 reaches a complete approvable `PASS` and is sealed by `RETRY`; Attempt 2 uses a new Session/worktree, reaches `PASS`, and is bound to `APPROVE`. It fails closed with the exact public `session.history` `turn/end` provider error when a route cannot execute:

```sh
pnpm smoke:native
```

See [the Milestone 1 acceptance runbook](docs/milestone-1-acceptance.md) for case-sensitive filesystem requirements, provider overrides, evidence assertions, and fail-closed interpretation.

This `DSH_HOME=$PWD` arrangement is a development convenience. Do not select the Forgeyard checkout itself as a Mission repository in that arrangement: an Attempt worktree root must be outside its selected base repository. Use a separate DSH home/profile installation for that case.

The default bundle configuration writes `forgeyard.sqlite` and `forgeyard-worktrees/` below `DSH_HOME`, selects `deepseek-official` / `deepseek-v4-flash` with `high` reasoning, and uses the `workspace-write` permission preset. Change these values only through an explicit local profile override whose complete row configuration has been reviewed.

In the Cockpit:

1. Create a Mission with a repository, base ref, objective, implementation instruction, and one verification command.
2. Start the materialized Task's Attempt. Forgeyard creates and permanently binds the worktree and native DSH Session.
3. Enter the Session from Attempt review. The overlay closes before `ctx.sessions.open(sessionId)` runs.
4. Use the Session-header Forgeyard action to return to the exact Attempt, then explicitly request Verification. Forgeyard safely cold-resumes a persisted Session through the public `sessions.models` API when needed, validates the frozen execution policy, and claims the exact Agent's maintenance phase instead of racing execution.
5. Inspect Git Evidence, command Evidence, Verification, and the review digest. Approve is available only for a current, complete, all-passing review; Reject, Retry, and Cancel remain explicit append-only Decisions.

Verification commands are parsed into one direct argv invocation. Shell operators such as pipes, redirects, and command substitution are rejected; invoke a checked-in script when a multi-step verifier is needed.

While Verification holds the parent Agent maintenance phase, later waking input stays parked until the guarded operation settles. Forgeyard first drains continuable descendant Agents through `ctx.subagents`, cancels and awaits every owner-scoped DSH background Job, then collects final Git Evidence after the verifier commands. Terminal Decisions additionally repeat that complete execution-tree drain after the release-to-cancel race. A Host-level public `agent/pre-step` guard rejects model steps for terminal and recovery-uncertain Forgeyard Attempts, including after cold Session resume. Each verifier is resolved against the Attempt's exact live Session and frozen confined sandbox mode, wrapped with `ctx.sandbox.confine(...)`, and executed only when DSH reports `enforcement: 'full'` for the exact Attempt worktree.

## Tests

Run the complete local gate:

```sh
pnpm check
```

Or run the compatibility and product boundaries independently:

```sh
pnpm test:dsh-contract
pnpm test:real-git
pnpm test:vertical-slice
pnpm smoke:profile
```

- DSH contract tests guard the pinned package versions, public Host calls, cold Session resume, frozen model/permission/tool enforcement, complete Agent/subagent/Job maintenance fences, sandbox policy/confinement, static dual-face package shape, emitted browser bundle rendering, slot lifetimes, Session round trip, managed subprocess seam, and generated Typert surface.
- Real Git tests use temporary repositories and worktrees; they do not mock Git.
- The vertical slice exercises Mission through Decision and Retry, including `FAIL` and `INCOMPLETE` verifiers that must block approval, verifier-created ignored state, original-checkout drift, recovery, and absent-Session cancellation.

Test results are environment-specific. Do not infer a pass from the presence of a test or build artifact.

## Repository layout

- `packages/forgeyard/src/host/` — the one Host service, SQLite store, execution adapter, Git authority, and trusted collectors;
- `packages/forgeyard/src/client/` — the Cockpit controller and three native DSH slot contributions;
- `packages/forgeyard/migrations/` — the Forgeyard SQLite schema;
- `profiles/local/` — the single local DSH Web profile;
- `tests/dsh-contract/`, `tests/real-git/`, `tests/vertical-slice/` — compatibility and acceptance boundaries;
- `docs/adr/` — architectural decisions.

The one runtime package is a DSH packaging boundary, not a split into domain micro-packages.

## Deliberate limitations

- DSH `0.1.1-rc.2` is a prerelease and Forgeyard accepts its public seams only under exact pins and contract tests.
- In rc.2, `sessions.selectModel` also updates DSH's default model selection for future Sessions; Attempt selection is therefore not globally side-effect-free.
- `sessions.prompt` confirms queue admission, not model-loop completion. Forgeyard does not infer completion; an explicit Verify or Approve request must acquire the exact live Agent's `runMaintenance` phase and is refused while it is busy.
- Git fingerprints include tracked differences plus a root-inclusive raw-workspace manifest covering every directory, regular file, symlink target, content hash, and review-relevant filesystem metadata—including ignored files and empty directories. Forgeyard rejects filters/attributes, index-hiding flags, replace refs, gitlinks, and related Git interpretation features that could hide verifier-visible bytes.
- Any collector-output or review-diff truncation marks Evidence `INCOMPLETE` and blocks approval, even when a diagnostic hash remains available.
- Milestone 1 accepts only a clean, operator-owned ordinary base worktree; linked worktrees, submodules as the selected base, and broader repository topologies fail closed.
- Verification runs through DSH's resolved sandbox policy, `sandbox.confine`, and managed subprocess service. Partial or unavailable confinement is an error. The DSH sandbox is a same-world file-effect boundary, not a separate hostile-code container or a network/process isolation claim.
- DSH rc.2 exposes no atomic `permissionPreset` field on `sessions.create` and no observer-side permanent Session seal/dispose call. Forgeyard applies and reads back permission authority before its first prompt, serializes Forgeyard Remotes through that edge, and globally rejects terminal pre-steps; these are safe local alternatives, not claims that the underlying Session becomes unreopenable.
- Entering a trusted review boundary drains continuable descendants and owner-scoped background Jobs through public DSH services. That closes new continuable-child admission below the live parent for the rest of that Agent activation; resume work in a Retry Session rather than treating a reviewed Attempt as an open-ended workspace.
- SQLite is local, unencrypted, single-machine authority. There is no authentication, RBAC, multi-tenant isolation, or remote coordination.
- Forgeyard retains Attempt worktrees for review. External delivery, promotion, CI/GitHub integration, remote workers, fleet/lease protocols, message brokers, object storage, and deployment infrastructure are not implemented.

Read [SECURITY.md](SECURITY.md) before using Forgeyard on valuable repositories.

## License

MIT. See [LICENSE](LICENSE).
