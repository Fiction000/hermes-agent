import {
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'

import { SESSION_WORKSPACE_LOCALES } from './i18n'
import { SessionWorkspacePage } from './page'
import { bindSessionWorkspaceStorage } from './state'

const plugin: HermesPlugin = {
  id: 'session-workspace',
  name: 'Session Workspace',
  description: 'An opt-in roster and four independent live session chats.',
  defaultEnabled: false,
  register(ctx) {
    ctx.i18n.register(SESSION_WORKSPACE_LOCALES)
    ctx.onDispose(bindSessionWorkspaceStorage(ctx.storage))

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/session-workspace' } satisfies RouteContribution,
      render: () => <SessionWorkspacePage />
    })

    const registerLabels = () =>
      ctx.registerMany([
        {
          id: 'nav',
          area: SIDEBAR_NAV_AREA,
          order: 48,
          data: {
            codicon: 'layout',
            label: ctx.i18n.t('nav'),
            path: '/session-workspace'
          } satisfies SidebarNavContribution
        },
        {
          id: 'open',
          area: PALETTE_AREA,
          data: {
            id: 'session-workspace.open',
            label: ctx.i18n.t('openCommand'),
            keywords: ['sessions', 'workspace', 'multi-session', 'grid'],
            run: () => host.navigate('/session-workspace')
          } satisfies PaletteContribution
        }
      ])

    let disposeLabels = registerLabels()

    const stopLocaleListener = ctx.i18n.onLocaleChange(() => {
      disposeLabels()
      disposeLabels = registerLabels()
    })

    ctx.onDispose(() => {
      stopLocaleListener()
      disposeLabels()
    })
  }
}

export default plugin
