// @vitest-environment jsdom

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import React, { act, useSyncExternalStore, type ComponentType } from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type {
  AttemptView,
  ForgeyardSnapshot,
  PromotionEligibility,
  PromotionProjection,
  PromotionRecord,
} from '../../packages/forgeyard/src/types.ts'

interface SlotEntry {
  options: {
    name: string
    inject?: (...args: unknown[]) => Record<string, unknown>
  }
  component: ComponentType<Record<string, unknown>>
}

interface BrowserFace {
  apply(ctx: Record<string, unknown>): Promise<void>
}

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('built Forgeyard browser face', () => {
  it('executes the emitted bundle and renders the exact Cockpit → Session → Attempt round trip', async () => {
    const client = await executeBuiltClientFace()
    const entries = new Map<string, SlotEntry>()
    const cleanups: Array<() => void> = []
    const opened = vi.fn()
    const data = snapshotFixture()
    const result = <T,>(value: T) => Promise.resolve({ ok: true, value: { ok: true, value } })
    const ctx = {
      remote: {
        $mount: vi.fn(async () => undefined),
        forgeyard: {
          snapshot: vi.fn(() => result(data)),
          createMission: vi.fn(), startAttempt: vi.fn(), verifyAttempt: vi.fn(), decide: vi.fn(), retry: vi.fn(),
          attemptForSession: vi.fn(() => result({
            attemptId: 'attempt-1', taskId: 'task-1', missionId: 'mission-1', ordinal: 1,
          })),
        },
      },
      sessions: {
        list: {
          getSnapshot: () => ({ ids: ['session-1'], byId: { 'session-1': { id: 'session-1' } } }),
          subscribe: () => () => undefined,
        },
        open: opened,
      },
      effect: (install: () => (() => void)) => { cleanups.push(install()) },
      plugin: (definition: { apply: (scope: unknown) => void | Promise<void> }) => {
        // Model DSH's child-fiber apply: the emitted bundle mounts its Remote,
        // then contributes the Cockpit from a nested plugin that injects
        // `remote.forgeyard`. In the assembled runtime that guard is what makes
        // `ctx.remote.forgeyard` resolvable; here the child shares the same fake
        // services, so applying it against this ctx exercises the same path.
        void definition.apply(ctx)
      },
      slots: {
        inject: (_name: string, install: () => void) => { install() },
        register: (options: SlotEntry['options'], component: SlotEntry['component']) => {
          entries.set(options.name, { options, component })
          return () => { entries.delete(options.name) }
        },
      },
    }

    await act(async () => { await client.apply(ctx as never) })
    expect([...entries.keys()].sort()).toEqual([
      'conversation.session.header.actions', 'shell.overlay', 'sidebar.footer.action',
    ])

    const footer = await mount(<Slot entry={required(entries, 'sidebar.footer.action')} runtime={{ wide: true }} />)
    const overlay = await mount(<Slot entry={required(entries, 'shell.overlay')} />)
    const openCockpit = await waitForElement(() => namedButton(footer.container, /Open Forgeyard/u))
    expect(openCockpit.disabled).toBe(false)
    await click(openCockpit)
    await waitForElement(() => overlay.container.querySelector('[role="dialog"][aria-label="Forgeyard Cockpit"]'))
    expect(overlay.container.querySelectorAll('style[data-plugin-css="forgeyard/client"]')).toHaveLength(1)

    await click(requiredElement(namedButton(overlay.container, /Browser mission/u), 'mission button'))
    expect(heading(overlay.container, 'Task nodes')).not.toBeNull()
    expect(overlay.container.querySelector('article[aria-label="Task node implement"]')).not.toBeNull()
    expect(overlay.container.textContent).toContain('Readiness Ready')
    expect(overlay.container.textContent).toContain('Attempt Awaiting Decision')
    await click(requiredElement(overlay.container.querySelector<HTMLButtonElement>('[role="row"]'), 'attempt row'))
    expect(heading(overlay.container, 'Attempt review')).not.toBeNull()
    await click(requiredElement(namedButton(overlay.container, /Open Session/u), 'session button'))
    expect(opened).toHaveBeenCalledWith('session-1')
    expect(overlay.container.querySelector('[role="dialog"][aria-label="Forgeyard Cockpit"]')).toBeNull()

    const header = await mount(<Slot
      entry={required(entries, 'conversation.session.header.actions')}
      scope={['session-1']}
      runtime={{ sessionId: 'session-1' }}
    />)
    await click(await waitForElement(() => header.container.querySelector<HTMLButtonElement>(
      'button[title="Return to Forgeyard attempt attempt-1"]',
    )))
    await waitForElement(() => overlay.container.querySelector('[role="dialog"][aria-label="Forgeyard Cockpit"]'))
    expect(heading(overlay.container, 'Attempt review')).not.toBeNull()
    expect(overlay.container.textContent).toContain('/tmp/forgeyard-attempt-1')

    await header.unmount()
    await overlay.unmount()
    await footer.unmount()
    for (const cleanup of cleanups.reverse()) cleanup()
  })

  it('submits one explicit dependency-free root when no follow-up is requested', async () => {
    const client = await executeBuiltClientFace()
    const entries = new Map<string, SlotEntry>()
    const cleanups: Array<() => void> = []
    const data = snapshotFixture()
    const result = <T,>(value: T) => Promise.resolve({ ok: true, value: { ok: true, value } })
    const createMission = vi.fn(() => result(data.missions[0]))
    const ctx = fakeClientContext(entries, cleanups, data, result, { createMission })

    await act(async () => { await client.apply(ctx as never) })
    const footer = await mount(<Slot entry={required(entries, 'sidebar.footer.action')} runtime={{ wide: true }} />)
    const overlay = await mount(<Slot entry={required(entries, 'shell.overlay')} />)
    await click(await waitForElement(() => namedButton(footer.container, /Open Forgeyard/u)))
    await click(requiredElement(namedButton(overlay.container, /New mission/u), 'new Mission button'))
    await type(requiredField(overlay.container, 'Title'), 'Root Mission')
    await type(requiredField(overlay.container, 'Objective'), 'Create one root node.')
    await type(requiredField(overlay.container, 'Repository'), '/tmp/repository')
    await type(requiredField(overlay.container, 'Base ref'), 'main')
    await type(requiredField(overlay.container, 'Root verify'), 'node verify.mjs')
    await type(requiredField(overlay.container, 'Root node · implement'), 'Implement the root.')

    const form = requiredElement(overlay.container.querySelector<HTMLFormElement>('form.fy-form'), 'Mission form')
    await act(async () => { form.requestSubmit() })
    await waitFor(() => createMission.mock.calls.length === 1)
    expect(createMission.mock.calls[0]?.[0].nodes).toEqual([{
      key: 'implement',
      task: 'Implement the root.',
      verificationCommand: 'node verify.mjs',
      dependsOn: [],
    }])

    await overlay.unmount()
    await footer.unmount()
    for (const cleanup of cleanups.reverse()) cleanup()
  })

  it('submits one explicit root plus one optional serial follow-up from the Cockpit', async () => {
    const client = await executeBuiltClientFace()
    const entries = new Map<string, SlotEntry>()
    const cleanups: Array<() => void> = []
    const data = snapshotFixture()
    const result = <T,>(value: T) => Promise.resolve({ ok: true, value: { ok: true, value } })
    const createMission = vi.fn(() => result(data.missions[0]))
    const ctx = fakeClientContext(entries, cleanups, data, result, { createMission })

    await act(async () => { await client.apply(ctx as never) })
    const footer = await mount(<Slot entry={required(entries, 'sidebar.footer.action')} runtime={{ wide: true }} />)
    const overlay = await mount(<Slot entry={required(entries, 'shell.overlay')} />)
    await click(await waitForElement(() => namedButton(footer.container, /Open Forgeyard/u)))
    await waitForElement(() => overlay.container.querySelector('[role="dialog"]'))
    await click(requiredElement(namedButton(overlay.container, /New mission/u), 'new Mission button'))

    await type(requiredField(overlay.container, 'Title'), 'Serial Mission')
    await type(requiredField(overlay.container, 'Objective'), 'Prove explicit serial Pipe creation.')
    await type(requiredField(overlay.container, 'Repository'), '/tmp/repository')
    await type(requiredField(overlay.container, 'Base ref'), 'main')
    await type(requiredField(overlay.container, 'Root verify'), 'node verify-a.mjs')
    await type(requiredField(overlay.container, 'Root node · implement'), 'Implement A.')
    await click(requiredElement(namedButton(overlay.container, /Add serial follow-up node/u), 'follow-up toggle'))
    await type(requiredField(overlay.container, 'Follow-up node · follows implement'), 'Implement B.')
    await type(requiredField(overlay.container, 'Follow-up verify'), 'node verify-b.mjs')

    const form = requiredElement(overlay.container.querySelector<HTMLFormElement>('form.fy-form'), 'Mission form')
    await act(async () => { form.requestSubmit() })
    await waitFor(() => createMission.mock.calls.length === 1)
    expect(createMission).toHaveBeenCalledWith({
      title: 'Serial Mission',
      objective: 'Prove explicit serial Pipe creation.',
      repositoryPath: '/tmp/repository',
      baseRef: 'main',
      nodes: [
        {
          key: 'implement',
          task: 'Implement A.',
          verificationCommand: 'node verify-a.mjs',
          dependsOn: [],
        },
        {
          key: 'follow-up',
          task: 'Implement B.',
          verificationCommand: 'node verify-b.mjs',
          dependsOn: ['implement'],
        },
      ],
      provider: null,
      model: null,
      reasoningEffort: null,
      agentPreset: null,
      permissionPreset: null,
    })

    await overlay.unmount()
    await footer.unmount()
    for (const cleanup of cleanups.reverse()) cleanup()
  })

  it('renders promotion eligibility, requires explicit confirmation, and shows the durable result', async () => {
    const client = await executeBuiltClientFace()
    const entries = new Map<string, SlotEntry>()
    const cleanups: Array<() => void> = []
    const digest = '9'.repeat(64)
    const promote = vi.fn()
    const eligible = snapshotFixture()
    const attemptView = approveMissionFixture(eligible)
    attemptView.decisions = [{
      id: 'decision-1', attemptId: 'attempt-1', type: 'APPROVE', reviewDigest: digest,
      actor: 'operator', rationale: 'Trusted verification passed.', createdAt: 1,
    }]
    attemptView.promotion = {
      status: 'eligible', eligible: true, reason: null, reviewDigest: digest, decisionId: 'decision-1',
      plannedRef: 'refs/forgeyard/promotions/attempt-1', promotionId: null,
      outputRef: null, outputCommit: null, failureReason: null,
    }
    const result = <T,>(value: T) => Promise.resolve({ ok: true, value: { ok: true, value } })
    const ctx = fakeClientContext(entries, cleanups, eligible, result, { promote })

    await act(async () => { await client.apply(ctx as never) })
    const overlay = await mount(<Slot entry={required(entries, 'shell.overlay')} />)
    const footer = await mount(<Slot entry={required(entries, 'sidebar.footer.action')} runtime={{ wide: true }} />)
    await click(await waitForElement(() => namedButton(footer.container, /Open Forgeyard/u)))
    await waitForElement(() => overlay.container.querySelector('[role="dialog"]'))
    await click(requiredElement(namedButton(overlay.container, /Browser mission/u), 'mission button'))
    await click(requiredElement(overlay.container.querySelector<HTMLButtonElement>('[role="row"]'), 'attempt row'))

    const panel = requiredElement(
      overlay.container.querySelector<HTMLElement>('[data-promotion-status]'),
      'promotion panel',
    )
    expect(panel.dataset.promotionStatus).toBe('eligible')
    expect(panel.textContent).toContain(digest)
    expect(panel.textContent).toContain('refs/forgeyard/promotions/attempt-1')
    expect(panel.textContent).toContain('Not promoted')

    // Approval alone never promotes: the operator must open and confirm.
    expect(promote).not.toHaveBeenCalled()
    expect(namedButton(panel, /Confirm promotion/u)).toBeNull()
    await click(requiredElement(namedButton(panel, /Promote approved deliverable/u), 'promote button'))
    const confirm = requiredElement(namedButton(panel, /Confirm promotion/u), 'confirm button')
    // Confirmation is not a bare button press: the operator must supply a
    // rationale, and the request carries the exact digest the panel displayed.
    expect(confirm.disabled).toBe(true)
    await click(confirm)
    expect(promote).not.toHaveBeenCalled()
    await type(requiredElement(panel.querySelector<HTMLTextAreaElement>('textarea'), 'rationale field'),
      'Deliver the reviewed change locally.')
    await click(requiredElement(namedButton(panel, /Confirm promotion/u), 'confirm button'))
    expect(promote).toHaveBeenCalledWith({
      attemptId: 'attempt-1',
      actor: 'local-user',
      rationale: 'Deliver the reviewed change locally.',
      expectedReviewDigest: digest,
    })

    await footer.unmount()
    await overlay.unmount()
    for (const cleanup of cleanups.reverse()) cleanup()
  })

  it('renders a completed promotion, its earlier failure, and the reason it cannot repeat', async () => {
    const client = await executeBuiltClientFace()
    const entries = new Map<string, SlotEntry>()
    const cleanups: Array<() => void> = []
    const digest = '9'.repeat(64)
    const commit = '7'.repeat(40)
    const data = snapshotFixture()
    const attemptView = approveMissionFixture(data)
    attemptView.promotions = [
      {
        ...promotionRecordFixture(digest, commit),
        id: 'promotion-0',
        status: 'failed',
        failureReason: 'The Forgeyard promotion ref was not created: reference already exists',
        outputCommit: '6'.repeat(40),
      },
      promotionRecordFixture(digest, commit),
    ]
    attemptView.promotion = {
      status: 'promoted', eligible: false,
      reason: `This Attempt was already promoted to refs/forgeyard/promotions/attempt-1 at ${commit}.`,
      reviewDigest: digest, decisionId: 'decision-1',
      plannedRef: 'refs/forgeyard/promotions/attempt-1', promotionId: 'promotion-1',
      outputRef: 'refs/forgeyard/promotions/attempt-1', outputCommit: commit,
      failureReason: null,
    } satisfies PromotionEligibility
    const result = <T,>(value: T) => Promise.resolve({ ok: true, value: { ok: true, value } })
    const ctx = fakeClientContext(entries, cleanups, data, result, { promote: vi.fn() })

    await act(async () => { await client.apply(ctx as never) })
    const overlay = await mount(<Slot entry={required(entries, 'shell.overlay')} />)
    const footer = await mount(<Slot entry={required(entries, 'sidebar.footer.action')} runtime={{ wide: true }} />)
    await click(await waitForElement(() => namedButton(footer.container, /Open Forgeyard/u)))
    await waitForElement(() => overlay.container.querySelector('[role="dialog"]'))
    await click(requiredElement(namedButton(overlay.container, /Browser mission/u), 'mission button'))
    await click(requiredElement(overlay.container.querySelector<HTMLButtonElement>('[role="row"]'), 'attempt row'))

    const panel = requiredElement(
      overlay.container.querySelector<HTMLElement>('[data-promotion-status]'),
      'promotion panel',
    )
    expect(panel.dataset.promotionStatus).toBe('promoted')
    expect(panel.textContent).toContain('already promoted')
    expect(panel.textContent).toContain(commit)
    expect(panel.textContent).toContain('2 promoted')
    expect(panel.textContent).toContain('1 ignored')
    expect(panel.textContent).toContain('1 dropped directories')
    // The earlier failure stays visible and readable next to the durable result.
    expect(panel.textContent).toContain('reference already exists')
    expect(panel.querySelectorAll('.fy-check')).toHaveLength(2)
    // A completed promotion never offers the action again.
    expect(namedButton(panel, /Promote approved deliverable/u)).toBeNull()
    expect(namedButton(panel, /Confirm promotion/u)).toBeNull()

    await footer.unmount()
    await overlay.unmount()
    for (const cleanup of cleanups.reverse()) cleanup()
  })
})

function Slot({
  entry,
  scope = [],
  runtime = {},
}: {
  entry: SlotEntry
  scope?: unknown[]
  runtime?: Record<string, unknown>
}) {
  const injected = entry.options.inject?.(...scope) ?? {}
  const hooks = injected.hooks as { cockpit: {
    getSnapshot(): unknown
    subscribe(listener: () => void): () => void
  } }
  const useCockpit = <T,>(selector: (snapshot: never) => T): T => useSyncExternalStore(
    hooks.cockpit.subscribe,
    () => selector(hooks.cockpit.getSnapshot() as never),
    () => selector(hooks.cockpit.getSnapshot() as never),
  )
  const Component = entry.component
  return <Component {...injected} {...runtime} useCockpit={useCockpit} />
}

async function mount(element: React.ReactElement): Promise<{
  container: HTMLDivElement
  root: Root
  unmount(): Promise<void>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  return {
    container,
    root,
    async unmount() {
      await act(async () => { root.unmount() })
      container.remove()
    },
  }
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => { button.click() })
}

async function type(field: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) throw new Error('the browser value setter is unavailable')
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function waitForElement<T extends Element>(read: () => T | null): Promise<T> {
  for (let index = 0; index < 50; index += 1) {
    const value = read()
    if (value !== null) return value
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  throw new Error('expected browser element did not render')
}

async function waitFor(read: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (read()) return
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  throw new Error('expected browser condition did not become true')
}

function requiredField(container: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement {
  const field = [...container.querySelectorAll<HTMLLabelElement>('label.fy-field')]
    .find(candidate => candidate.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')
  return requiredElement(field ?? null, `field ${label}`)
}

function namedButton(container: ParentNode, name: RegExp): HTMLButtonElement | null {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    name.test(button.getAttribute('aria-label') ?? button.textContent ?? ''),
  ) ?? null
}

function heading(container: ParentNode, text: string): HTMLHeadingElement | null {
  return [...container.querySelectorAll<HTMLHeadingElement>('h1,h2,h3')]
    .find(candidate => candidate.textContent === text) ?? null
}

function requiredElement<T extends Element>(value: T | null, label: string): T {
  if (value === null) throw new Error(`missing ${label}`)
  return value
}

async function executeBuiltClientFace(): Promise<BrowserFace> {
  const bundle = await readFile(join(import.meta.dirname, '../../packages/forgeyard/lib/client.js'), 'utf8')
  let declaration: { factory(require: (id: string) => unknown): BrowserFace } | undefined
  const previous = (window as unknown as { __ModuleLoader__?: unknown }).__ModuleLoader__
  ;(window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load(value: typeof declaration) { declaration = value },
  }
  try {
    Function(bundle)()
    if (declaration === undefined) throw new Error('built Forgeyard client did not register with DSH ModuleLoader')
    return declaration.factory((id) => {
      if (id === 'react') return React
      if (id === 'react/jsx-runtime') return JsxRuntime
      throw new Error(`unexpected external client dependency: ${id}`)
    })
  } finally {
    ;(window as unknown as { __ModuleLoader__?: unknown }).__ModuleLoader__ = previous
  }
}

function requiredAttempt(attempts: AttemptView[] | undefined): AttemptView {
  const attempt = attempts?.[0]
  if (attempt === undefined) throw new Error('missing attempt fixture')
  return attempt
}

/** Keep the Attempt, node projection, and Mission rollup mutually consistent. */
function approveMissionFixture(data: ForgeyardSnapshot): AttemptView {
  const mission = data.missions[0]
  const node = mission?.tasks[0]
  const attempt = requiredAttempt(node?.attempts)
  if (mission === undefined || node === undefined) throw new Error('missing Mission node fixture')
  attempt.attempt.state = 'approved'
  node.nodeState = 'approved'
  node.readiness = {
    status: 'ready',
    startable: false,
    reason: 'This Task is approved; starting another initial Attempt is not allowed.',
    blockedBy: [],
    baseCommit: null,
    baseFromAttemptId: null,
  }
  mission.derivedState = 'complete'
  return attempt
}

function fakeClientContext(
  entries: Map<string, SlotEntry>,
  cleanups: Array<() => void>,
  data: ForgeyardSnapshot,
  result: <T>(value: T) => Promise<{ ok: true; value: { ok: true; value: T } }>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    remote: {
      $mount: vi.fn(async () => undefined),
      forgeyard: {
        snapshot: vi.fn(() => result(data)),
        createMission: vi.fn(), startAttempt: vi.fn(), verifyAttempt: vi.fn(), decide: vi.fn(), retry: vi.fn(),
        promote: vi.fn(),
        attemptForSession: vi.fn(() => result(null)),
        ...overrides,
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ ids: ['session-1'], byId: { 'session-1': { id: 'session-1' } } }),
        subscribe: () => () => undefined,
      },
      open: vi.fn(),
    },
    effect: (install: () => (() => void)) => { cleanups.push(install()) },
    plugin: (definition: { apply: (scope: unknown) => void | Promise<void> }) => { void definition.apply(ctx) },
    slots: {
      inject: (_name: string, install: () => void) => { install() },
      register: (options: SlotEntry['options'], component: SlotEntry['component']) => {
        entries.set(options.name, { options, component })
        return () => { entries.delete(options.name) }
      },
    },
  }
  return ctx
}

function promotionRecordFixture(reviewDigest: string, outputCommit: string): PromotionRecord {
  const projection: PromotionProjection = {
    version: 1,
    projector: 'forgeyard.promotion-projection',
    projectorVersion: '1.0.0',
    workspaceHash: '1'.repeat(64),
    manifestEntryCount: 5,
    promoted: {
      count: 2,
      hash: '2'.repeat(64),
      preview: [{
        path: 'result.txt', type: 'file', gitMode: '100644', mode: '33188',
        sizeBytes: '6', contentHash: '3'.repeat(64), blobOid: '4'.repeat(40),
      }],
      previewTruncated: false,
    },
    excluded: {
      count: 3,
      hash: '5'.repeat(64),
      preview: [
        { path: '.git', type: 'file', reason: 'git-admin' },
        { path: 'debug.log', type: 'file', reason: 'ignored' },
        { path: 'build', type: 'directory', reason: 'directory-dropped' },
      ],
      previewTruncated: false,
    },
    excludedByReason: [
      { reason: 'git-admin', count: 1, hash: '6'.repeat(64) },
      { reason: 'ignored', count: 1, hash: '7'.repeat(64) },
      { reason: 'directory-implied', count: 0, hash: '8'.repeat(64) },
      { reason: 'directory-dropped', count: 1, hash: '9'.repeat(64) },
    ],
    unrepresentableModes: { count: 0, hash: 'a'.repeat(64), preview: [], previewTruncated: false },
    notCarried: ['Git-ignored files and directories'],
    canonical: '{}',
    hash: 'b'.repeat(64),
  }
  return {
    id: 'promotion-1',
    attemptId: 'attempt-1',
    decisionId: 'decision-1',
    reviewDigest,
    executionSnapshotHash: 'e'.repeat(64),
    baseCommit: 'a'.repeat(40),
    worktreeHead: 'a'.repeat(40),
    evidenceDigest: 'c'.repeat(64),
    verificationDigest: 'd'.repeat(64),
    projection,
    projectionHash: projection.hash,
    objectFormat: 'sha1',
    outputRef: 'refs/forgeyard/promotions/attempt-1',
    outputCommit,
    outputTree: '5'.repeat(40),
    status: 'promoted',
    actor: 'operator',
    rationale: 'Promote the approved deliverable.',
    failureReason: null,
    hash: 'f'.repeat(64),
    createdAt: 2,
    settledAt: 3,
  }
}

function required(entries: Map<string, SlotEntry>, name: string): SlotEntry {
  const entry = entries.get(name)
  if (entry === undefined) throw new Error(`missing slot entry ${name}`)
  return entry
}

function snapshotFixture(): ForgeyardSnapshot {
  const repository = {
    path: '/tmp/repository', baseRef: 'main', checkoutHead: 'a'.repeat(40), checkoutStatusHash: 'b'.repeat(64),
    gitDir: '/tmp/repository/.git', gitCommonDir: '/tmp/repository/.git', pathDevice: '1', pathInode: '2',
    gitDirDevice: '1', gitDirInode: '3', gitCommonDirDevice: '1', gitCommonDirInode: '3', ownerUid: '1000',
  }
  const policy = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', agentPreset: 'standard',
    permissionPreset: 'workspace-write', sandboxMode: 'workspace-write', approvalPolicy: 'ask',
    toolPolicy: { version: 1 as const, mode: 'frozen-schema' as const, allowedToolNames: ['bash'], schemaHash: 'c'.repeat(64) },
  }
  const requirement = { key: 'verify-1', command: 'node verify.mjs', argv: ['node', 'verify.mjs'] }
  return {
    schemaVersion: 3,
    dshVersion: '0.1.1-rc.2',
    missions: [{
      mission: {
        id: 'mission-1', title: 'Browser mission', objective: 'Prove the native browser-face round trip.',
        repository, baseRef: 'main', defaultPolicy: policy,
        pipe: { nodes: [{ key: 'implement', task: 'Implement it.', verify: [requirement], dependsOn: [] }] },
        pipeHash: 'd'.repeat(64), createdAt: 1,
      },
      tasks: [{
        task: {
          id: 'task-1', missionId: 'mission-1', sourceNodeKey: 'implement',
          specification: { title: 'Browser mission', objective: 'Prove it.', instruction: 'Implement it.', verification: [requirement] },
          dependencies: [], createdAt: 1,
        },
        attempts: [{
          attempt: {
            id: 'attempt-1', taskId: 'task-1', ordinal: 1,
            executionSnapshot: {
              version: 1, attemptId: 'attempt-1', ordinal: 1,
              task: { title: 'Browser mission', objective: 'Prove it.', instruction: 'Implement it.', verification: [requirement] },
              repository, baseCommit: 'a'.repeat(40), policy, verification: [requirement], createdAt: 1,
            },
            executionSnapshotHash: 'e'.repeat(64), baseCommit: 'a'.repeat(40),
            worktreePath: '/tmp/forgeyard-attempt-1', worktreeDevice: '1', worktreeInode: '4',
            rawWorkspaceBaseline: null, rawWorkspaceBaselineHash: null,
            retryOfAttemptId: null, successorAttemptId: null, dshSessionId: 'session-1', state: 'awaiting_decision',
            startedAt: 1, endedAt: null, gitFingerprint: null, terminalReason: null, createdAt: 1, updatedAt: 1,
          },
          evidence: [], verifications: [], decisions: [],
          review: {
            reviewDigest: 'f'.repeat(64), liveGitFingerprint: 'unavailable', latestRunId: null,
            requiredVerificationCount: 1, passingVerificationCount: 0, canApprove: false,
            reviewedStateCurrent: false, approvalStale: true, reason: 'No trusted Evidence has been collected.',
          },
          promotions: [],
          promotion: {
            status: 'blocked', eligible: false, plannedRef: null, promotionId: null,
            reason: 'Only an Attempt with a terminal APPROVE Decision can be promoted; this Attempt is awaiting_decision.',
            reviewDigest: null, decisionId: null, outputRef: null, outputCommit: null, failureReason: null,
          },
        }],
        readiness: { status: 'ready', startable: false, reason: 'The first Attempt already exists; use Retry for every successor.', blockedBy: [], baseCommit: null, baseFromAttemptId: null },
        nodeState: 'awaiting_decision',
      }],
      derivedState: 'awaiting_decision',
    }],
  }
}
