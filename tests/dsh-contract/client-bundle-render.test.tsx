// @vitest-environment jsdom

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import React, { act, useSyncExternalStore, type ComponentType } from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ForgeyardSnapshot } from '../../packages/forgeyard/src/types.ts'

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

async function waitForElement<T extends Element>(read: () => T | null): Promise<T> {
  for (let index = 0; index < 50; index += 1) {
    const value = read()
    if (value !== null) return value
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  throw new Error('expected browser element did not render')
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
    schemaVersion: 2,
    dshVersion: '0.1.1-rc.2',
    missions: [{
      mission: {
        id: 'mission-1', title: 'Browser mission', objective: 'Prove the native browser-face round trip.',
        repository, baseRef: 'main', defaultPolicy: policy,
        pipe: { nodes: [{ key: 'implement', task: 'Implement it.', verify: [requirement] }] },
        pipeHash: 'd'.repeat(64), createdAt: 1,
      },
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
          approvalStale: true, reason: 'No trusted Evidence has been collected.',
        },
      }],
      derivedState: 'awaiting_decision',
    }],
  }
}
