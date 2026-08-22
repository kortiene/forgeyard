import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AttemptRecord } from '../types.ts'

export interface VerifierConfinementResult {
  argv: readonly string[]
  mode: 'read-only' | 'workspace-write'
  enforcement: 'full'
  workspaceRoot: string
}

export interface VerifierConfinement {
  confine(attempt: AttemptRecord, argv: readonly string[]): Promise<VerifierConfinementResult> | VerifierConfinementResult
}

/** Bind verifier execution to the frozen DSH Session policy and exact Attempt cwd. */
export class DshVerifierConfinement implements VerifierConfinement {
  constructor(private readonly ctx: Context) {}

  confine(attempt: AttemptRecord, argv: readonly string[]): VerifierConfinementResult {
    const ctx = this.ctx
    const session = ctx.sessions.get(SessionId(attempt.dshSessionId))
    if (session === undefined) throw new Error('the native DSH Session is not live; verifier execution was refused')
    if (session.header.cwd !== attempt.worktreePath) throw new Error('the DSH Session cwd no longer matches the Attempt worktree')
    const frozen = attempt.executionSnapshot.policy
    const permission = ctx.permissionPresets.resolve(frozen.permissionPreset)
    if (
      ctx.permissionPresets.current(session.events) !== frozen.permissionPreset
      || permission.sandbox !== frozen.sandboxMode
      || permission.approval !== frozen.approvalPolicy
    ) {
      throw new Error('the DSH Session permission preset no longer matches the frozen sandbox/approval policy')
    }
    const mode = attempt.executionSnapshot.policy.sandboxMode
    if (mode !== 'read-only' && mode !== 'workspace-write') {
      throw new Error(`verifier execution refuses non-confined DSH sandbox mode: ${mode}`)
    }
    const policy = ctx.sandboxPolicy.resolve({ session, mode })
    if (policy.mode !== mode || policy.workspaceRoot !== attempt.worktreePath) {
      throw new Error('DSH resolved a verifier sandbox outside the frozen Attempt authority')
    }
    const confined = ctx.sandbox.confine(argv, {
      mode,
      workspaceRoot: policy.workspaceRoot,
      ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId }),
    })
    if (confined.enforcement !== 'full') {
      throw new Error('DSH reported only partial verifier sandbox enforcement')
    }
    return { argv: confined.argv, mode, enforcement: 'full', workspaceRoot: policy.workspaceRoot }
  }
}
