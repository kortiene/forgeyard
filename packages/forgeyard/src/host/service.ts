import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AttemptId,
  AttemptSessionRef,
  AttemptView,
  DecisionRequest,
  ForgeyardResult,
  ForgeyardSnapshot,
  MissionCreateRequest,
  MissionView,
  RetryRequest,
  TaskId,
} from '../types.ts'
import { installForgeyardAgentAuthority } from './agent-authority.ts'
import { ForgeyardEngine, ForgeyardDomainError } from './engine.ts'
import { TrustedEvidenceCollector } from './evidence.ts'
import { DshSessionGateway } from './execution.ts'
import { GitAuthority } from './git.ts'
import { DshProcessRunner } from './process.ts'
import { ForgeyardStore } from './store.ts'
import { DshVerifierConfinement } from './verifier.ts'

export interface Config {
  databasePath: string
  worktreeRoot: string
  allowedRepositoryRoots: string[]
  defaultProvider: string
  defaultModel: string
  defaultReasoningEffort: string
  defaultAgentPreset: string
  defaultPermissionPreset: string
  verifierTimeoutMs: number
  gitTimeoutMs: number
  outputLimitBytes: number
  spillLimitBytes: number
  diffLimitBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    forgeyard: ForgeyardService
  }
}

/** One Host service owns persistence, Git authority, DSH admission, and Remotes. */
export class ForgeyardService extends TypertRemoteService {
  static inject = [
    'agents',
    'agentPresets',
    'apiProxy',
    'jobs',
    'permissionPresets',
    'sandbox',
    'sandboxPolicy',
    'sessions',
    'subprocess',
    'subagents',
    'tools',
  ]

  static Config: s<Config> = s.object({
    databasePath: s.string().required(),
    worktreeRoot: s.string().required(),
    allowedRepositoryRoots: s.array(s.string()).required(),
    defaultProvider: s.string().required(),
    defaultModel: s.string().required(),
    defaultReasoningEffort: s.string().required(),
    defaultAgentPreset: s.string().required(),
    defaultPermissionPreset: s.string().required(),
    verifierTimeoutMs: s.number().step(1).min(1).required(),
    gitTimeoutMs: s.number().step(1).min(1).required(),
    outputLimitBytes: s.number().step(1).min(1).required(),
    spillLimitBytes: s.number().step(1).min(1).required(),
    diffLimitBytes: s.number().step(1).min(1).required(),
  })

  private engine?: ForgeyardEngine

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'forgeyard')
  }

  protected [Service.init](): void {
    if (this.config.allowedRepositoryRoots.length === 0) {
      throw new Error('Forgeyard requires an explicit non-empty operator repository allowlist')
    }
    const store = new ForgeyardStore(this.config.databasePath)
    const processRunner = new DshProcessRunner(this.ctx.subprocess)
    const git = new GitAuthority(processRunner, {
      allowedRepositoryRoots: this.config.allowedRepositoryRoots,
      worktreeRoot: this.config.worktreeRoot,
      commandTimeoutMs: this.config.gitTimeoutMs,
      captureBytes: this.config.outputLimitBytes,
      spillBytes: this.config.spillLimitBytes,
      reviewDiffBytes: this.config.diffLimitBytes,
    })
    const gateway = new DshSessionGateway(this.ctx, {
      provider: this.config.defaultProvider,
      model: this.config.defaultModel,
      reasoningEffort: this.config.defaultReasoningEffort || null,
      agentPreset: this.config.defaultAgentPreset || null,
      permissionPreset: this.config.defaultPermissionPreset,
    })
    const collector = new TrustedEvidenceCollector(processRunner, git, {
      commandTimeoutMs: this.config.verifierTimeoutMs,
      outputBytes: this.config.outputLimitBytes,
      spillBytes: this.config.spillLimitBytes,
    }, new DshVerifierConfinement(this.ctx))
    this.engine = new ForgeyardEngine(store, git, gateway, collector, { dshVersion: '0.1.1-rc.2' })

    const recovered = this.engine.recoverAfterRestart()
    if (recovered > 0) this.ctx.logger.warn(`forgeyard: marked ${recovered} uncertain Attempt(s) needs_review after Host restart`)
    installForgeyardAgentAuthority(this.ctx, store, gateway)
    this.ctx.effect(() => () => store.close(), 'forgeyard.sqlite.close')
  }

  private requireEngine(): ForgeyardEngine {
    if (this.engine === undefined) throw new Error('Forgeyard service has not initialized')
    return this.engine
  }

  private async result<T>(operation: () => Promise<T> | T): Promise<ForgeyardResult<T>> {
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      if (error instanceof ForgeyardDomainError) return { ok: false, error: { code: error.code, message: error.message } }
      this.ctx.logger.error(error)
      return { ok: false, error: { code: 'INTERNAL', message: 'Forgeyard could not complete the operation. Inspect Host logs.' } }
    }
  }

  @Remote('snapshot')
  snapshot(): Promise<ForgeyardResult<ForgeyardSnapshot>> {
    return this.result(() => this.requireEngine().snapshot())
  }

  @Remote('createMission')
  createMission(request: MissionCreateRequest): Promise<ForgeyardResult<MissionView>> {
    return this.result(() => this.requireEngine().createMission(request))
  }

  @Remote('startAttempt')
  startAttempt(taskId: TaskId): Promise<ForgeyardResult<AttemptView>> {
    return this.result(() => this.requireEngine().startAttempt(taskId))
  }

  @Remote('verifyAttempt')
  verifyAttempt(attemptId: AttemptId): Promise<ForgeyardResult<AttemptView>> {
    return this.result(() => this.requireEngine().verifyAttempt(attemptId))
  }

  @Remote('decide')
  decide(request: DecisionRequest): Promise<ForgeyardResult<AttemptView>> {
    return this.result(() => this.requireEngine().decide(request))
  }

  @Remote('retry')
  retry(request: RetryRequest): Promise<ForgeyardResult<AttemptView>> {
    return this.result(() => this.requireEngine().retry(request))
  }

  @Remote('attemptForSession')
  attemptForSession(sessionId: string): Promise<ForgeyardResult<AttemptSessionRef | null>> {
    return this.result(() => this.requireEngine().attemptForSession(sessionId))
  }
}

export default ForgeyardService
