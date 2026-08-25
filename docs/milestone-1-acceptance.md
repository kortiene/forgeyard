# Milestone 1 acceptance runbook

This runbook drives the two end-to-end Milestone 1 acceptance paths that the
unit, contract, real-Git, and vertical-slice suites cannot cover on their own:

1. a **real assembled-browser round trip** against the pinned DSH Web profile;
2. a **native provider-driven successful Attempt** with a real model-authored
   code change, trusted Evidence, `PASS` Verification, `APPROVE`, and Retry
   isolation.

Both harnesses fail closed: when a required capability (browser, provider
credential, fully enforcing sandbox, case-sensitive filesystem) is missing they
exit non-zero with an explicit `MISSING CAPABILITY:` line and never fake a
result, never run a verifier unconfined, and never trust model prose as Evidence.

## Prerequisites

- Node.js `^22.19.0` or `>=24`, pnpm `11.7.0` via Corepack, Git on `PATH`
  (see [docs/dsh-compatibility.md](dsh-compatibility.md) for the exact DSH pin).
- A built workspace and the profile-local link:

  ```sh
  corepack enable
  pnpm install --frozen-lockfile
  pnpm build
  pnpm --dir profiles/local install --ignore-workspace --no-lockfile
  ```

- A **case-sensitive, symlink-free filesystem** for every managed root. Forgeyard
  requires a transparent Git byte-view and rejects `core.ignoreCase=true`, and it
  rejects managed worktree paths that traverse a symlink. Linux `/tmp` already
  satisfies this. macOS default volumes are **case-insensitive** and alias `/tmp`
  and `/var` through symlinks, so acceptance work must run on a dedicated
  case-sensitive volume (see below).
- A **DSH sandbox backend reporting full enforcement** for the frozen
  `workspace-write` mode (macOS `sandbox-exec`/Seatbelt, Linux
  `bubblewrap`/Landlock). Without it, verifiers fail closed with `ERROR`.
- A **browser whose own sandbox can start**, for the browser path. Hosts that
  restrict unprivileged user namespaces (Ubuntu 23.10+ and other AppArmor
  distros) abort Chromium at startup; allow them with
  `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or set
  `FORGEYARD_CHROMIUM_NO_SANDBOX=1` to accept an unsandboxed browser for the run.
  The harness never disables the browser sandbox on its own.
- An **actually configured DSH provider** for both paths. The harnesses reuse the
  operator's real DSH configuration (`~/.dsh/settings.yaml`,
  `~/.dsh/.credentials.yaml`) in an isolated temporary DSH home. Only the
  credential is required: Mission overrides left null resolve through the pinned
  profile's own defaults, so no `agent-default-model` block is needed. The
  operator's `agent-presets.default` is deliberately **not** inherited — it names
  a preset from the operator's own profile, whose definition and plugins the
  pinned Forgeyard profile does not ship — so the pinned profile's roster default
  applies instead. Only **file-based** credentials survive into a spawned DSH process:
  the DSH tool sandbox scrubs credential-shaped environment variables, so a
  provider whose `apiKeyEnv` names an unset variable (for example
  `SAKANA_API_KEY`, `OPENAI_API_KEY`) cannot authenticate here. The Forgeyard
  profile default `deepseek-official` authenticates from the file-based
  `DEEPSEEK_API_KEY` credential and is the supported native-acceptance route.

## Case-sensitive volume on macOS

Provision a privilege-free case-sensitive APFS sparse image and run the gate
with `TMPDIR` pointed into it:

```sh
MP=$(node scripts/provision-case-sensitive.mjs mount gate)
TMPDIR="$MP/tmp" pnpm check          # build + the full test suite + profile smoke
TMPDIR="$MP/tmp" pnpm smoke:browser  # assembled-browser round trip
TMPDIR="$MP/tmp" pnpm smoke:native   # native provider-driven Attempt
node scripts/provision-case-sensitive.mjs unmount "$MP"
```

On a case-sensitive host the utility simply prints a canonical scratch directory
and `unmount` is a no-op. The acceptance harnesses also self-provision a
case-sensitive base when `TMPDIR` is not already case-sensitive, so on macOS you
can run `pnpm smoke:browser` / `pnpm smoke:native` directly; they mount and
detach their own image.

## 1. Assembled-browser round trip — `pnpm smoke:browser`

`scripts/browser-roundtrip.mjs` boots the real pinned DSH Web profile, seeds one
Mission and Attempt through the Host Remote API (setup only), then drives the
fully assembled graphical application in a real headless Chromium over the Chrome
DevTools Protocol (no browser-automation dependency). The browser is
*discovered*, not guessed: `FORGEYARD_CHROMIUM` first, then any Chromium revision
Playwright has installed (every `ms-playwright` cache root, including
`PLAYWRIGHT_BROWSERS_PATH`, newest revision first, any architecture), then PATH,
then the platform's system Chrome/Chromium. It proves, with screenshots at each
stage:

1. the real pinned DSH Web profile boots;
2. the static Forgeyard client loads inside the assembled application;
3. the Forgeyard sidebar action appears;
4. the Cockpit overlay opens (with exactly one declarative style sheet);
5. a Mission and Attempt can be selected;
6. entering the native Session closes the overlay;
7. `ctx.sessions.open(sessionId)` enters the exact Session (verified by the
   session-header action resolving to the exact Attempt);
8. the Session-header Forgeyard action appears;
9. that action returns to the exact Attempt review.

It adds no route, second React root, DOM manipulation, chat surface, or private
DSH import — it drives only the shipped seams.

## 2. Native provider-driven Attempt — `pnpm smoke:native`

`scripts/native-attempt-acceptance.mjs` runs a real Attempt on a controlled Git
fixture whose task instructs the model to rewrite `answer.txt` to exactly `42`,
verified by a deterministic `node verify.mjs`. It proves:

Mission → Task → Attempt 1 → isolated worktree → native DSH model execution →
actual code change → trusted Git Evidence → trusted verifier Evidence (run under
full DSH confinement) → `PASS` Verification → current approvable review digest →
`RETRY` (Attempt 1 sealed immutable: state `retried`, exactly one `RETRY`
Decision, successor link, unchanged Evidence) → Attempt 2 on a **new Session and
worktree** → native execution → `PASS` → `APPROVE` bound to Attempt 2's exact
digest, with Attempt 1 still immutable afterward and the base checkout unchanged
and clean.

The same harness then carries the Milestone 2 proof: approval leaves the Attempt
eligible but undelivered, an unconfirmed digest is refused, one explicit
promotion writes `refs/forgeyard/promotions/<attemptId>`, the promoted commit is
read straight back out of Git and must hold exactly `answer.txt=42\n` with an
untouched `verify.mjs` on the exact Attempt base commit, repeating the promotion
is refused, and no operator branch moved. See
[the Milestone 2 runbook](milestone-2-acceptance.md).

**Why `RETRY` precedes the terminal `APPROVE`.** Forgeyard's SQLite authority
enforces exactly one terminal Decision per Attempt, and `retry` only accepts a
nonterminal reviewable Attempt (`awaiting_decision` / `interrupted` /
`needs_review`). An `APPROVE`d Attempt is terminal and can never be retried, so
"approve then retry the same Attempt" is impossible by design. The harness
therefore demonstrates the approvable-success path on Attempt 1 (`PASS` +
`canApprove`), the immutable `RETRY` boundary, and the terminal `APPROVE` on the
successful Attempt 2 — every element the milestone requires, in the only order
the authority model permits. (This mirrors the vertical-slice and profile-smoke
Retry chains.)

A verifier exit code is never accepted as success on its own. `verify.mjs` is an
ordinary worktree file the model can edit, so the same trusted Git Evidence must
also show the verification contract untouched (no recorded change to
`verify.mjs`) and `answer.txt` recorded as exactly `42\n` — matched by Git blob
identity against the complete, untruncated recorded diff. A model that rewrote
the verifier to exit 0, or that wrote some other value, is reported as an
`ACCEPTANCE FAILURE`, not a pass.

`PASS` comes only from the Host verifier record, and full confinement is read
from the command Evidence environment facts (`sandbox-enforcement=full`,
`sandbox-workspace` equal to the Attempt worktree, `executed-argv-sha256` present
and not `not-executed`). The harness reads the worktree only to decide when the
model turn has settled, never as the pass signal. When a settled turn made no
edit, the harness reads the public `session.history` `turn/end` reason: a
provider/model error (`kind: 'error'`) is reported as a `MISSING CAPABILITY`
with the exact code/message, while a completed turn that simply failed to make
the change is reported as a genuine `ACCEPTANCE FAILURE`.

### Overrides

- `FORGEYARD_ACCEPT_PROVIDER` / `FORGEYARD_ACCEPT_MODEL` /
  `FORGEYARD_ACCEPT_REASONING` — force a specific model selection instead of the
  profile default (must be a route whose credential is file-based). Both
  harnesses honour these.
- `FORGEYARD_MODEL_DEADLINE_MS` — model-turn budget (default 360000). Must be a
  finite positive number of milliseconds; anything else is rejected at startup
  rather than silently producing an unreachable deadline.
- `FORGEYARD_CHROMIUM` — explicit browser executable for the browser harness.
- `FORGEYARD_CHROMIUM_NO_SANDBOX=1` — opt in to running Chromium without its own
  sandbox, for hosts that cannot start it.

## Interpreting a fail-closed result

| Message | Meaning | Action |
| --- | --- | --- |
| `MISSING CAPABILITY: ... case-insensitive` | managed filesystem is case-insensitive | run under a case-sensitive `TMPDIR` (above) |
| `MISSING CAPABILITY: no Chromium ...` | no browser executable | `npx playwright install chromium` or set `FORGEYARD_CHROMIUM` |
| `MISSING CAPABILITY: ... cannot start Chromium's own sandbox` | host restricts unprivileged user namespaces | allow them, or set `FORGEYARD_CHROMIUM_NO_SANDBOX=1` |
| `MISSING CAPABILITY: no operator DSH ...` | no provider credential | configure a provider through DSH |
| `MISSING CAPABILITY: ... no usable sandbox backend` | sandbox cannot enforce | install/enable the platform sandbox backend |
| `MISSING CAPABILITY: the native model turn errored (turn/end code=...)` | provider route unusable from a spawned DSH process | use a working file-based provider credential (e.g. `DEEPSEEK_API_KEY`) or override `FORGEYARD_ACCEPT_PROVIDER`/`MODEL` |
| `ACCEPTANCE FAILURE: ... without writing answer.txt=42` | the provider ran but the model did not make the change | genuine failure (not an environmental gap); inspect the model/route |
| `ACCEPTANCE FAILURE: ... changed the verifier verify.mjs` | the model altered the verification contract | genuine failure; the PASS is not evidence of the required change |
| `ACCEPTANCE FAILURE: ... records answer.txt as blob ...` | the verifier passed but the recorded content is not `42\n` | genuine failure; the recorded diff is printed with the error |

None of these are treated as success. A green run prints `PASSED` with the exact
approved review digest and both Attempt IDs.
