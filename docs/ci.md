# Continuous integration and acceptance gates

Forgeyard has two distinct classes of gate. Confusing them would let a green
badge imply an assurance nobody actually obtained.

| Gate | Runs in CI | Requires a provider credential | Requires an operator host capability |
| --- | --- | --- | --- |
| `pnpm build` | yes | no | no |
| `pnpm test` (126 tests) | yes | no | no |
| `pnpm smoke:profile` | yes | no | no |
| `pnpm smoke:browser` | **no** | **yes** | a Chromium-family browser |
| `pnpm smoke:native` | **no** | **yes** | a fully enforcing DSH sandbox backend |

The workflow is [`.github/workflows/safety-gate.yml`](../.github/workflows/safety-gate.yml).

## What CI proves

The `safety-gate` workflow runs the single reproducible `pnpm check` gate —
literally the same script an operator runs locally, not a re-spelled
approximation — on both legs of the supported engines range
(`^22.19.0 || >=24.0.0`), installing with `pnpm install --frozen-lockfile` and
the Corepack-activated pinned pnpm (`packageManager: pnpm@11.7.0`).

A green `safety-gate` establishes that, for the exact reviewed commit:

1. **The lockfile is intact and installable.** The lockfile is part of
   Forgeyard's DSH compatibility boundary (see
   [DSH compatibility](dsh-compatibility.md)). `--frozen-lockfile` fails rather
   than silently resolving a different dependency graph, so a PR cannot drift
   the pinned `0.1.1-rc.2` DSH surface without the gate noticing.
2. **The dual-face package builds.** Host types compile, the Typert Host and
   browser Remote artifacts generate, and the static Web client face emits.
3. **The full vitest suite passes** — DSH contract, real-Git authority, and the
   vertical slices through Decision, Retry, and promotion.
4. **The real pinned DSH Web profile boots and serves the assembled
   application**, the Forgeyard Host face loads, the generated Typert Remotes
   answer, and two native Attempts run in distinct Sessions and isolated
   worktrees through trusted Evidence, Verification, `RETRY`, and a terminal
   Decision — with the base checkout proven clean and unmoved and the Host
   schema proven to be exactly the eight expected tables at `user_version = 3`.

This was verified before the workflow was proposed, by reproducing the gate from
a **clean clone** in a hermetic environment with an empty `HOME`, **no**
`.credentials.yaml`, no inherited `DSH_*` variables, and no global Git identity.
It passed on both Node legs. CI therefore does not depend on operator state.

### Why the smoke run is honest either way

`smoke:profile` is not conditional on host luck. It asserts **both** branches of
Forgeyard's fail-closed contract:

- **With** a usable DSH sandbox backend, Attempt 2's verifier reaches `PASS`,
  the exact digest is approved, and one explicit local promotion produces a
  durable `refs/forgeyard/promotions/<attemptId>` ref whose tree is re-verified
  against the declared projection from the operator's own repository.
- **Without** one, the verifier is never run unconfined: both Attempts record
  `ERROR`, approval is proven *blocked*, promotion is proven *blocked*, and the
  Attempt is rejected.

Either outcome is a real assertion about product behavior. A failure of this
job is therefore a product defect, not an unavailable host capability. No
fail-closed test is weakened and no sandbox requirement is disabled to make CI
green.

## What CI does not prove

### `smoke:native` cannot be a credential-free required check

`scripts/native-attempt-acceptance.mjs` is the provider-driven acceptance
harness. Its entire purpose is to prove that a **real model**, routed through a
**real configured provider**, executing in a **fully enforcing DSH sandbox**,
produces the promised bytes and cannot manufacture a pass by rewriting the
verifier. It fails closed with an explicit `MISSING CAPABILITY` when no operator
credential is present:

    if (!home.hasCredentials) throw new Error('MISSING CAPABILITY: ...')

It cannot become a required CI check, for three independent reasons:

1. **It requires a secret by construction.** A required check that needs a
   provider credential cannot run on a fork PR, so it would either be skipped
   exactly when review matters most, or it would leak a credential to untrusted
   code. Storing a provider key in repository secrets to satisfy a badge would
   trade real supply-chain risk for a cosmetic guarantee.
2. **Its result is not a pure function of the commit.** Model output, provider
   routing, quota, latency, and model availability all vary independently of
   Forgeyard's source. A red run would frequently mean "the route was
   unavailable", not "this change is defective" — which trains reviewers to
   ignore the signal.
3. **It requires `enforcement: 'full'` from a real sandbox backend**, which is a
   host property, not a repository property.

Making it required would mean either weakening it into dishonesty or accepting a
flaky gate. Forgeyard keeps it as an explicit **operator acceptance gate** and
CI does not claim it ran.

### `smoke:browser` is deliberately excluded

It was evaluated for a separate CI job and rejected. Chromium itself could be
provisioned on a GitHub runner, but the harness **also** hard-requires an
operator provider credential before it will boot, for the same reason as
`smoke:native`:

    const home = await prepareOperatorDshHome(workspace.base)
    if (!home.hasCredentials) throw new Error('MISSING CAPABILITY: ...')

`startAttempt` must bind a **real native DSH Session** before the graphical
round trip has anything to open, so the credential is not incidental. On a
credential-free runner this job could only ever report `MISSING CAPABILITY`,
which is not a product signal.

The valuable part of that round trip is already covered credential-free in CI:
`tests/dsh-contract/client-bundle-render.test.tsx` executes the **emitted
browser bundle** in a browser DOM, mounts its three slot contributions, opens
the Cockpit, invokes `ctx.sessions.open(id)`, and returns through the
Session-header action to the exact Attempt. `smoke:browser` adds real-Chromium
assembly confidence on top of that, and remains a manual gate.

Adding a job that can only be skipped or can fail for reasons unrelated to the
change would violate requirement 6 of the safety gate: CI must not pretend the
provider-driven native smoke ran when it did not.

## Operator / manual acceptance gates

Run these on a configured operator host before accepting a milestone:

```sh
pnpm smoke:browser   # assembled-Chromium Cockpit -> Session -> Attempt round trip
pnpm smoke:native    # provider-driven native Attempt with full sandbox enforcement
```

See the [Milestone 1](milestone-1-acceptance.md) and
[Milestone 2](milestone-2-acceptance.md) acceptance runbooks for the
case-sensitive filesystem requirement, provider overrides, evidence assertions,
and fail-closed interpretation.

## A note on the profile bundle link

`profiles/local` is intentionally **outside** the pnpm workspace, and
`profiles/local/node_modules/` is gitignored. The root
`pnpm install --frozen-lockfile` therefore does **not** create the `forgeyard`
bundle link the pinned profile needs, and a fresh checkout cannot boot the
profile without it:

    dsh: cannot resolve profile bundle "forgeyard" ...

CI runs the documented provisioning step explicitly:

```sh
pnpm --dir profiles/local install --ignore-workspace --no-lockfile
```

This provisions the checkout. It is not a change to application behavior.

## Branch protection

This workflow does **not** configure branch protection. Requiring
`safety-gate` on `main` is a repository-settings decision that is left to the
maintainer and must be made explicitly.
