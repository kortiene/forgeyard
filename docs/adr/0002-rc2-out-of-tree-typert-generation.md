# ADR-0002: Contain the rc.2 out-of-tree Typert generator defect

- Status: Accepted for Milestone 1
- Date: 2026-08-21
- DSH release: `0.1.1-rc.2` (`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`)

## Context

The public Typert generator recognizes `@Remote` only when the symbol's declaration is either a DSH workspace package registration or is nested in an ambient declaration for `@deepseek-ai/dsh-typert-protocol`. In an out-of-tree package, the symbol resolves to the published package declaration, which satisfies neither condition. The generator discovers the Forgeyard Cordis service but silently discovers zero Remote invocations, then rejects the package because it publishes Remote artifacts without Remote methods.

This is direct implementation evidence that rc.2's supported out-of-tree plugin packaging and its public Typert generation path do not compose without a narrow correction.

## Decision

Forgeyard keeps the public runtime APIs (`TypertRemoteService`, `@Remote`, the Typert Host contribution, and generated client Remote) and adds one compile-time-only ambient contract mirror. The mirror makes the rc.2 analyzer recognize the public symbols. Runtime imports continue to resolve to the exact pinned DSH package.

The build invokes `WorkspaceTypertGenerator` explicitly from the repository root because the rc.2 tsdown plugin also mistakes a package-local `tsconfig.host.json` for the workspace root.

Compatibility tests compare the mirror with the installed public declarations, assert generated endpoint names and codecs, and exercise a Remote round trip.

## Upstream contribution

The narrow upstream fix is to let `isTypeMetaSymbol` recognize exports whose resolved module identity is the published `@deepseek-ai/dsh-typert-protocol`, rather than requiring that package to be a project registration. The tsdown plugin should also accept an explicit workspace root (or continue past package-local face configs).

## Consequences and kill criterion

This is a pinned, source-visible build workaround—not a private runtime integration. It must be deleted when DSH exposes a working out-of-tree generator path.

If a DSH patch release changes the public signatures or generated contribution shape such that compatibility tests fail, Forgeyard does not hand-maintain a divergent protocol implementation. Milestone work pauses for the narrow upstream fix; repeated breakage is evidence to revise or abandon the DSH-native approach.
