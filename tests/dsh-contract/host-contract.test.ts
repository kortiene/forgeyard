import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DshSessionGateway } from '../../packages/forgeyard/src/host/execution.ts'
import { canonicalJson, sha256 } from '../../packages/forgeyard/src/host/hash.ts'
import { DshProcessRunner } from '../../packages/forgeyard/src/host/process.ts'
import { installForgeyardAgentAuthority } from '../../packages/forgeyard/src/host/agent-authority.ts'
import { DshVerifierConfinement } from '../../packages/forgeyard/src/host/verifier.ts'
import { testRuntime } from '../helpers/runtime.ts'

// Keep this unit at the public boundary without booting the complete DSH base
// bundle. The declaration-shape assertions below still inspect the pinned
// published packages; these two branded constructors are identity functions.
vi.mock('@deepseek-ai/dsh-host-apiproxy', () => ({ RpcId: (id: string) => id }))
vi.mock('@deepseek-ai/dsh-session', () => ({ SessionId: (id: string) => id }))

const require = createRequire(import.meta.url)

describe('pinned DSH Host contracts', () => {
  it('pins every DSH package to the audited release', async () => {
    const root = join(import.meta.dirname, '../..')
    const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }
    const plugin = JSON.parse(await readFile(join(root, 'packages/forgeyard/package.json'), 'utf8')) as { peerDependencies: Record<string, string> }
    for (const [name, version] of Object.entries(workspace.devDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))) {
      expect(version, name).toBe('0.1.1-rc.2')
    }
    for (const [name, version] of Object.entries(plugin.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))) {
      expect(version, name).toBe('0.1.1-rc.2')
    }
    const dsh = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { version: string }
    expect(dsh.version).toBe('0.1.1-rc.2')
  })

  it('keeps the exact public Session, model, prompt, and permission calls', async () => {
    const session = { header: { cwd: '/attempt', agentPreset: 'default' }, events: [] }
    const permission = { sandbox: 'workspace-write', approval: 'ask' }
    const create = vi.fn(async (request: unknown) => ({ result: { ok: true, value: { sessionId: SessionId('s1'), agentPreset: 'default' } }, request }))
    const selection = { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }
    const selectModel = vi.fn(async () => ({ result: { ok: true, value: { selected: selection } } }))
    const models = vi.fn(async () => ({ result: { ok: true, value: { current: selection, routable: true, groups: [], failures: [] } } }))
    const prompt = vi.fn(async () => ({ result: { ok: true, value: { accepted: true } } }))
    const runMaintenance = vi.fn(async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal))
    const cancel = vi.fn()
    const whenIdle = vi.fn(async () => undefined)
    const guard = vi.fn(() => () => undefined)
    const on = vi.fn(() => () => undefined)
    const set = vi.fn()
    let currentPreset = 'workspace-write'
    const current = vi.fn(() => currentPreset)
    const toolSchemas = [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }]
    const drainContinuableDescendants = vi.fn(async () => undefined)
    const listJobs = vi.fn(() => [])
    const agent = { id: 's1', session, runMaintenance, cancel, whenIdle, ctx: { on, tools: { guard, schemas: vi.fn(() => toolSchemas) } } }
    const ctx = {
      apiProxy: {
        agentPresets: { list: vi.fn(async () => ({ result: { ok: true, value: { presets: [{ id: 'default', isDefault: true, trust: 'system' }], authorable: false, hasDocument: false } } })) },
        sessions: { create, selectModel, models, prompt },
      },
      permissionPresets: { resolve: vi.fn(() => permission), set, current },
      agentPresets: { standingKeyFor: vi.fn(async () => ({ agentPreset: 'default' })) },
      tools: { schemas: vi.fn(() => toolSchemas) },
      sessions: { get: vi.fn(() => session) },
      agents: { get: vi.fn(() => agent) },
      subagents: { drainContinuableDescendants },
      jobs: { list: listJobs, kill: vi.fn(), wait: vi.fn() },
    }
    const gateway = new DshSessionGateway(ctx as never, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
      agentPreset: null, permissionPreset: 'workspace-write',
    })
    const policy = await gateway.resolvePolicy({ provider: null, model: null, reasoningEffort: null, agentPreset: null, permissionPreset: null })
    expect(policy).toMatchObject({ sandboxMode: 'workspace-write', approvalPolicy: 'ask', agentPreset: 'default' })
    expect(policy.toolPolicy).toMatchObject({
      version: 1, mode: 'frozen-schema', allowedToolNames: ['bash'], schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    await gateway.createAndPrompt('s1', '/attempt', {
      version: 1, attemptId: 'attempt-1', ordinal: 1,
      task: { title: 'Fix', objective: 'Fix it', instruction: 'Make the change', verification: [{ key: 'v', command: 'true', argv: ['true'] }] },
      repository: {
        path: '/repo', baseRef: 'main', checkoutHead: 'a'.repeat(40), checkoutStatusHash: sha256(''),
        gitDir: '/repo/.git', gitCommonDir: '/repo/.git',
        pathDevice: '1', pathInode: '2', gitDirDevice: '1', gitDirInode: '3',
        gitCommonDirDevice: '1', gitCommonDirInode: '3', ownerUid: '1000',
      },
      baseCommit: 'a'.repeat(40), policy, verification: [{ key: 'v', command: 'true', argv: ['true'] }], createdAt: 1,
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      rpcId: expect.any(String), payload: { sessionId: 's1', cwd: '/attempt', agentPreset: 'default' },
    }))
    expect(set).toHaveBeenCalledWith(session, 'workspace-write')
    expect(current).toHaveBeenCalledWith(session.events)
    expect(selectModel).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sessionId: 's1', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' }) }))
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ payload: { sessionId: 's1' } }))
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ sessionId: 's1', mode: 'queue' }) }))
    await expect(gateway.runMaintenance('s1', async () => 'fenced')).resolves.toBe('fenced')
    await expect(gateway.runTerminalMaintenance('s1', async () => 'terminal')).resolves.toBe('terminal')
    expect(runMaintenance).toHaveBeenCalledTimes(3)
    expect(cancel).toHaveBeenCalledTimes(3)
    expect(whenIdle).toHaveBeenCalledTimes(3)
    expect(drainContinuableDescendants).toHaveBeenCalledTimes(3)
    expect(listJobs).toHaveBeenCalledTimes(3)
    expect(guard).toHaveBeenCalledOnce()
    expect(on).toHaveBeenCalledTimes(2)
    expect(on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
    expect(on).toHaveBeenCalledWith('agent/request', expect.any(Function), { prepend: true })
    const requestGuard = on.mock.calls.find(call => call[0] === 'agent/request')?.[1]
    await expect(requestGuard?.({}, async () => selection)).resolves.toEqual(selection)
    await expect(requestGuard?.({}, async () => ({ ...selection, reasoningEffort: 'low' }))).rejects.toThrow(/model\/provider\/reasoning/)
    const permissionGuard = on.mock.calls.find(call => call[0] === 'agent/pre-step')?.[1]
    await expect(permissionGuard?.({}, async () => ({ kind: 'enter', messages: [] }))).resolves.toEqual({ kind: 'enter', messages: [] })
    currentPreset = 'custom'
    await expect(permissionGuard?.({}, async () => ({ kind: 'enter', messages: [] }))).rejects.toThrow(/permission preset/)
    const frozenGuard = guard.mock.calls[0]?.[0]
    expect(frozenGuard?.({ name: 'bash' } as never)).toBeUndefined()
    toolSchemas.push({ name: 'write', description: 'write a file', parameters: { type: 'object', properties: {} } })
    expect(frozenGuard?.({ name: 'bash' } as never)).toMatch(/schema change/)
    expect(frozenGuard?.({ name: 'unlisted' } as never)).toMatch(/unlisted tool/)
    expect(RpcId('contract')).toBe('contract')
  })

  it('fails closed on frozen Session policy or complete model-selection drift', async () => {
    const session = { header: { cwd: '/attempt', agentPreset: 'default' }, events: [] }
    const schema = { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }
    const agent = { id: 's1', session, ctx: { tools: { guard: vi.fn(), schemas: vi.fn(() => [schema]) } } }
    const gateway = new DshSessionGateway({
      apiProxy: { sessions: { models: vi.fn(async () => ({
        result: { ok: true, value: {
          current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
          routable: true, groups: [], failures: [],
        } },
      })) } },
      permissionPresets: {
        resolve: vi.fn(() => ({ sandbox: 'workspace-write', approval: 'ask' })),
        current: vi.fn(() => 'workspace-write'),
      },
      tools: { schemas: vi.fn(() => [schema]) },
      sessions: { get: vi.fn(() => session) },
      agents: { get: vi.fn(() => agent) },
    } as never, {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
      agentPreset: 'default', permissionPreset: 'workspace-write',
    })
    await expect(gateway.assertFrozenExecution('s1', '/attempt', {
      policy: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
        agentPreset: 'default', permissionPreset: 'workspace-write', sandboxMode: 'workspace-write',
        approvalPolicy: 'ask', toolPolicy: {
          version: 1, mode: 'frozen-schema', allowedToolNames: ['bash'],
          schemaHash: sha256(canonicalJson([schema])),
        },
      },
    } as never)).rejects.toThrow(/model\/provider\/reasoning/)
  })

  it('uses the public Session models read as the safe cold-Web-session resume boundary', async () => {
    const session = { header: { cwd: '/attempt', agentPreset: 'default' }, events: [] }
    const runMaintenance = vi.fn(async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal))
    const agent = { id: 's1', session, runMaintenance }
    let live = false
    const models = vi.fn(async () => {
      live = true
      return { result: { ok: true, value: {
        current: { provider: 'p', model: 'm' }, routable: true, groups: [], failures: [],
      } } }
    })
    const gateway = new DshSessionGateway({
      apiProxy: { sessions: { models } },
      agents: { get: vi.fn(() => live ? agent : undefined) },
      subagents: { drainContinuableDescendants: vi.fn(async () => undefined) },
      jobs: { list: vi.fn(() => []), kill: vi.fn(), wait: vi.fn() },
    } as never, {
      provider: 'p', model: 'm', reasoningEffort: null, agentPreset: 'default',
      permissionPreset: 'workspace-write',
    })
    await expect(gateway.runMaintenance('s1', async () => 'resumed-and-fenced')).resolves.toBe('resumed-and-fenced')
    expect(models).toHaveBeenCalledOnce()
    expect(runMaintenance).toHaveBeenCalledOnce()
  })

  it('drains continuable descendants and owned background Jobs before trusted maintenance', async () => {
    const session = { header: { cwd: '/attempt' }, events: [] }
    const operations: string[] = []
    const agent = {
      id: 's1', session,
      runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    }
    const job = { id: 'subagent-1', status: 'running' }
    const gateway = new DshSessionGateway({
      agents: { get: vi.fn(() => agent) },
      subagents: { drainContinuableDescendants: vi.fn(async () => { operations.push('descendants') }) },
      jobs: {
        list: vi.fn(() => [job]),
        kill: vi.fn(() => { operations.push('job-kill'); return 'requested' }),
        wait: vi.fn(async () => { operations.push('job-wait'); return { ...job, status: 'killed' } }),
      },
    } as never, {
      provider: 'p', model: 'm', reasoningEffort: null, agentPreset: null,
      permissionPreset: 'workspace-write',
    })

    await expect(gateway.runMaintenance('s1', async () => { operations.push('trusted-task'); return 'done' }))
      .resolves.toBe('done')
    expect(operations).toEqual(['descendants', 'job-kill', 'job-wait', 'trusted-task'])
  })

  it('confines a verifier to the exact Session cwd and requires full DSH enforcement', () => {
    const policy = { mode: 'workspace-write' as const, workspaceRoot: '/attempt', sessionId: 's1' }
    const resolve = vi.fn(() => policy)
    const confine = vi.fn(() => ({ argv: ['sandbox-wrapper', '--', 'node', 'verify.mjs'], enforcement: 'full' as const }))
    const authority = new DshVerifierConfinement({
      sessions: { get: vi.fn(() => ({ header: { cwd: '/attempt' }, events: [] })) },
      permissionPresets: {
        resolve: vi.fn(() => ({ sandbox: 'workspace-write', approval: 'ask' })),
        current: vi.fn(() => 'workspace-write'),
      },
      sandboxPolicy: { resolve },
      sandbox: { confine },
    } as never)
    const result = authority.confine({
      dshSessionId: 's1', worktreePath: '/attempt', worktreeDevice: '1', worktreeInode: '4',
      executionSnapshot: { policy: {
        permissionPreset: 'workspace-write', sandboxMode: 'workspace-write', approvalPolicy: 'ask',
      } },
    } as never, ['node', 'verify.mjs'])
    expect(result).toEqual({
      argv: ['sandbox-wrapper', '--', 'node', 'verify.mjs'],
      mode: 'workspace-write', enforcement: 'full', workspaceRoot: '/attempt',
    })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ mode: 'workspace-write' }))
    expect(confine).toHaveBeenCalledWith(['node', 'verify.mjs'], policy)
  })

  it('refuses verifier execution when the effective permission bundle drifted', () => {
    const authority = new DshVerifierConfinement({
      sessions: { get: vi.fn(() => ({ header: { cwd: '/attempt' }, events: [] })) },
      permissionPresets: {
        resolve: vi.fn(() => ({ sandbox: 'read-only', approval: 'ask' })),
        current: vi.fn(() => 'custom'),
      },
      sandboxPolicy: { resolve: vi.fn() },
      sandbox: { confine: vi.fn() },
    } as never)
    expect(() => authority.confine({
      dshSessionId: 's1', worktreePath: '/attempt',
      executionSnapshot: { policy: {
        permissionPreset: 'workspace-write', sandboxMode: 'workspace-write', approvalPolicy: 'ask',
      } },
    } as never, ['node', 'verify.mjs'])).toThrow(/frozen sandbox\/approval policy/)
  })

  it('executes through the public managed subprocess seam', async () => {
    const runtime = await testRuntime()
    try {
      expect(new DshProcessRunner(runtime.ctx.subprocess)).toBeInstanceOf(DshProcessRunner)
      const result = await runtime.runner.run({
        argv: [process.execPath, '-e', "process.stdout.write('managed')"],
        cwd: process.cwd(), timeoutMs: 5_000, memoryLimitBytes: 64, spillLimitBytes: 1024,
      })
      expect(result).toMatchObject({ exitCode: 0, timedOut: false, spawnError: null })
      expect(result.stdout).toMatchObject({ text: 'managed', complete: true })
    } finally {
      await runtime.dispose()
    }
  })

  it('propagates the owning maintenance AbortSignal into the managed subprocess', async () => {
    const runtime = await testRuntime()
    try {
      const controller = new AbortController()
      const pending = runtime.runner.run({
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
        cwd: process.cwd(), signal: controller.signal,
        timeoutMs: 10_000, memoryLimitBytes: 64, spillLimitBytes: 1024,
      })
      setTimeout(() => controller.abort(new Error('maintenance cancelled')), 20)
      const result = await pending
      expect(result.timedOut).toBe(false)
      expect(result.durationMs).toBeLessThan(5_000)
      expect(result.exitCode === null || result.signal !== null || result.spawnError !== null).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  it('guards pre-existing and newly resumed Forgeyard Agents and rejects terminal model steps', async () => {
    const existingAgent = { id: 'session-existing' }
    const createdAgent = { id: 'session-created' }
    const terminalAgent = { id: 'session-terminal' }
    const uncertainAgent = { id: 'session-uncertain' }
    const records = new Map<string, { state: string; executionSnapshot: object }>([
      ['session-existing', { state: 'running', executionSnapshot: { attemptId: 'attempt-existing' } }],
      ['session-created', { state: 'running', executionSnapshot: { attemptId: 'attempt-created' } }],
      ['session-terminal', { state: 'approved', executionSnapshot: { attemptId: 'attempt-terminal' } }],
      ['session-uncertain', { state: 'needs_review', executionSnapshot: { attemptId: 'attempt-uncertain' } }],
    ])
    const on = vi.fn()
    const installPolicyGuards = vi.fn()
    installForgeyardAgentAuthority({
      on,
      agents: { list: vi.fn(() => [existingAgent, uncertainAgent]) },
    } as never, {
      attemptBySession: vi.fn((id: string) => records.get(id)),
      isTerminal: vi.fn((state: string) => ['approved', 'rejected', 'retried', 'cancelled'].includes(state)),
    } as never, { installPolicyGuards } as never)

    expect(installPolicyGuards).toHaveBeenCalledWith(existingAgent, { attemptId: 'attempt-existing' })
    expect(installPolicyGuards).not.toHaveBeenCalledWith(uncertainAgent, expect.anything())
    const created = on.mock.calls.find(call => call[0] === 'agent/created')?.[1]
    created?.({ agent: createdAgent })
    expect(installPolicyGuards).toHaveBeenCalledWith(createdAgent, { attemptId: 'attempt-created' })
    records.set('session-created', { state: 'worktree_ready', executionSnapshot: { attemptId: 'fresh' } })
    created?.({ agent: createdAgent })
    expect(installPolicyGuards).not.toHaveBeenCalledWith(createdAgent, { attemptId: 'fresh' })

    const preStep = on.mock.calls.find(call => call[0] === 'agent/pre-step')?.[1]
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    await expect(preStep?.({ agent: terminalAgent }, next)).resolves.toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    await expect(preStep?.({ agent: uncertainAgent }, next)).resolves.toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    await expect(preStep?.({ agent: createdAgent }, next)).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(next).toHaveBeenCalledOnce()
    expect(on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
  })

  it('guards the audited public declaration shapes', async () => {
    const hostRoot = dirname(require.resolve('@deepseek-ai/dsh-host-apiproxy/package.json'))
    const permissionRoot = dirname(require.resolve('@deepseek-ai/dsh-permission-presets/package.json'))
    const agentRoot = dirname(require.resolve('@deepseek-ai/dsh-agent/package.json'))
    const agentPresetsRoot = dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json'))
    const toolsRoot = dirname(require.resolve('@deepseek-ai/dsh-tools/package.json'))
    const jobsRoot = dirname(require.resolve('@deepseek-ai/dsh-jobs/package.json'))
    const subagentRoot = dirname(require.resolve('@deepseek-ai/dsh-subagent/package.json'))
    const sessionApi = await readFile(join(hostRoot, 'lib/types/api/sessions.d.ts'), 'utf8')
    const hostRuntime = await readFile(join(hostRoot, 'lib/types/api-proxy.js'), 'utf8')
    const permissionApi = await readFile(join(permissionRoot, 'lib/types/index.d.ts'), 'utf8')
    const agentApi = await readFile(join(agentRoot, 'lib/types/runtime-types.d.ts'), 'utf8')
    const agentRegistryApi = await readFile(join(agentRoot, 'lib/types/index.d.ts'), 'utf8')
    const agentPresetsApi = await readFile(join(agentPresetsRoot, 'lib/types/index.d.ts'), 'utf8')
    const toolsApi = await readFile(join(toolsRoot, 'lib/types/index.d.ts'), 'utf8')
    const jobsApi = await readFile(join(jobsRoot, 'lib/types/index.d.ts'), 'utf8')
    const subagentApi = await readFile(join(subagentRoot, 'lib/types/index.d.ts'), 'utf8')
    expect(sessionApi).toContain('create(request: RpcRequest<')
    expect(sessionApi).toContain('selectModel(request: RpcRequest<')
    expect(sessionApi).toContain('models(request: RpcRequest<')
    expect(hostRuntime).toMatch(/async models\(request\)[\s\S]{0,200}await agentFor\(sessionId\)/)
    expect(hostRuntime).toContain('Cold resume composes the preset the session recorded')
    expect(sessionApi).toContain('prompt(request: RpcRequest<')
    expect(permissionApi).toContain('resolve(name: string): PresetSpec')
    expect(permissionApi).toContain('set(session: Session, name: string): void')
    expect(permissionApi).toContain('current(events: readonly SessionEvent[]): string')
    expect(agentApi).toContain('cancel(cause: AgentCancelCause, options?: CancelOptions): void')
    expect(agentApi).toContain('whenIdle(): Promise<void>')
    expect(agentApi).toContain('runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>')
    expect(agentRegistryApi).toContain('list(): Agent[]')
    expect(agentApi).toContain("'agent/pre-step'")
    expect(agentApi).toContain("'agent/request'")
    expect(agentPresetsApi).toContain('standingKeyFor(id?: string): Promise<ScopeKey>')
    expect(toolsApi).toContain('guard(guard: ToolGuard): () => void')
    expect(toolsApi).toContain('schemas(scope?: ScopeKey): ToolSchema[]')
    expect(jobsApi).toContain('abstract list(caller?: Agent): JobSnapshot[]')
    expect(jobsApi).toContain("abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'")
    expect(jobsApi).toContain('abstract wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot>')
    expect(subagentApi).toContain('drainContinuableDescendants(parents: readonly Agent[]): Promise<void>')
  })
})
