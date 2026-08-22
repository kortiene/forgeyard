# ADR-0003: Fence the complete DSH-owned execution tree

- Status: Accepted for Milestone 1
- Date: 2026-08-21
- DSH release: `0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`)

## Context

Direct implementation review disproved the assumption that parent `Agent.runMaintenance()` alone establishes worktree quiescence. The standard DSH preset exposes continuable subagents and owner-scoped background Jobs. A parent can be idle while a child Agent, one-shot delegation, workflow, or background command still has authority to mutate the same Attempt worktree.

This would let DSH-owned execution race trusted Evidence, Verification, the review digest, or a terminal Decision.

## Decision

Forgeyard continues to use the native standard preset, but every trusted review boundary now claims the exact parent Agent's public maintenance phase and then:

1. calls `ctx.subagents.drainContinuableDescendants([agent])`;
2. lists all `ctx.jobs` records owned by that exact Agent;
3. kills live Jobs and waits for terminal settlement with the maintenance cancellation signal;
4. runs verifier commands;
5. collects Git/raw-workspace Evidence last, from the final reviewed state.

A terminal boundary cancels and drains the parent before maintenance, then repeats parent cancellation, maintenance reclamation, descendant draining, and Job draining after the transaction. This covers queued parent input that wins the narrow release-to-cancel window.

## Consequences

The first drain closes continuable-child admission below that exact live parent for the rest of its activation. This is compatible with the Attempt audit boundary: work after review belongs in a Retry Session, not a reopened execution authority.

One-shot/background work created through the standard DSH tools is owned by `ctx.jobs`; continuable children are owned by `ctx.subagents`, and their teardown releases their own owned resources. Unrelated host processes, unowned external processes, and privileged local actors remain outside this same-world boundary and are documented security limitations.

The Host now directly pins and contract-tests the public `@deepseek-ai/dsh-subagent` and `@deepseek-ai/dsh-jobs` seams.

## Kill criterion

If a supported DSH preset gains worktree-mutating execution that can outlive both the parent maintenance phase and these public descendant/Job ownership seams, Forgeyard must either use a dedicated preset that excludes that capability or pause for a narrow upstream complete-tree maintenance API. It must not infer quiescence or inspect private DSH internals.
