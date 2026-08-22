import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { DshSessionGateway } from './execution.ts'
import type { ForgeyardStore } from './store.ts'

/** Install the public DSH Agent publication and terminal-step authority edges. */
export function installForgeyardAgentAuthority(
  ctx: Context,
  store: ForgeyardStore,
  gateway: DshSessionGateway,
): void {
  // Fresh Session creation publishes its Agent before the public permission
  // preset setter can run, so createAndPrompt installs the frozen guards at
  // that boundary. Every later/cold Agent publication is guarded
  // synchronously here; a thrown mismatch vetoes registry publication.
  ctx.on('agent/created', ({ agent }) => {
    const attempt = store.attemptBySession(String(agent.id))
    if (attempt === undefined || attempt.state === 'worktree_ready' || attempt.state === 'needs_review') return
    gateway.installPolicyGuards(agent, attempt.executionSnapshot)
  })

  // DSH rc.2 has no observer-side Session seal. SQLite terminal authority
  // therefore owns a global public pre-step rejection for every later resume.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const attempt = store.attemptBySession(String(agent.id))
    if (attempt !== undefined && (store.isTerminal(attempt.state) || attempt.state === 'needs_review')) return { kind: 'reject' }
    return next()
  }, { prepend: true })

  // Service/plugin load order may leave a persisted Agent live before this
  // listener is registered. Guard that complete public registry snapshot too.
  for (const agent of ctx.agents.list()) {
    const attempt = store.attemptBySession(String(agent.id))
    if (attempt !== undefined && attempt.state !== 'needs_review') {
      gateway.installPolicyGuards(agent, attempt.executionSnapshot)
    }
  }
}
