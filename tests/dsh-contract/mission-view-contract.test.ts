import { describe, expect, it } from 'vitest'
import { missionRollupState } from '../../packages/forgeyard/src/host/engine.ts'
import type {
  AttemptState,
  MissionRollupState,
  TaskNodeView,
  TaskReadinessStatus,
} from '../../packages/forgeyard/src/types.ts'

let sequence = 0

function node(
  nodeState: AttemptState | 'ready',
  readiness: TaskReadinessStatus = 'ready',
  startable = false,
): TaskNodeView {
  const index = ++sequence
  return {
    task: {
      id: `task-${index}`,
      missionId: 'mission-1',
      sourceNodeKey: `node-${index}`,
      specification: {
        title: `Node ${index}`,
        objective: 'Exercise the deterministic Mission rollup.',
        instruction: 'No execution is required for this pure contract test.',
        verification: [],
      },
      dependencies: [],
      createdAt: index,
    },
    attempts: [],
    readiness: {
      status: readiness,
      startable,
      reason: readiness === 'ready' ? null : `Node is ${readiness}.`,
      blockedBy: [],
      baseCommit: null,
      baseFromAttemptId: null,
    },
    nodeState,
  }
}

describe('MissionView rollup contract', () => {
  it.each<[string, TaskNodeView[], MissionRollupState]>([
    ['normalizes every active admission phase to running', [node('preparing')], 'running'],
    ['normalizes worktree-ready admission to running', [node('worktree_ready')], 'running'],
    ['normalizes session-bound admission to running', [node('session_bound')], 'running'],
    ['keeps verifying active', [node('verifying')], 'running'],
    ['surfaces a Decision waiting anywhere', [node('approved'), node('awaiting_decision')], 'awaiting_decision'],
    ['surfaces interrupted review work', [node('approved'), node('interrupted')], 'needs_review'],
    ['surfaces a dead dependency branch', [node('approved'), node('ready', 'dead')], 'dead'],
    ['normalizes terminal rejection to stopped', [node('rejected')], 'stopped'],
    ['normalizes terminal cancellation to stopped', [node('cancelled')], 'stopped'],
    ['reports complete only when every approved node has valid readiness', [node('approved'), node('approved')], 'complete'],
    ['reports blocked when approved nodes no longer have valid upstream output', [node('approved', 'blocked'), node('approved')], 'blocked'],
    ['reports a dependency-ready node as ready to start', [node('approved'), node('ready', 'ready', true)], 'ready'],
    ['reports blocked when no node is startable', [node('approved'), node('ready', 'blocked')], 'blocked'],
  ])('%s', (_label, nodes, expected) => {
    expect(missionRollupState(nodes)).toBe(expected)
  })

  it('uses a total first-match-wins precedence for mixed states', () => {
    expect(missionRollupState([
      node('running'),
      node('awaiting_decision'),
      node('needs_review'),
      node('rejected', 'dead'),
    ])).toBe('running')
    expect(missionRollupState([
      node('awaiting_decision'),
      node('needs_review'),
      node('rejected', 'dead'),
    ])).toBe('awaiting_decision')
    expect(missionRollupState([
      node('needs_review'),
      node('rejected', 'dead'),
    ])).toBe('needs_review')
    expect(missionRollupState([
      node('rejected', 'dead'),
      node('cancelled'),
    ])).toBe('dead')
  })

  it('pins the Milestone 3 mixed state: promoted A plus startable B is ready, not complete', () => {
    // Promotion is not a separate Attempt state: A remains approved after its
    // output ref is created. B carries the admission signal that makes the
    // Mission ready for its next serial step.
    expect(missionRollupState([
      node('approved', 'ready', false),
      node('ready', 'ready', true),
    ])).toBe('ready')
  })
})
