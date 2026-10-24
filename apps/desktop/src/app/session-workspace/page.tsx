import './session-workspace.css'

import { useStore } from '@nanostores/react'
import { useLayoutEffect, useMemo, useState } from 'react'

import { SessionStatusDot } from '@/app/chat/session-status-dot'
import { SessionTilePane } from '@/app/chat/session-tile'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { usePluginI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import {
  $cronSessions,
  $messagingSessions,
  $selectedStoredSessionId,
  $sessions,
  $sessionsLoadError,
  $sessionsLoading,
  lineageAliases
} from '@/store/session'
import { $sessionDotStateById, type SessionDotState } from '@/store/session-dot-state'
import type { SessionOwnerRoute } from '@/store/session-request-router'
import { $sessionTiles, knownOwnerForSession, openSessionTile, setSessionTileWorkspaceScope } from '@/store/session-states'
import { $sessionWorkspaceActive } from '@/store/session-workspace'
import type { SessionInfo } from '@/types/hermes'

import {
  addWorkspaceSession,
  sameWorkspaceSession,
  selectedWorkspaceTiles,
  WORKSPACE_MAX_SESSIONS,
  workspaceOwnerRouteForRow,
  type WorkspaceSessionKey,
  workspaceTileScope
} from './model'
import {
  $sessionWorkspaceFocused,
  $sessionWorkspaceLayout,
  $sessionWorkspaceSelection,
  setSessionWorkspaceFocused,
  setSessionWorkspaceLayout,
  setSessionWorkspaceSelection,
  type WorkspaceLayout
} from './state'

const STATUS_KEYS: Record<SessionDotState, string> = {
  background: 'status.background',
  draft: 'status.draft',
  idle: 'status.idle',
  'needs-input': 'status.needsInput',
  stalled: 'status.stalled',
  unread: 'status.unread',
  working: 'status.working'
}

interface WorkspaceRow {
  key: string
  ownerRoute?: SessionOwnerRoute
  row: SessionInfo
}

function identityKey(storedSessionId: string, route?: SessionOwnerRoute): string {
  return JSON.stringify([
    storedSessionId,
    route?.connectionId ?? '',
    route?.profile ?? '',
    route?.targetProfile ?? route?.profile ?? ''
  ])
}

function resolveRows(rows: SessionInfo[]): WorkspaceRow[] {
  const seen = new Set<string>()

  return rows.flatMap((row, index) => {
    const ownerRoute = workspaceOwnerRouteForRow(row, rows, knownOwnerForSession)
    const identity = ownerRoute ? identityKey(row.id, ownerRoute) : JSON.stringify([row.id, 'unresolved', row.profile ?? '', index])

    if (seen.has(identity)) {
      return []
    }

    seen.add(identity)

    // Keep the visible row even when its owner is unresolved. The picker will
    // explain why it cannot be opened rather than routing it through ambient state.
    return [{ key: identity, ownerRoute, row }]
  })
}

function statusFor(row: SessionInfo, statuses: Readonly<Record<string, SessionDotState>>): SessionDotState {
  return statuses[row.id] ?? 'idle'
}

function titleFor(row: SessionInfo): string {
  return sessionTitle(row)
}

function WorkspaceSlot({
  onRemove,
  onShowPicker,
  route,
  session,
  title,
  missing,
  showFocus,
  t
}: {
  onRemove?: () => void
  onShowPicker: () => void
  route?: SessionOwnerRoute
  session?: WorkspaceSessionKey
  title?: string
  missing?: boolean
  showFocus?: boolean
  t: ReturnType<typeof usePluginI18n>
}) {
  if (!session || missing) {
    return (
      <div className="session-workspace-card flex min-h-[17rem] min-w-0 flex-col items-center justify-center gap-3 rounded-[0.625rem] border border-dashed border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-6 text-center">
        <span aria-hidden className="grid size-9 place-items-center rounded-full bg-(--ui-bg-quaternary) text-lg text-(--ui-text-tertiary)">
          +
        </span>
        <div className="max-w-[24rem] space-y-1">
          <p className="text-sm font-medium text-(--ui-text-primary)">
            {missing ? t('page.missingPane') : t('page.emptyTitle')}
          </p>
          {!missing ? <p className="text-xs text-(--ui-text-tertiary)">{t('page.emptyBody')}</p> : null}
        </div>
        {missing ? (
          <Button onClick={onRemove} size="sm" type="button" variant="outline">
            {t('page.remove', title ?? '')}
          </Button>
        ) : (
          <Button onClick={onShowPicker} size="sm" type="button" variant="secondary">
            {t('page.addSession')}
          </Button>
        )}
      </div>
    )
  }

  const visibleTitle = title ?? session.storedSessionId

  return (
    <section
      aria-label={visibleTitle}
      className="session-workspace-card flex min-h-[17rem] min-w-0 flex-col overflow-hidden rounded-[0.625rem] border border-(--ui-stroke-secondary) bg-(--ui-bg-chrome)"
    >
      <header className="flex min-w-0 items-center justify-between gap-3 border-b border-(--ui-stroke-secondary) px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <SessionStatusDot className="shrink-0" session={undefined} storedSessionId={session.storedSessionId} />
          <h2 className="truncate text-sm font-semibold text-(--ui-text-primary)" title={visibleTitle}>
            {visibleTitle}
          </h2>
          {route ? (
            <span className="session-workspace-status hidden shrink-0 truncate text-[0.6875rem] text-(--ui-text-tertiary) 2xl:inline" title={`${route.profile} · ${route.connectionId}`}>
              {route.profile}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showFocus ? (
            <Button
              aria-label={t('page.focus')}
              onClick={() => {
                setSessionWorkspaceFocused(session)
                setSessionWorkspaceLayout('focus')
              }}
              size="xs"
              type="button"
              variant="ghost"
            >
              {t('page.focus')}
            </Button>
          ) : null}
          <Button
            aria-label={t('page.remove', visibleTitle)}
            onClick={onRemove}
            size="icon-xs"
            title={t('page.remove', visibleTitle)}
            type="button"
            variant="ghost"
          >
            <span aria-hidden>×</span>
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SessionTilePane storedSessionId={session.storedSessionId} />
      </div>
    </section>
  )
}

export function SessionWorkspacePage() {
  const t = usePluginI18n('session-workspace')
  const active = useStore($sessionWorkspaceActive)
  const sessions = useStore($sessions)
  const cronSessions = useStore($cronSessions)
  const messagingSessions = useStore($messagingSessions)
  const sessionsLoading = useStore($sessionsLoading)
  const sessionsLoadError = useStore($sessionsLoadError)
  const statuses = useStore($sessionDotStateById)
  const tiles = useStore($sessionTiles)
  const selected = useStore($sessionWorkspaceSelection)
  const layout = useStore($sessionWorkspaceLayout)
  const focused = useStore($sessionWorkspaceFocused)
  const mainSessionId = useStore($selectedStoredSessionId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')

  // Hide the legacy tile pane contributions before mounting their replacement
  // surfaces here; each session retains exactly one live composer instance.
  useLayoutEffect(() => {
    $sessionWorkspaceActive.set(true)

    return () => $sessionWorkspaceActive.set(false)
  }, [])

  const sourceRows = useMemo(() => [...sessions, ...cronSessions, ...messagingSessions], [cronSessions, messagingSessions, sessions])

  const rows = resolveRows(sourceRows)
  const selectedTiles = useMemo(() => selectedWorkspaceTiles(tiles, selected), [selected, tiles])

  const rowForKey = (key: WorkspaceSessionKey) =>
    rows.find(candidate => candidate.row.id === key.storedSessionId && candidate.ownerRoute && sameWorkspaceSession(key, { storedSessionId: candidate.row.id, ownerRoute: candidate.ownerRoute }))

  const matchingSessions = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()

    if (!query) {return rows}

    return rows.filter(({ ownerRoute, row }) =>
      [titleFor(row), row.id, row.profile ?? '', ownerRoute?.connectionId ?? '']
        .join(' ')
        .toLocaleLowerCase()
        .includes(query)
    )
  }, [rows, search])

  const focusedKey = selected.find(key => focused && sameWorkspaceSession(key, focused)) ?? selected[0] ?? null

  function openPicker() {
    setSearch('')
    setPickerOpen(true)
  }

  function removeSession(key: WorkspaceSessionKey) {
    const next = $sessionWorkspaceSelection.get().filter(candidate => !sameWorkspaceSession(candidate, key))
    setSessionWorkspaceSelection(next)

    if (next.length === 0) {
      setSessionWorkspaceFocused(null)
    }
  }

  function changeLayout(next: WorkspaceLayout) {
    if (next === 'focus' && selected.length > 0) {
      const nextFocus = selected.find(key => focused && sameWorkspaceSession(key, focused)) ?? selected[0]
      setSessionWorkspaceFocused(nextFocus)
    }

    setSessionWorkspaceLayout(next)
  }

  function addSession(candidate: WorkspaceRow) {
    const ownerRoute = candidate.ownerRoute

    if (!ownerRoute) {return}

    const key: WorkspaceSessionKey = { storedSessionId: candidate.row.id, ownerRoute }
    const current = $sessionWorkspaceSelection.get()
    const next = addWorkspaceSession(current, key)

    if (next.length === current.length && !current.some(item => sameWorkspaceSession(item, key))) {return}

    const aliases = lineageAliases(candidate.row.id, $sessions.get())
    const mainId = $selectedStoredSessionId.get()

    if (mainId && aliases.includes(mainId)) {return}

    const existingTile = $sessionTiles.get().find(tile => tile.storedSessionId === key.storedSessionId)
    const aliasTile = $sessionTiles.get().find(tile => aliases.includes(tile.storedSessionId) && tile.storedSessionId !== key.storedSessionId)

    if (aliasTile) {return}

    if (existingTile) {
      if (!existingTile.ownerRoute || !sameWorkspaceSession(key, { storedSessionId: existingTile.storedSessionId, ownerRoute: existingTile.ownerRoute })) {return}
      setSessionTileWorkspaceScope(key.storedSessionId, workspaceTileScope(key))
    } else {
      openSessionTile(key.storedSessionId, 'right', 'workspace', undefined, workspaceTileScope(key))
    }

    setSessionWorkspaceSelection(next)

    if (!focused || !next.some(item => sameWorkspaceSession(item, focused))) {
      setSessionWorkspaceFocused(key)
    }

    setPickerOpen(false)
  }

  function tileFor(key: WorkspaceSessionKey) {
    return selectedTiles.find(tile => tile.storedSessionId === key.storedSessionId && tile.ownerRoute && sameWorkspaceSession(key, { storedSessionId: tile.storedSessionId, ownerRoute: tile.ownerRoute }))
  }

  function canOpen(candidate: WorkspaceRow): { reason: string; disabled: boolean } {
    const ownerRoute = candidate.ownerRoute
    const key = ownerRoute ? { storedSessionId: candidate.row.id, ownerRoute } : null
    const inWorkspace = Boolean(key && selected.some(item => sameWorkspaceSession(item, key)))
    const mainAliases = lineageAliases(candidate.row.id, sessions)
    const inMain = Boolean(mainSessionId && mainAliases.includes(mainSessionId))
    const existingTile = tiles.find(tile => tile.storedSessionId === candidate.row.id)
    const aliasTile = tiles.find(tile => mainAliases.includes(tile.storedSessionId) && tile.storedSessionId !== candidate.row.id)
    const routeConflict = Boolean(existingTile && (!existingTile.ownerRoute || !key || !sameWorkspaceSession(key, { storedSessionId: existingTile.storedSessionId, ownerRoute: existingTile.ownerRoute })))
    const full = !inWorkspace && selected.length >= WORKSPACE_MAX_SESSIONS

    const reason = inWorkspace
      ? t('picker.inWorkspace')
      : inMain
        ? t('picker.inMain')
        : routeConflict
          ? t('picker.routeConflict')
          : aliasTile
            ? t('picker.aliasConflict')
            : !ownerRoute
              ? t('picker.ownerUnavailable')
              : full
                ? t('picker.limit')
                : ''

    return { reason, disabled: inWorkspace || inMain || routeConflict || Boolean(aliasTile) || !ownerRoute || full }
  }

  const renderSlot = (key: WorkspaceSessionKey | null, index: number) => {
    if (!key) {
      return <WorkspaceSlot key={`empty-${index}`} onShowPicker={openPicker} t={t} />
    }

    const tile = tileFor(key)
    const row = rowForKey(key)
    const title = row ? titleFor(row.row) : key.storedSessionId

    return (
      <WorkspaceSlot
        key={identityKey(key.storedSessionId, key.ownerRoute)}
        missing={!tile}
        onRemove={() => removeSession(key)}
        onShowPicker={openPicker}
        route={key.ownerRoute}
        session={key}
        showFocus={layout === 'grid'}
        t={t}
        title={title}
      />
    )
  }

  if (!active) {
    return <div aria-busy="true" className="grid h-full min-h-0 place-items-center text-xs text-(--ui-text-tertiary)">{t('page.loading')}</div>
  }

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden p-4 xl:gap-4 xl:p-5">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-(--ui-text-primary)">{t('page.title')}</h1>
          <p className="mt-0.5 text-xs text-(--ui-text-tertiary)">{t('page.selectedCount', selected.length, WORKSPACE_MAX_SESSIONS)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={openPicker} size="sm" type="button" variant="default">
            <span aria-hidden>＋</span>
            {t('page.addSession')}
          </Button>
          <div aria-label={t('page.layout')} className="flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5" role="group">
            <Button
              aria-pressed={layout === 'grid'}
              onClick={() => changeLayout('grid')}
              size="sm"
              type="button"
              variant={layout === 'grid' ? 'secondary' : 'ghost'}
            >
              {t('page.grid')}
            </Button>
            <Button
              aria-pressed={layout === 'focus'}
              disabled={selected.length === 0}
              onClick={() => changeLayout('focus')}
              size="sm"
              type="button"
              variant={layout === 'focus' ? 'secondary' : 'ghost'}
            >
              {t('page.focus')}
            </Button>
          </div>
        </div>
      </header>

      {sessionsLoadError && sourceRows.length > 0 ? (
        <p className="shrink-0 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) px-3 py-2 text-xs text-(--ui-text-secondary)" role="status">
          {t('page.loadError')}
        </p>
      ) : null}

      {selected.length === 0 ? (
        <section className="grid min-h-0 flex-1 place-items-center overflow-auto rounded-lg border border-dashed border-(--ui-stroke-secondary) bg-(--ui-bg-chrome) p-6 text-center">
          <div className="space-y-2">
            <span aria-hidden className="mx-auto grid size-10 place-items-center rounded-full bg-(--ui-bg-quaternary) text-xl text-(--ui-text-tertiary)">＋</span>
            <h2 className="text-sm font-medium text-(--ui-text-primary)" role={sessionsLoadError && sourceRows.length === 0 ? 'alert' : undefined}>{sessionsLoadError ? t('page.loadError') : sessionsLoading ? t('page.loading') : sourceRows.length === 0 ? t('page.noSessions') : t('page.emptyTitle')}</h2>
            {!sessionsLoading && !sessionsLoadError && sourceRows.length > 0 ? <p className="text-xs text-(--ui-text-tertiary)">{t('page.emptyBody')}</p> : null}
            {!sessionsLoadError && !sessionsLoading ? (
              <Button onClick={openPicker} size="sm" type="button" variant="secondary">{t('page.addSession')}</Button>
            ) : null}
          </div>
        </section>
      ) : (
        <div className={`session-workspace-grid grid min-h-0 flex-1 gap-3 overflow-y-auto pr-1 xl:overflow-hidden ${layout === 'grid' ? 'grid-cols-1 auto-rows-[minmax(17rem,auto)] xl:grid-cols-2 xl:grid-rows-[repeat(2,minmax(0,1fr))] xl:auto-rows-auto' : 'grid-cols-1 grid-rows-1'}`}>
          {layout === 'grid'
            ? Array.from({ length: WORKSPACE_MAX_SESSIONS }, (_, index) => renderSlot(selected[index] ?? null, index))
            : renderSlot(focusedKey, 0)}
        </div>
      )}

      <Dialog
        onOpenChange={open => {
          setPickerOpen(open)

          if (!open) {setSearch('')}
        }}
        open={pickerOpen}
      >
        <DialogContent bodyClassName="gap-0 overflow-hidden p-0" className="w-[min(44rem,calc(100vw-2rem))] max-w-none">
          <div className="space-y-3 p-4 pb-3">
            <DialogHeader>
              <DialogTitle>{t('picker.title')}</DialogTitle>
              <DialogDescription>{t('picker.description')}</DialogDescription>
            </DialogHeader>
            <Input
              aria-label={t('picker.search')}
              autoComplete="off"
              onChange={event => setSearch(event.currentTarget.value)}
              placeholder={t('picker.search')}
              type="search"
              value={search}
            />
          </div>
          <div className="max-h-[62vh] min-h-24 overflow-y-auto border-t border-(--ui-stroke-secondary)">
            {sessionsLoading && sourceRows.length === 0 ? (
              <p aria-live="polite" className="p-4 text-sm text-(--ui-text-tertiary)">{t('page.loading')}</p>
            ) : sessionsLoadError && sourceRows.length === 0 ? (
              <p aria-live="assertive" className="p-4 text-sm text-destructive">{t('page.loadError')}</p>
            ) : rows.length === 0 ? (
              <p className="p-4 text-sm text-(--ui-text-tertiary)">{t('page.noSessions')}</p>
            ) : matchingSessions.length === 0 ? (
              <p className="p-4 text-sm text-(--ui-text-tertiary)">{t('page.noMatches')}</p>
            ) : (
              <ul className="divide-y divide-(--ui-stroke-secondary)">
                {matchingSessions.map(candidate => {
                  const title = titleFor(candidate.row)
                  const { disabled, reason } = canOpen(candidate)
                  const state = statusFor(candidate.row, statuses)

                  return (
                    <li key={candidate.key}>
                      <button
                        aria-label={reason ? `${title} — ${reason}` : t('picker.addAria', title)}
                        className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-(--chrome-action-hover) focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-55"
                        disabled={disabled}
                        onClick={() => addSession(candidate)}
                        title={candidate.ownerRoute ? `${candidate.ownerRoute.profile} · ${candidate.ownerRoute.connectionId}` : t('picker.ownerUnavailable')}
                        type="button"
                      >
                        <SessionStatusDot className="shrink-0" session={candidate.row} storedSessionId={candidate.row.id} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-(--ui-text-primary)">{title}</span>
                          <span className="block truncate text-xs text-(--ui-text-tertiary)">{t(STATUS_KEYS[state])}</span>
                        </span>
                        {reason ? <span className="max-w-44 shrink-0 truncate text-xs text-(--ui-text-tertiary)">{reason}</span> : <span className="shrink-0 text-xs text-(--ui-text-secondary)">{t('picker.add')}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
