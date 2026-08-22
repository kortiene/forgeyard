import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import type { ExecutionSnapshot, ResolvedPolicySnapshot } from '../types.ts'
import { canonicalJson, sha256 } from './hash.ts'

export interface PolicyOverrides {
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  agentPreset: string | null
  permissionPreset: string | null
}

export interface ExecutionDefaults {
  provider: string
  model: string
  reasoningEffort: string | null
  agentPreset: string | null
  permissionPreset: string
}

export interface SessionGateway {
  resolvePolicy(overrides: PolicyOverrides): Promise<ResolvedPolicySnapshot>
  createAndPrompt(sessionId: string, cwd: string, snapshot: ExecutionSnapshot): Promise<void>
  installPolicyGuards(agent: Agent, snapshot: ExecutionSnapshot): void
  assertFrozenExecution(sessionId: string, cwd: string, snapshot: ExecutionSnapshot): Promise<void>
  sessionExists(sessionId: string): Promise<boolean>
  runMaintenance<T>(sessionId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>
  runTerminalMaintenance<T>(sessionId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

function rpcId(label: string): ReturnType<typeof RpcId> {
  return RpcId(`forgeyard-${label}-${randomUUID()}`)
}

function responseValue<T>(response: { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }): T {
  if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
  return response.result.value
}

function assertPermissionPolicy(
  actual: { sandbox: string; approval: string },
  expected: ResolvedPolicySnapshot,
): void {
  if (actual.sandbox !== expected.sandboxMode || actual.approval !== expected.approvalPolicy) {
    throw new Error('DSH resolved a different sandbox/approval policy than the frozen execution snapshot')
  }
}

function assertModelSelection(
  actual: { provider: string; model: string; reasoningEffort?: string },
  expected: ResolvedPolicySnapshot,
): void {
  if (
    actual.provider !== expected.provider
    || actual.model !== expected.model
    || (actual.reasoningEffort ?? null) !== expected.reasoningEffort
  ) {
    throw new Error(
      'DSH resolved a different model/provider/reasoning selection than the frozen execution snapshot'
      + ` (expected ${canonicalJson({
        provider: expected.provider,
        model: expected.model,
        reasoningEffort: expected.reasoningEffort,
      })}; actual ${canonicalJson({
        provider: actual.provider,
        model: actual.model,
        reasoningEffort: actual.reasoningEffort ?? null,
      })})`,
    )
  }
}

function toolPolicyFor(schemas: readonly { name: string }[]): ResolvedPolicySnapshot['toolPolicy'] {
  const ordered = [...schemas].sort((left, right) => left.name.localeCompare(right.name))
  const allowedToolNames = ordered.map(schema => schema.name)
  if (new Set(allowedToolNames).size !== allowedToolNames.length) {
    throw new Error('DSH returned duplicate visible tool names for the frozen agent preset')
  }
  return {
    version: 1,
    mode: 'frozen-schema',
    allowedToolNames,
    schemaHash: sha256(canonicalJson(ordered)),
  }
}

function assertToolPolicy(
  actual: ResolvedPolicySnapshot['toolPolicy'],
  expected: ResolvedPolicySnapshot['toolPolicy'],
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('DSH visible tool schemas no longer match the frozen execution snapshot')
  }
}

/** Public DSH Host API adapter: ApiProxy + Session store + permission presets. */
export class DshSessionGateway implements SessionGateway {
  private readonly guardedAgents = new WeakMap<Agent, string>()

  constructor(private readonly ctx: Context, private readonly defaults: ExecutionDefaults) {}

  async resolvePolicy(overrides: PolicyOverrides): Promise<ResolvedPolicySnapshot> {
    const provider = overrides.provider ?? this.defaults.provider
    const model = overrides.model ?? this.defaults.model
    if (provider.trim().length === 0 || model.trim().length === 0) throw new Error('provider and model must be configured')
    const permissionPreset = overrides.permissionPreset ?? this.defaults.permissionPreset
    const permission = this.ctx.permissionPresets.resolve(permissionPreset)
    const roster = responseValue(await this.ctx.apiProxy.agentPresets.list({ rpcId: rpcId('preset-list'), payload: {} }))
    const requestedPreset = overrides.agentPreset ?? this.defaults.agentPreset
      ?? roster.presets.find(entry => entry.isDefault)?.id ?? null
    if (requestedPreset !== null) {
      const entry = roster.presets.find(item => item.id === requestedPreset)
      if (entry === undefined) throw new Error(`unknown DSH agent preset: ${requestedPreset}`)
      if (entry.broken !== undefined) throw new Error(`DSH agent preset ${requestedPreset} is broken: ${entry.broken}`)
    }
    const standingKey = await this.ctx.agentPresets.standingKeyFor(requestedPreset ?? undefined)
    const toolPolicy = toolPolicyFor(this.ctx.tools.schemas(standingKey))
    return {
      provider,
      model,
      reasoningEffort: overrides.reasoningEffort ?? this.defaults.reasoningEffort,
      agentPreset: requestedPreset,
      permissionPreset,
      sandboxMode: permission.sandbox,
      approvalPolicy: permission.approval,
      toolPolicy,
    }
  }

  async createAndPrompt(sessionIdText: string, cwd: string, snapshot: ExecutionSnapshot): Promise<void> {
    const sessionId = SessionId(sessionIdText)
    // Resolve again at the execution boundary. A profile/settings change after
    // Mission creation must not silently change the frozen Attempt authority.
    assertPermissionPolicy(this.ctx.permissionPresets.resolve(snapshot.policy.permissionPreset), snapshot.policy)
    const created = responseValue(await this.ctx.apiProxy.sessions.create({
      rpcId: rpcId('session-create'),
      payload: {
        sessionId,
        cwd,
        ...(snapshot.policy.agentPreset === null ? {} : { agentPreset: snapshot.policy.agentPreset }),
      },
    }))
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error('DSH did not publish the native Session created for the Attempt')
    if (session.header.cwd !== cwd) throw new Error('DSH did not bind the Session to the Attempt worktree')
    if ((session.header.agentPreset ?? null) !== snapshot.policy.agentPreset) {
      throw new Error('DSH Session header records a different agent preset than the frozen execution snapshot')
    }
    if ((created.agentPreset ?? null) !== snapshot.policy.agentPreset) {
      throw new Error('DSH Session creation returned a different agent preset than the frozen execution snapshot')
    }
    this.ctx.permissionPresets.set(session, snapshot.policy.permissionPreset)
    if (this.ctx.permissionPresets.current(session.events) !== snapshot.policy.permissionPreset) {
      throw new Error('DSH did not apply the frozen permission preset to the Session')
    }
    assertPermissionPolicy(this.ctx.permissionPresets.resolve(snapshot.policy.permissionPreset), snapshot.policy)
    const selected = responseValue(await this.ctx.apiProxy.sessions.selectModel({
      rpcId: rpcId('model-select'),
      payload: {
        sessionId,
        provider: snapshot.policy.provider,
        model: snapshot.policy.model,
        ...(snapshot.policy.reasoningEffort === null ? {} : { reasoningEffort: snapshot.policy.reasoningEffort }),
      },
    }))
    assertModelSelection(selected.selected, snapshot.policy)
    await this.assertFrozenExecution(sessionIdText, cwd, snapshot)
    const verification = snapshot.verification.map(item => `- ${item.command}`).join('\n')
    const prompt = [
      `Forgeyard Attempt ${snapshot.attemptId} (immutable execution snapshot ${snapshot.ordinal}).`,
      '',
      snapshot.task.instruction,
      '',
      `Objective: ${snapshot.task.objective}`,
      '',
      'Required trusted verification (Forgeyard will run these independently):',
      verification,
      '',
      'Work only in the current DSH workspace. Do not treat your own claims as Evidence.',
    ].join('\n')
    responseValue(await this.ctx.apiProxy.sessions.prompt({
      rpcId: rpcId('initial-prompt'),
      payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] },
    }))
  }

  async assertFrozenExecution(sessionIdText: string, cwd: string, snapshot: ExecutionSnapshot): Promise<void> {
    const sessionId = SessionId(sessionIdText)
    // session.models is the public rc.2 read surface for the complete selection.
    // On a cold persisted Web Session its public implementation also resumes the
    // Agent with the Session's recorded preset composition. Refuse to continue
    // if that operation does not publish the corresponding native Agent.
    const models = responseValue(await this.ctx.apiProxy.sessions.models({
      rpcId: rpcId('model-readback'),
      payload: { sessionId },
    }))
    const session = this.ctx.sessions.get(sessionId)
    const agent = this.ctx.agents.get(sessionId)
    if (session === undefined || agent === undefined) {
      throw new Error('the persisted DSH Session could not be resumed as a native Agent; execution state is unprovable')
    }
    if (agent.session !== session || agent.id !== sessionId) {
      throw new Error('DSH Agent/Session identity does not match the frozen Attempt Session ID')
    }
    if (session.header.cwd !== cwd) throw new Error('DSH Session cwd no longer matches the frozen Attempt worktree')
    if ((session.header.agentPreset ?? null) !== snapshot.policy.agentPreset) {
      throw new Error('DSH Session agent preset no longer matches the frozen execution snapshot')
    }
    const permission = this.ctx.permissionPresets.resolve(snapshot.policy.permissionPreset)
    assertPermissionPolicy(permission, snapshot.policy)
    if (this.ctx.permissionPresets.current(session.events) !== snapshot.policy.permissionPreset) {
      throw new Error('DSH Session permission preset no longer matches the frozen execution snapshot')
    }
    assertModelSelection(models.current, snapshot.policy)
    this.installPolicyGuards(agent, snapshot)
  }

  installPolicyGuards(agent: Agent, snapshot: ExecutionSnapshot): void {
    const policy = snapshot.policy
    if ((agent.session.header.agentPreset ?? null) !== policy.agentPreset) {
      throw new Error('DSH Session agent preset does not match the frozen execution snapshot')
    }
    this.assertFrozenPermission(agent, policy)
    const actual = toolPolicyFor(this.ctx.tools.schemas(agent))
    assertToolPolicy(actual, policy.toolPolicy)
    const policyDigest = sha256(canonicalJson(policy))
    const installed = this.guardedAgents.get(agent)
    if (installed !== undefined) {
      if (installed !== policyDigest) {
        throw new Error('the live DSH Agent is already guarded by a different frozen execution policy')
      }
      return
    }
    const allowed = new Set(policy.toolPolicy.allowedToolNames)
    agent.ctx.tools.guard((execution) => {
      if (!allowed.has(execution.name)) return `Forgeyard frozen tool policy denies unlisted tool "${execution.name}"`
      try {
        const current = toolPolicyFor(agent.ctx.tools.schemas(agent))
        if (canonicalJson(current) !== canonicalJson(policy.toolPolicy)) {
          return 'Forgeyard frozen tool policy denies execution after a visible tool schema change'
        }
      } catch {
        return 'Forgeyard frozen tool policy denies execution because the visible tool schema is unreadable'
      }
      return undefined
    })
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      this.assertFrozenPermission(agent, policy)
      const decision = await next()
      this.assertFrozenPermission(agent, policy)
      return decision
    }, { prepend: true })
    agent.ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      assertModelSelection(config, policy)
      return config
    }, { prepend: true })
    this.guardedAgents.set(agent, policyDigest)
  }

  private assertFrozenPermission(agent: Agent, policy: ResolvedPolicySnapshot): void {
    const permission = this.ctx.permissionPresets.resolve(policy.permissionPreset)
    assertPermissionPolicy(permission, policy)
    if (this.ctx.permissionPresets.current(agent.session.events) !== policy.permissionPreset) {
      throw new Error('DSH Session permission preset no longer matches the frozen execution snapshot')
    }
  }

  private async liveAgent(sessionId: ReturnType<typeof SessionId>): Promise<Agent> {
    const attached = this.ctx.agents.get(sessionId)
    if (attached !== undefined) return attached
    // Do not call agents.resume() directly: its public setup callback is the
    // caller's responsibility, and Forgeyard must not reconstruct DSH Web's
    // preset/tool composition. The public models API owns that composition and
    // safely exercises the Web Host's persisted-session resolver.
    responseValue(await this.ctx.apiProxy.sessions.models({
      rpcId: rpcId('session-resume'),
      payload: { sessionId },
    }))
    const resumed = this.ctx.agents.get(sessionId)
    if (resumed === undefined) {
      throw new Error('the persisted DSH Session could not be resumed as a native Agent; maintenance was refused')
    }
    return resumed
  }

  /** Public, persistence-aware proof used only to choose a terminal fence. */
  async sessionExists(sessionIdText: string): Promise<boolean> {
    const sessionId = SessionId(sessionIdText)
    if (this.ctx.sessions.get(sessionId) !== undefined || this.ctx.agents.get(sessionId) !== undefined) return true
    const response = await this.ctx.apiProxy.sessions.models({
      rpcId: rpcId('session-existence'),
      payload: { sessionId },
    })
    if (response.result.ok) return true
    if (response.result.error.code === 'session-not-found') return false
    throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
  }

  /** Stop public DSH work that can outlive the parent Agent's own idle state. */
  private async drainExecutionTree(agent: Agent, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('DSH cancelled execution-tree quiescence')
    await this.ctx.subagents.drainContinuableDescendants([agent])
    if (signal.aborted) throw new Error('DSH cancelled execution-tree quiescence')
    const jobs = this.ctx.jobs.list(agent)
    for (const job of jobs) {
      if (job.status === 'running') this.ctx.jobs.kill(job.id, agent, 'Forgeyard is entering a trusted review boundary')
    }
    for (const job of jobs) {
      if (job.status !== 'running' && job.status !== 'stopping') continue
      const settled = await this.ctx.jobs.wait(job.id, 30_000, agent, signal)
      if (settled.status === 'running' || settled.status === 'stopping') {
        throw new Error(`DSH background job ${job.id} did not quiesce before trusted review`)
      }
    }
    if (signal.aborted) throw new Error('DSH cancelled execution-tree quiescence')
  }

  async runMaintenance<T>(sessionIdText: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const agent = await this.liveAgent(SessionId(sessionIdText))
    return agent.runMaintenance(async (signal) => {
      await this.drainExecutionTree(agent, signal)
      return task(signal)
    })
  }

  async runTerminalMaintenance<T>(sessionIdText: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const agent = await this.liveAgent(SessionId(sessionIdText))
    // Public cancel clears the active turn and pending inbox work by default.
    // whenIdle establishes the whole-Agent drain boundary before maintenance.
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    try {
      return await agent.runMaintenance(async (signal) => {
        await this.drainExecutionTree(agent, signal)
        return task(signal)
      })
    } finally {
      // Input that raced the maintenance claim is queued behind it. Cancel and
      // drain once more so a terminal Forgeyard transition returns quiescent.
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      // A queued turn can win the narrow release-to-cancel window and publish
      // detached work. Reclaim maintenance and drain that complete public tree.
      await agent.runMaintenance(signal => this.drainExecutionTree(agent, signal))
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
    }
  }
}
