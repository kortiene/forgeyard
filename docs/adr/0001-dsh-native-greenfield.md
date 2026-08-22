# ADR-0001: DSH-native greenfield

- Status: Accepted
- Date: 2026-08-21

## Decision

Forgeyard is a new greenfield DeepSeek Harness-native project.

Milestone 1 is a single-machine modular monolith loaded as one static,
out-of-tree, dual-face plugin in one DeepSeek Harness Web profile.

## Why

The architecture is fundamentally different from the previous standalone
Switchyard orchestration architecture.

Starting fresh avoids carrying obsolete abstractions and compatibility
constraints into the DSH-native design.

## What it replaces

The original Switchyard implementation is retained only as reference material
and an archive of ideas. It is not an implementation base, migration source, or
compatibility target.

## Consequences

Forgeyard is free to adopt DSH-native concepts, data models, plugin
architecture, UI extension mechanisms, and execution semantics without
maintaining backward compatibility.

Milestone 1 contains no fleet, worker protocol, broker, external coordinator
database, remote Session federation, GitHub integration, delivery automation,
or second conversation UI. Those capabilities remain deferred unless evidence
from the local product invalidates this decision.
