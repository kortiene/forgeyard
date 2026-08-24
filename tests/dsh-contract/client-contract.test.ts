import { Context } from '@deepseek-ai/cordis'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import type {
  AttemptRecord,
  AttemptSessionRef,
  AttemptView,
  ForgeyardSnapshot,
  MissionRecord,
  MissionView,
  TaskRecord,
} from '../../packages/forgeyard/src/types.ts'
import {
  ForgeyardCockpitController,
  type ForgeyardClientApi,
  type ForgeyardSessions,
} from '../../packages/forgeyard/src/client/controller.ts'
import {
  FORGEYARD_SLOT_ENTRIES,
  registerForgeyardCockpit,
} from '../../packages/forgeyard/src/client/registration.ts'

const SlotRegistry = await loadSlotRegistry()

describe('Forgeyard DSH client contracts', () => {
  it('uses the exact three public seam names and removes every entry with its fiber', async () => {
    const data = forgeyardSnapshot([
      attempt('attempt-a', 'session-a', 1),
      attempt('attempt-b', 'session-b', 2),
    ])
    const { sessions } = sessionsDouble(['session-a', 'session-b'])
    const controller = new ForgeyardCockpitController(apiDouble(data), sessions)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const owner = mountSlotOwner(ctx)
    await owner.await()

    const fiber = ctx.plugin({
      inject: ['slots'],
      apply(clientCtx) {
        registerForgeyardCockpit(clientCtx as ClientContext, controller)
      },
    })
    await fiber.await()

    expect(FORGEYARD_SLOT_ENTRIES).toEqual({
      footer: { name: 'sidebar.footer.action', id: 'forgeyard', order: 30 },
      overlay: { name: 'shell.overlay', id: 'forgeyard-overlay', order: 30 },
      returnAction: {
        name: 'conversation.session.header.actions',
        id: 'forgeyard-return',
        order: 30,
      },
    })
    expect(entryIds(ctx, 'sidebar.footer.action')).toEqual(['forgeyard'])
    expect(entryIds(ctx, 'shell.overlay')).toEqual(['forgeyard-overlay'])
    expect(entryIds(ctx, 'conversation.session.header.actions')).toEqual(['forgeyard-return'])

    const header = ctx.slots.entries('conversation.session.header.actions')[0]
    const face = header?.inject?.('session-b' as never) as Record<string, unknown> | undefined
    expect(face?.cockpit).toBe(controller)
    expect(face?.returnToAttempt).toBeTypeOf('function')

    await fiber.dispose()
    expect(entryIds(ctx, 'sidebar.footer.action')).toEqual([])
    expect(entryIds(ctx, 'shell.overlay')).toEqual([])
    expect(entryIds(ctx, 'conversation.session.header.actions')).toEqual([])

    controller.dispose()
    await owner.dispose()
  })

  it('waits for owner declarations, collapses with them, and returns on redeclaration', async () => {
    const { sessions } = sessionsDouble([])
    const controller = new ForgeyardCockpitController(apiDouble(forgeyardSnapshot([])), sessions)
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const fiber = ctx.plugin({
      inject: ['slots'],
      apply(clientCtx) {
        registerForgeyardCockpit(clientCtx as ClientContext, controller)
      },
    })
    await fiber.await()

    expect(entryIds(ctx, 'sidebar.footer.action')).toEqual([])
    const firstOwner = mountSlotOwner(ctx)
    await firstOwner.await()
    expect(entryIds(ctx, 'sidebar.footer.action')).toEqual(['forgeyard'])
    expect(entryIds(ctx, 'shell.overlay')).toEqual(['forgeyard-overlay'])
    expect(entryIds(ctx, 'conversation.session.header.actions')).toEqual(['forgeyard-return'])

    await firstOwner.dispose()
    expect(entryIds(ctx, 'sidebar.footer.action')).toEqual([])
    expect(entryIds(ctx, 'shell.overlay')).toEqual([])
    expect(entryIds(ctx, 'conversation.session.header.actions')).toEqual([])

    const secondOwner = mountSlotOwner(ctx)
    await secondOwner.await()
    expect(entryIds(ctx, 'sidebar.footer.action')).toEqual(['forgeyard'])
    expect(entryIds(ctx, 'shell.overlay')).toEqual(['forgeyard-overlay'])
    expect(entryIds(ctx, 'conversation.session.header.actions')).toEqual(['forgeyard-return'])

    await fiber.dispose()
    expect(entryIds(ctx, 'sidebar.footer.action')).toEqual([])
    expect(entryIds(ctx, 'shell.overlay')).toEqual([])
    expect(entryIds(ctx, 'conversation.session.header.actions')).toEqual([])
    controller.dispose()
    await secondOwner.dispose()
  })

  it('closes the overlay before calling the native sessions.open seam', async () => {
    const attemptA = attempt('attempt-a', 'session-a', 1)
    const data = forgeyardSnapshot([attemptA])
    const operations: string[] = []
    let controller: ForgeyardCockpitController
    const { sessions, open } = sessionsDouble(['session-a'], (id) => {
      operations.push(`sessions.open:${id}:overlay=${String(controller.getSnapshot().open)}`)
    })
    controller = new ForgeyardCockpitController(apiDouble(data), sessions)
    await controller.refresh()
    controller.open()
    let wasOpen = controller.getSnapshot().open
    const unsubscribe = controller.subscribe(() => {
      const isOpen = controller.getSnapshot().open
      if (wasOpen && !isOpen) operations.push('close')
      wasOpen = isOpen
    })

    controller.openSession(attemptA)

    expect(operations).toEqual([
      'close',
      'sessions.open:session-a:overlay=false',
    ])
    expect(open).toHaveBeenCalledWith('session-a')
    unsubscribe()
    controller.dispose()
  })

  it('returns each native Session to its exact Attempt and never guesses an ambiguous mapping', async () => {
    const attemptA = attempt('attempt-a', 'session-a', 1)
    const attemptB = attempt('attempt-b', 'session-b', 2)
    const exactApi = apiDouble(forgeyardSnapshot([attemptA, attemptB]))
    const { sessions } = sessionsDouble(['session-a', 'session-b'])
    const controller = new ForgeyardCockpitController(exactApi, sessions)
    await controller.refresh()

    expect(controller.attemptIdForSession('session-a')).toBe('attempt-a')
    expect(controller.attemptIdForSession('session-b')).toBe('attempt-b')
    await controller.returnToAttempt('session-b')
    expect(controller.getSnapshot()).toMatchObject({
      open: true,
      view: { name: 'attempt', missionId: 'mission-1', attemptId: 'attempt-b' },
    })

    controller.dispose()

    const ambiguousApi = apiDouble(forgeyardSnapshot([
      attempt('attempt-a', 'shared-session', 1),
      attempt('attempt-b', 'shared-session', 2),
    ]))
    const ambiguous = new ForgeyardCockpitController(ambiguousApi, sessionsDouble(['shared-session']).sessions)
    await ambiguous.refresh()
    expect(ambiguous.attemptIdForSession('shared-session')).toBeUndefined()
    await ambiguous.returnToAttempt('shared-session')
    expect(ambiguous.getSnapshot().open).toBe(false)
    expect(ambiguousApi.attemptForSession).not.toHaveBeenCalled()
    ambiguous.dispose()
  })

  it('rehydrates an absent session mapping through the generated Remote contract', async () => {
    const attemptA = attempt('attempt-a', '', 1)
    const data = forgeyardSnapshot([attemptA])
    const api = apiDouble(data, {
      attemptId: 'attempt-a',
      taskId: 'task-1',
      missionId: 'mission-1',
      ordinal: 1,
    })
    const controller = new ForgeyardCockpitController(api, sessionsDouble(['session-a']).sessions)
    await controller.refresh()
    await controller.returnToAttempt('session-a')

    expect(api.attemptForSession).toHaveBeenCalledWith('session-a')
    expect(controller.getSnapshot()).toMatchObject({
      open: true,
      view: { name: 'attempt', missionId: 'mission-1', attemptId: 'attempt-a' },
      sessionAttempts: { 'session-a': 'attempt-a' },
    })
    controller.dispose()
  })

  it('keeps an exact header lookup when a snapshot refresh completes concurrently', async () => {
    const data = forgeyardSnapshot([attempt('attempt-a', '', 1)])
    let resolveLookup: ((value: AttemptSessionRef | null) => void) | undefined
    const attemptForSession = vi.fn<ForgeyardClientApi['attemptForSession']>(() =>
      new Promise((resolve) => { resolveLookup = resolve }),
    )
    const api: ForgeyardClientApi = { ...apiDouble(data), attemptForSession }
    const controller = new ForgeyardCockpitController(api, sessionsDouble(['session-a']).sessions)

    const lookup = controller.ensureAttemptForSession('session-a')
    await controller.refresh()
    resolveLookup?.({
      attemptId: 'attempt-a',
      taskId: 'task-1',
      missionId: 'mission-1',
      ordinal: 1,
    })

    await expect(lookup).resolves.toBe('attempt-a')
    expect(controller.attemptIdForSession('session-a')).toBe('attempt-a')
    controller.dispose()
  })
})

function mountSlotOwner(ctx: Context): ReturnType<Context['plugin']> {
  return ctx.plugin({
    inject: ['slots'],
    apply(ownerCtx) {
      ownerCtx.slots.register({
        name: 'root',
        children: {
          'sidebar.footer.action': { kind: 'list', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
          'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        },
      } as never, (() => null) as never)
    },
  })
}

function entryIds(ctx: Context, name: string): (string | undefined)[] {
  return ctx.slots.entries(name as never).map(entry => entry.options.id)
}

function sessionsDouble(
  ids: string[],
  onOpen: (id: SessionId) => void = () => {},
): { readonly sessions: ForgeyardSessions; readonly open: ReturnType<typeof vi.fn> } {
  const listeners = new Set<() => void>()
  const byId = Object.fromEntries(ids.map(id => [id, { id }]))
  const open = vi.fn((id: SessionId) => { onOpen(id) })
  const sessions = {
    list: {
      getSnapshot: () => ({ ids, byId }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    open,
  } as unknown as ForgeyardSessions
  return { sessions, open }
}

function apiDouble(
  data: ForgeyardSnapshot,
  sessionRef: AttemptSessionRef | null = null,
): ForgeyardClientApi & {
  readonly attemptForSession: ReturnType<typeof vi.fn<ForgeyardClientApi['attemptForSession']>>
} {
  const mission = data.missions[0] ?? forgeyardSnapshot([]).missions[0]
  const firstAttempt = mission?.attempts[0]
  const attemptForSession = vi.fn<ForgeyardClientApi['attemptForSession']>(async () => sessionRef)
  return {
    snapshot: vi.fn(async () => data),
    createMission: vi.fn(async () => required(mission, 'mission fixture')),
    startAttempt: vi.fn(async () => required(firstAttempt, 'attempt fixture')),
    verifyAttempt: vi.fn(async () => required(firstAttempt, 'attempt fixture')),
    decide: vi.fn(async () => required(firstAttempt, 'attempt fixture')),
    retry: vi.fn(async () => required(firstAttempt, 'attempt fixture')),
    promote: vi.fn(async () => required(firstAttempt, 'attempt fixture')),
    attemptForSession,
  }
}

function forgeyardSnapshot(attempts: AttemptView[]): ForgeyardSnapshot {
  const mission: MissionRecord = {
    id: 'mission-1',
    title: 'Ship Forgeyard',
    objective: 'Build a controlled engineering cockpit.',
    repository: {
      path: '/repo', baseRef: 'main', checkoutHead: 'a'.repeat(40), checkoutStatusHash: '0'.repeat(64),
      gitDir: '/repo/.git', gitCommonDir: '/repo/.git',
      pathDevice: '1', pathInode: '2', gitDirDevice: '1', gitDirInode: '3',
      gitCommonDirDevice: '1', gitCommonDirInode: '3', ownerUid: '1000',
    },
    baseRef: 'main',
    defaultPolicy: {
      provider: 'fixture',
      model: 'fixture-model',
      reasoningEffort: null,
      agentPreset: null,
      permissionPreset: 'default',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'granular',
      toolPolicy: 'native',
    },
    pipe: { nodes: [] },
    pipeHash: 'pipe-hash',
    createdAt: 1,
  }
  const task: TaskRecord = {
    id: 'task-1',
    missionId: mission.id,
    sourceNodeKey: 'task',
    specification: {
      title: 'Implement',
      objective: mission.objective,
      instruction: 'Implement Forgeyard.',
      verification: [],
    },
    dependencies: [],
    createdAt: 1,
  }
  const missionView: MissionView = {
    mission,
    task,
    attempts,
    derivedState: attempts[attempts.length - 1]?.attempt.state ?? 'planned',
  }
  return { schemaVersion: 1, dshVersion: '0.1.1-rc.2', missions: [missionView] }
}

function attempt(id: string, sessionId: string, ordinal: number): AttemptView {
  const record: AttemptRecord = {
    id,
    taskId: 'task-1',
    ordinal,
    executionSnapshot: {
      version: 1,
      attemptId: id,
      ordinal,
      task: {
        title: 'Implement',
        objective: 'Build Forgeyard.',
        instruction: 'Implement Forgeyard.',
        verification: [],
      },
      repository: {
        path: '/repo', baseRef: 'main', checkoutHead: 'a'.repeat(40), checkoutStatusHash: '0'.repeat(64),
        gitDir: '/repo/.git', gitCommonDir: '/repo/.git',
        pathDevice: '1', pathInode: '2', gitDirDevice: '1', gitDirInode: '3',
        gitCommonDirDevice: '1', gitCommonDirInode: '3', ownerUid: '1000',
      },
      baseCommit: 'a'.repeat(40),
      policy: {
        provider: 'fixture',
        model: 'fixture-model',
        reasoningEffort: null,
        agentPreset: null,
        permissionPreset: 'default',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'granular',
        toolPolicy: 'native',
      },
      verification: [],
      createdAt: 1,
    },
    executionSnapshotHash: 'snapshot-hash',
    baseCommit: 'a'.repeat(40),
    worktreePath: `/worktrees/${id}`,
    worktreeDevice: '1',
    worktreeInode: '4',
    dshSessionId: sessionId,
    state: 'awaiting_decision',
    startedAt: 1,
    endedAt: null,
    gitFingerprint: 'fingerprint',
    terminalReason: null,
    createdAt: 1,
    updatedAt: ordinal,
  }
  return {
    attempt: record,
    evidence: [],
    verifications: [],
    decisions: [],
    review: {
      reviewDigest: `review-${id}`,
      liveGitFingerprint: 'fingerprint',
      latestRunId: null,
      requiredVerificationCount: 0,
      passingVerificationCount: 0,
      canApprove: true,
      reviewedStateCurrent: true,
      approvalStale: false,
      reason: null,
    },
    promotions: [],
    promotion: {
      status: 'blocked',
      eligible: false,
      reason: 'Only an Attempt with a terminal APPROVE Decision can be promoted; this Attempt is awaiting_decision.',
      reviewDigest: null,
      decisionId: null,
      plannedRef: null,
      promotionId: null,
      outputRef: null,
      outputCommit: null,
      failureReason: null,
    },
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`)
  return value
}

/** Materialize the published lazy-CJS runtime exactly as the DSH module table does. */
async function loadSlotRegistry(): Promise<new (ctx: Context) => object> {
  const cordis = await import('@deepseek-ai/cordis')
  const slots = await import('@deepseek-ai/dsh-client-ui-slots')
  let clientExports: Record<string, unknown> | undefined
  const moduleWindow = {
    __ModuleLoader__: {
      load(registration: {
        readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
      }) {
        clientExports = registration.factory((id) => {
          if (id === '@deepseek-ai/cordis') return cordis
          if (id === '@deepseek-ai/dsh-client-ui-slots') return slots
          throw new Error(`Unexpected runtime external ${id}`)
        })
      },
    },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: moduleWindow })
  try {
    await import('@deepseek-ai/dsh-client-runtime/client')
  } finally {
    Reflect.deleteProperty(globalThis, 'window')
  }
  const registry = clientExports?.SlotRegistry
  if (typeof registry !== 'function') throw new Error('Published client runtime did not export SlotRegistry')
  return registry as new (ctx: Context) => object
}
