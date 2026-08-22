# DeepSeek Harness compatibility boundary

Forgeyard Milestone 1 is audited against one exact DeepSeek Harness release:

| Item | Pin |
| --- | --- |
| Release | `0.1.1-rc.2` |
| Source tag | `dsh-v0.1.1-rc.2` |
| Source commit | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| Node.js | `^22.19.0` or `>=24.0.0` |
| pnpm | `11.7.0` |
| Cordis | `4.0.1` |
| Schemastery | `3.18.1` |

All directly used `@deepseek-ai/dsh*` development and peer dependencies are exact `0.1.1-rc.2` pins. The lockfile is part of the compatibility boundary. No supported range is implied: DSH is still a release candidate, and an upgrade begins with source review and contract tests, not a version edit.

## Audit basis

The audit used the tagged DSH source and tests, not only package examples or remembered APIs. The inspected areas include:

- profile and bundle composition in `packages/boot/app-boot`;
- Session, Agent, and Host API contracts in `packages/core/session`, `packages/core/agent`, `packages/core/agent-loop`, and `packages/host/apiproxy`;
- permission presets, sandbox policy/provider, managed subprocess, subagent-descendant, and background-Job contracts;
- Client Session, slot, and Remote contracts in `packages/client/runtime`, `packages/client/ui-slots`, and the API Gateway;
- Typert protocol, registry, generator, and generated-output tests.

Published declarations under the exact installed packages are also asserted by Forgeyard tests. This matters because Forgeyard is out-of-tree: source existence alone does not prove that a symbol is exported in the installed release.

## Public seams Forgeyard uses

Every seam below is part of the pinned, published package surface. “Guard” names the local compatibility boundary; it is not a claim that the prerelease API is stable across upgrades.

| Face | Public seam | Forgeyard use | Guard |
| --- | --- | --- | --- |
| Package | `package.json#dsh.bundle.patch` | Load one static Host Cordis row from `cordis.patch.yml`. | `tests/dsh-contract/packaging-contract.test.ts` |
| Package | `package.json#dsh.client` (`platform`, `inject`) | Publish one static Web client face with its DSH client dependency graph. | `tests/dsh-contract/packaging-contract.test.ts` |
| Profile | `package.json#dsh.profile.bundles` | Compose base, Web app, then Forgeyard without forking DSH. | `tests/dsh-contract/packaging-contract.test.ts` |
| Profile | `dshHomePath(...)` in a bundle patch | Place `forgeyard.sqlite` and managed worktrees under DSH home. | package/profile contract plus config dump inspection |
| Host / Cordis | `Service`, `Service.init`, `Context` injection, `ctx.effect`, `ctx.logger` | Own one modular-monolith Host lifecycle and close SQLite with its fiber. | Host build and service lifecycle tests |
| Host / Typert | `TypertRemoteService`, `@Remote(...)` | Export `snapshot`, `createMission`, `startAttempt`, `verifyAttempt`, `decide`, `retry`, and `attemptForSession`. | generated endpoint assertions in `packaging-contract.test.ts` |
| Host / API Proxy | `ctx.apiProxy.agentPresets.list(...)` | Resolve and validate the effective DSH agent preset before freezing an Attempt. | `tests/dsh-contract/host-contract.test.ts` |
| Host / presets | `ctx.agentPresets.standingKeyFor(id)` | Resolve the public scope key for the exact preset whose tools are frozen. | declaration and behavior assertions in `host-contract.test.ts` |
| Host / tools | `ctx.tools.schemas(scope)`, `agent.ctx.tools.guard(...)` | Hash the sorted visible tool schemas and monotonically deny unlisted/drifted tools on the live Agent. | schema/guard drift assertions in `host-contract.test.ts` |
| Host / API Proxy | `ctx.apiProxy.sessions.create(...)` | Create a native Session with the Attempt worktree as `cwd`. | `tests/dsh-contract/host-contract.test.ts` |
| Host / Session | `SessionId(...)`, `ctx.sessions.get(id)` | Use the opaque ID and prove that the created Session header is bound to the exact worktree. | `tests/dsh-contract/host-contract.test.ts` |
| Host / API Proxy | `ctx.apiProxy.sessions.models(...)` | Read the complete provider/model/reasoning selection and safely cold-resume a persisted Web Session with DSH's recorded preset composition. | runtime-source and cold-resume assertions in `host-contract.test.ts` |
| Host / Agents | `ctx.agents.get(id)`, `ctx.agents.list()`, `Agent.runMaintenance(task)` | Resolve/cold-start exact Agents, guard any registry entries that predate plugin initialization, and claim maintenance around Verification/review. | declaration and maintenance assertions in `host-contract.test.ts` and the vertical slice |
| Host / Agents | `Agent.cancel(...)`, `Agent.whenIdle()` | Cancel/drain before and after every terminal Decision maintenance transaction. | terminal-fence assertions in `host-contract.test.ts` |
| Host / subagents | `ctx.subagents.drainContinuableDescendants([agent])` | Close descendant admission and stop/await the complete continuable child forest below the exact Attempt Agent before trusted review. | declaration, ordering, and behavior assertions in `host-contract.test.ts` |
| Host / Jobs | `ctx.jobs.list(agent)`, `kill(id, agent, reason)`, `wait(id, timeout, agent, signal)` | Cancel and await one-shot subagent, workflow, shell, and other owner-scoped background work that can outlive the parent turn. | declaration and drain-order assertions in `host-contract.test.ts` |
| Host / events | `agent/created`, `agent/pre-step`, `agent/request` | Synchronously guard resumed Forgeyard Agents, enforce frozen request policy, and reject terminal or recovery-uncertain Attempt model steps. | declaration/guard assertions in `host-contract.test.ts` plus Host build |
| Host / permissions | `ctx.permissionPresets.resolve(name)`, `set(session, name)`, `current(events)` | Freeze, apply, and read back the exact effective sandbox/approval preset. | declaration and drift assertions in `host-contract.test.ts` |
| Host / sandbox policy | `ctx.sandboxPolicy.resolve({ session, mode })` | Resolve the frozen confined mode with the exact Session cwd as workspace root. | confinement call-shape assertions in `host-contract.test.ts` |
| Host / sandbox | `ctx.sandbox.confine(argv, policy)`, `ConfinedArgv.enforcement` | Wrap the exact verifier argv and refuse execution unless the provider reports full enforcement. | full/partial enforcement assertions in `host-contract.test.ts` |
| Host / API Proxy | `ctx.apiProxy.sessions.selectModel(...)` | Apply and confirm the frozen provider, model, and optional reasoning effort. | `tests/dsh-contract/host-contract.test.ts` |
| Host / API Proxy | `ctx.apiProxy.sessions.prompt(...)` | Queue the immutable Attempt instruction in the native Session. | `tests/dsh-contract/host-contract.test.ts` |
| Host / subprocess | `ctx.subprocess.spawn(spec)` and its managed handle | Run Git and the sandbox-wrapped verifier argv without a shell, with deadlines, maintenance cancellation, and bounded/spilled collection. | managed-process and abort-propagation tests in `host-contract.test.ts` |
| Client / Remote | `ctx.remote.$mount(contribution)` and generated `ctx.remote.forgeyard.*` | Mount the generated Typert client and call the Host-authoritative domain service. | build output and generated endpoint contract |
| Client / slots | `ctx.slots.inject(...)`, `ctx.slots.register(...)` | Add contributions only for the lifetime of their owning DSH seats. | `tests/dsh-contract/client-contract.test.ts` |
| Client / slots | `sidebar.footer.action` | Open the Cockpit from the native sidebar. | exact-name and lifetime assertions in `client-contract.test.ts` |
| Client / slots | `shell.overlay` | Render the three Cockpit views inside the existing DSH React tree. | exact-name and lifetime assertions in `client-contract.test.ts` |
| Client / slots | `conversation.session.header.actions` | Return from a native Session to its exact persisted Attempt. | exact mapping and ambiguity tests in `client-contract.test.ts` |
| Client / Sessions | `ctx.sessions.list`, `ctx.sessions.open(id)` | Check Session availability, close the overlay, then enter that native Session. | ordering and exact-ID assertions in `client-contract.test.ts` |
| Client / Cordis | `ctx.effect(...)` | Dispose the shared Cockpit controller with the client fiber; styles render declaratively inside the DSH-owned overlay slot tree. | emitted-bundle render and slot lifecycle tests |

Forgeyard does not use DSH routes, private Session events, internal React roots, DOM replacement, or a private Host-to-client carrier.

## Important rc.2 behavior

### Session creation and binding

`ctx.apiProxy.sessions.create` accepts a caller-provided `sessionId` and an exclusive `cwd`/workspace binding. Forgeyard supplies the deterministic Attempt worktree as `cwd`, then reads `ctx.sessions.get(id).header.cwd` and fails if DSH bound anything else.

The rc.2 create contract has no permission-preset field. Forgeyard's smallest public alternative is to publish no prompt until it has called `permissionPresets.set`, read the effective preset back with `current`, validated all frozen authority, and installed Agent guards. Forgeyard Remotes are serialized across that edge. A narrow upstream contribution would accept an optional preset in `sessions.create` and apply it before Agent publication. Under the one-trusted-operator Milestone 1 profile this is a limitation, not a kill criterion; it becomes a kill criterion before untrusted concurrent clients are in scope.

API Proxy business failures are returned as `result.ok: false`; they are not necessarily thrown. Forgeyard unwraps and rejects those failures explicitly. Direct Host-local calls do not cross the browser carrier, so Forgeyard keeps its own typed request construction and contract tests at that boundary.

### Model selection is not Session-local in every effect

In rc.2, `ctx.apiProxy.sessions.selectModel` selects the route for the target Session and also asks DSH's default-model service to persist it for future Sessions. The persistence failure is swallowed by DSH after the Session selection succeeds. Forgeyard verifies the selected Session route and records it in the immutable execution snapshot, but cannot claim that the operation leaves the process-wide future default unchanged.

### Prompt acceptance is not completion

`ctx.apiProxy.sessions.prompt` acknowledges that the prompt was admitted to the Session queue. It does not await the end of the agent turn or prove whole-agent idleness. Forgeyard therefore enters `running` after admission and requires an explicit Verification request. It does not infer completion from a prompt response or agent statement.

### Agent maintenance and terminal fences

For Verification, Forgeyard resolves the exact live Agent and calls `Agent.runMaintenance(task)`. A cold persisted Session is resumed only through public `sessions.models`, whose rc.2 Web implementation owns reconstruction of its recorded preset composition; Forgeyard deliberately does not call `agents.resume` and guess DSH setup. Once the parent maintenance claim is held, Forgeyard calls `subagents.drainContinuableDescendants([agent])`, then lists, kills, and waits all DSH Jobs owned by that Agent. This closes continuable descendant admission and releases child forests; DSH owner teardown covers their own Jobs, while parent-owned one-shot/background work is drained explicitly. Only then does Forgeyard hold the boundary across frozen-policy readback, verifier execution, final trusted Git collection, and guarded state mutation.

Every terminal Decision calls public `cancel`, awaits `whenIdle`, drains the execution tree and runs review/SQLite transition under maintenance, then cancels, reclaims maintenance, and drains the execution tree once more to cover a queued turn winning the release-to-cancel window. A global public `agent/pre-step` listener rejects a model step whenever the exact Session maps to a terminal or `needs_review` Forgeyard Attempt, including after cold resume. DSH rc.2 exposes no observer-side permanent Session seal/dispose operation, so Forgeyard does not claim the Session is unreopenable; the SQLite Attempt remains terminal and later filesystem edits only stale the reviewed state.

If a pre-Session failure leaves an Attempt in `needs_review`, Forgeyard calls the public persistence-aware `sessions.models` boundary. Only the exact `session-not-found` result permits a terminal Decision or Retry without an Agent fence; any attached or persisted Session is resumed and fenced. Recovery runs before existing-Agent policy installation, and `needs_review` Agents are step-blocked rather than allowed to abort Host initialization on an unprovable partial admission.

A missing or busy Agent fails closed. The maintenance API does not turn prompt admission into automatic completion. The terminal fence cancels DSH-owned turn/inbox work, but cannot stop an unrelated OS process already outside Agent ownership.

### Verifier sandbox policy and enforcement

Forgeyard resolves the Attempt's exact live Session, requires `session.header.cwd` to match the immutable worktree, and accepts only frozen `read-only` or `workspace-write` modes. It then calls `ctx.sandboxPolicy.resolve({ session, mode })`, verifies the returned mode/root, and passes the exact verifier argv to `ctx.sandbox.confine(argv, policy)`.

Only a `ConfinedArgv` with `enforcement: 'full'` is spawned through `ctx.subprocess`. `danger-full-access`, a missing sandbox backend, policy/path disagreement, or partial enforcement becomes non-passing Evidence and the original verifier argv is never executed. DSH defines this as same-world file-effect confinement; network and process visibility are outside the sandbox-mode vocabulary.

### Evidence completeness and a transparent Git view

Forgeyard rejects filters, attributes, include-based local configuration, index-hiding/sparse flags, replace refs, object alternates, and gitlinks before trusting Git's interpretation of the worktree. Its fingerprint combines tracked differences with a persisted root-inclusive raw manifest covering all directory/file/symlink content and review-relevant metadata, including ignored files and empty directories.

Any collector-output or review-diff truncation marks Evidence `INCOMPLETE`; retained hashes and previews remain diagnostic but cannot authorize approval.

### Client navigation is exact and fail-closed

The durable DSH Session ID is unique on an Attempt. Before `ctx.sessions.open(id)`, the Cockpit closes its overlay. The Session-header action resolves that ID back through Forgeyard Host state. A missing or ambiguous association is an error; the client never chooses a “latest” Attempt by guess.

## Contained Typert generator defect

The rc.2 public out-of-tree Typert generator has two composition defects:

1. its tsdown plugin stops at the package-local face config instead of the repository workspace root;
2. its symbol check does not recognize `@Remote` from the published protocol declarations in an out-of-tree project.

Forgeyard invokes the public `WorkspaceTypertGenerator` with an explicit root and supplies a compile-time-only ambient mirror of the pinned public Typert declarations. Runtime imports still come from `@deepseek-ai/dsh-typert-protocol`; there is no copied runtime, private import, or DSH fork. [ADR-0002](adr/0002-rc2-out-of-tree-typert-generation.md) records the upstream-sized fix and kill criterion.

If an upgrade changes the public signatures or generated contribution shape, Forgeyard will not maintain a divergent hand-written wire protocol. Work pauses for the narrow upstream fix or the DSH-native approach is revised.

## Ecosystem ideas adapted

These repositories were inspected as source evidence. Forgeyard adapted specific patterns, not their product domains or compatibility surfaces.

| Reference | Inspected commit | Idea adapted |
| --- | --- | --- |
| `dsh-dashboard` | `834a07b5601531f686d1a2a261bdf8172c8fa9ce` | Out-of-tree dual-face package metadata, the static lazy-CJS Web wrapper, and additive sidebar/overlay slot participation. |
| `dsh-task-board` | `7fe31114b7dfe959ede4d4993c98f6b6e3b3c0e4` | Host-local API Proxy Session admission and generated Typert Remote organization. |
| `dsh-git-worktree` | `35a3d1dfc77a9e7b7c0ee7fbe8f56aefd0c46d0a` | Canonical path and Git common-dir identity checks, conservative cleanup, and quarantine when authority is uncertain. |

Forgeyard reimplements Git authority for its immutable Attempt model. It does not import a worktree plugin's domain records, commands, or cleanup authority.

## Upgrade procedure

For any DSH change:

1. inspect the candidate tag's source, tests, published exports, and declarations for every row in the seam table;
2. update all direct DSH pins and regenerate the lockfile as one change;
3. delete the Typert workaround if the upstream out-of-tree path is fixed; never stack a second workaround on it;
4. rebuild both Host and client faces and regenerate Typert artifacts;
5. run `pnpm test:dsh-contract`, then the real-Git and vertical-slice gates;
6. dump and inspect the composed `local` profile, then perform the Cockpit → Session → exact Attempt review round trip in DSH Web;
7. record an ADR if implementation evidence changes an architectural decision.

Failure of a required public seam is not permission to reach into a private DSH module. Document it, test the smallest public alternative, and evaluate the DSH-native kill criterion.
