import { atom } from 'nanostores'

import type { PluginStorage } from '@/contrib/plugin'
import type { SessionOwnerRoute } from '@/store/session-request-router'
import { $sessionWorkspaceActive } from '@/store/session-workspace'

import { addWorkspaceSession, sameWorkspaceSession, type WorkspaceSessionKey } from './model'

export type WorkspaceLayout = 'focus' | 'grid'

export const $sessionWorkspaceSelection = atom<WorkspaceSessionKey[]>([])
export const $sessionWorkspaceLayout = atom<WorkspaceLayout>('grid')
export const $sessionWorkspaceFocused = atom<WorkspaceSessionKey | null>(null)

const STORAGE_SELECTION = 'selection.v1'
const STORAGE_LAYOUT = 'layout.v1'
const STORAGE_FOCUS = 'focus.v1'

function isOwnerRoute(value: unknown): value is SessionOwnerRoute {
  if (!value || typeof value !== 'object') {return false}
  const route = value as Partial<SessionOwnerRoute>

  return typeof route.connectionId === 'string' && Boolean(route.connectionId) && typeof route.profile === 'string'
}

function parseKey(value: unknown): WorkspaceSessionKey | null {
  if (!value || typeof value !== 'object') {return null}
  const candidate = value as Partial<WorkspaceSessionKey>

  if (typeof candidate.storedSessionId !== 'string' || !candidate.storedSessionId || !isOwnerRoute(candidate.ownerRoute)) {return null}
  const { connectionId, profile, mode, targetProfile } = candidate.ownerRoute

  return {
    storedSessionId: candidate.storedSessionId,
    ownerRoute: {
      connectionId,
      profile,
      ...(mode === 'local' || mode === 'remote' ? { mode } : {}),
      ...(typeof targetProfile === 'string' ? { targetProfile } : {})
    }
  }
}

function parseSelection(value: unknown): WorkspaceSessionKey[] {
  if (!Array.isArray(value)) {return []}

  return value.reduce<WorkspaceSessionKey[]>((selected, item) => {
    const key = parseKey(item)

    return key ? addWorkspaceSession(selected, key) : selected
  }, [])
}

function read<T>(storage: PluginStorage, key: string, fallback: T): T {
  try {
    return storage.get(key, fallback)
  } catch (error) {
    console.warn('[session-workspace] Could not read saved workspace state', error)

    return fallback
  }
}

function write(storage: PluginStorage, key: string, value: unknown): void {
  try {
    storage.set(key, value)
  } catch (error) {
    console.warn('[session-workspace] Could not save workspace state', error)
  }
}

let unbindCurrent: (() => void) | undefined

export function bindSessionWorkspaceStorage(storage: PluginStorage): () => void {
  unbindCurrent?.()
  $sessionWorkspaceActive.set(false)
  $sessionWorkspaceSelection.set(parseSelection(read(storage, STORAGE_SELECTION, [])))

  const savedLayout = read<unknown>(storage, STORAGE_LAYOUT, 'grid')
  $sessionWorkspaceLayout.set(savedLayout === 'focus' ? 'focus' : 'grid')
  $sessionWorkspaceFocused.set(parseKey(read(storage, STORAGE_FOCUS, null)))

  const offSelection = $sessionWorkspaceSelection.listen(value => write(storage, STORAGE_SELECTION, value))
  const offLayout = $sessionWorkspaceLayout.listen(value => write(storage, STORAGE_LAYOUT, value))
  const offFocus = $sessionWorkspaceFocused.listen(value => write(storage, STORAGE_FOCUS, value))

  let disposed = false

  const unbind = () => {
    if (disposed) {return}
    disposed = true
    offSelection()
    offLayout()
    offFocus()
    $sessionWorkspaceActive.set(false)

    if (unbindCurrent === unbind) {unbindCurrent = undefined}
  }

  unbindCurrent = unbind

  return unbind
}

export function setSessionWorkspaceSelection(selection: WorkspaceSessionKey[]): void {
  $sessionWorkspaceSelection.set(parseSelection(selection))
  const focused = $sessionWorkspaceFocused.get()

  if (focused && !$sessionWorkspaceSelection.get().some(key => sameWorkspaceSession(key, focused))) {
    $sessionWorkspaceFocused.set($sessionWorkspaceSelection.get()[0] ?? null)
  }
}

export function setSessionWorkspaceLayout(layout: WorkspaceLayout): void {
  $sessionWorkspaceLayout.set(layout)
}

export function setSessionWorkspaceFocused(key: WorkspaceSessionKey | null): void {
  $sessionWorkspaceFocused.set(parseKey(key))
}
