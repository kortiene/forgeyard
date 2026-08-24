import forgeyardRemote from 'forgeyard/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
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
import { ForgeyardCockpitController, type ForgeyardClientApi } from './controller.ts'
import { registerForgeyardCockpit } from './registration.ts'

/** Required browser services; package-name graph metadata remains in package.json. */
export const inject = ['remote', 'sessions', 'slots']

/** Mount the generated Host Remote and contribute all Cockpit surfaces. */
export async function apply(ctx: ClientContext): Promise<void> {
  // Mount the generated Forgeyard Remote namespace, then consume it from a child
  // fiber that injects `remote.forgeyard`. DSH guards `ctx.remote.<namespace>`
  // behind an explicit inject (the same rule `ui-plan` obeys with
  // `remote.commands`). The mounting fiber cannot also declare `remote.forgeyard`
  // in its own inject without a load-order deadlock — the namespace does not
  // exist until this mount runs — so the Cockpit lives in a nested plugin whose
  // fiber (and the mount) are torn down with this client context.
  await ctx.remote.$mount(forgeyardRemote)
  ctx.plugin({
    inject: ['remote', 'remote.forgeyard', 'sessions', 'slots'],
    apply(scope) {
      const client = scope as ClientContext
      const cockpit = new ForgeyardCockpitController(remoteApi(client), client.sessions)
      client.effect(() => () => { cockpit.dispose() }, 'forgeyard: client controller')
      registerForgeyardCockpit(client, cockpit)
      void cockpit.refresh()
    },
  })
}

function remoteApi(ctx: ClientContext): ForgeyardClientApi {
  return {
    snapshot: () => unwrap<ForgeyardSnapshot>(ctx.remote.forgeyard.snapshot()),
    createMission: (request: MissionCreateRequest) =>
      unwrap<MissionView>(ctx.remote.forgeyard.createMission(request)),
    startAttempt: (taskId: TaskId) =>
      unwrap<AttemptView>(ctx.remote.forgeyard.startAttempt(taskId)),
    verifyAttempt: (attemptId: AttemptId) =>
      unwrap<AttemptView>(ctx.remote.forgeyard.verifyAttempt(attemptId)),
    decide: (request: DecisionRequest) =>
      unwrap<AttemptView>(ctx.remote.forgeyard.decide(request)),
    retry: (request: RetryRequest) =>
      unwrap<AttemptView>(ctx.remote.forgeyard.retry(request)),
    attemptForSession: (sessionId: string) =>
      unwrap<AttemptSessionRef | null>(ctx.remote.forgeyard.attemptForSession(sessionId)),
  }
}

async function unwrap<T>(
  pending: Promise<RemoteResult<ForgeyardResult<T>>>,
): Promise<T> {
  const transported = await pending
  if (!transported.ok) throw new Error(transported.error.message)
  if (!transported.value.ok) throw new Error(transported.value.error.message)
  return transported.value.value
}

export {
  FORGEYARD_SLOT_ENTRIES,
  registerForgeyardCockpit,
} from './registration.ts'
export { ForgeyardCockpitController } from './controller.ts'
export type { CockpitSnapshot, CockpitView, ForgeyardClientApi } from './controller.ts'
