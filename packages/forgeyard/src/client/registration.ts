import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  ForgeyardFooterAction,
  ForgeyardOverlay,
  ForgeyardReturnAction,
} from './components.tsx'
import type { ForgeyardCockpitController } from './controller.ts'

export const FORGEYARD_SLOT_ENTRIES = {
  footer: { name: 'sidebar.footer.action', id: 'forgeyard', order: 30 },
  overlay: { name: 'shell.overlay', id: 'forgeyard-overlay', order: 30 },
  returnAction: {
    name: 'conversation.session.header.actions',
    id: 'forgeyard-return',
    order: 30,
  },
} as const

/** Register all three additive client surfaces against their declaration lifetimes. */
export function registerForgeyardCockpit(
  ctx: ClientContext,
  cockpit: ForgeyardCockpitController,
): void {
  ctx.slots.inject(FORGEYARD_SLOT_ENTRIES.footer.name, () =>
    ctx.slots.register({
      ...FORGEYARD_SLOT_ENTRIES.footer,
      inject: () => ({
        cockpit,
        hooks: { cockpit },
      }),
    }, ForgeyardFooterAction),
  )

  ctx.slots.inject(FORGEYARD_SLOT_ENTRIES.overlay.name, () =>
    ctx.slots.register({
      ...FORGEYARD_SLOT_ENTRIES.overlay,
      inject: () => ({
        cockpit,
        hooks: { cockpit },
      }),
    }, ForgeyardOverlay),
  )

  ctx.slots.inject(FORGEYARD_SLOT_ENTRIES.returnAction.name, () =>
    ctx.slots.register({
      ...FORGEYARD_SLOT_ENTRIES.returnAction,
      inject: (sessionId: SessionId) => ({
        cockpit,
        hooks: { cockpit },
        returnToAttempt: () => { void cockpit.returnToAttempt(sessionId) },
      }),
    }, ForgeyardReturnAction),
  )
}
