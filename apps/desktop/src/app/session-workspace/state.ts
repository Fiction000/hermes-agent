import { atom } from 'nanostores'

import type { PluginStorage } from '@/contrib/plugin'
import type { SessionOwnerRoute } from '@/store/session-request-router'
import { $sessionWorkspaceActive } from '@/store/session-workspace'

import { DEFAULT_SPLITS, parseSplits, workspaceOwnerKey, type WorkspaceSplits } from './layout'
import { addWorkspaceSession, sameWorkspaceSession, type WorkspaceSessionKey } from './model'

export type WorkspaceLayout = 'focus' | 'grid' | 'split'
export const $sessionWorkspaceSplits = atom<WorkspaceSplits>(DEFAULT_SPLITS)
let currentStorage: PluginStorage | undefined
const ownerScope = () => JSON.stringify([...new Set($sessionWorkspaceSelection.get().map(key => workspaceOwnerKey(key.ownerRoute)))].sort())
const splitKey = () => `splits.v2.${ownerScope()}`

export function setSessionWorkspaceSplits(value: WorkspaceSplits): void {
  $sessionWorkspaceSplits.set(parseSplits(value))

  if (currentStorage) { write(currentStorage, splitKey(), $sessionWorkspaceSplits.get()) }
}

export const $sessionWorkspaceSelection = atom<WorkspaceSessionKey[]>([])
export const $sessionWorkspaceLayout = atom<WorkspaceLayout>('grid')
export const $sessionWorkspaceFocused = atom<WorkspaceSessionKey | null>(null)
export const $sessionWorkspaceCanRecoverLegacy = atom(false)

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
let recoverableLegacy: WorkspaceSessionKey[] | undefined

export function bindSessionWorkspaceStorage(storage: PluginStorage): () => void {
  unbindCurrent?.()
  $sessionWorkspaceActive.set(false)
  currentStorage = storage
  const savedKey = read<string>(storage, 'arrangement.last.v2', 'arrangement.v2')
  const saved = read<{ selection?: unknown; layout?: unknown; focused?: unknown } | null>(storage, typeof savedKey === 'string' && savedKey.startsWith('arrangement.') ? savedKey : 'arrangement.v2', null)
  const selected = parseSelection(saved?.selection ?? read(storage, STORAGE_SELECTION, []))
  const legacySelection = parseSelection(read(storage, STORAGE_SELECTION, []))
  recoverableLegacy = selected.length === 0 && legacySelection.length > 0 ? legacySelection : undefined
  $sessionWorkspaceCanRecoverLegacy.set(Boolean(recoverableLegacy))
  $sessionWorkspaceSelection.set(selected)

  const savedLayout = saved?.layout ?? read<unknown>(storage, STORAGE_LAYOUT, 'grid')
  $sessionWorkspaceLayout.set(savedLayout === 'focus' || savedLayout === 'split' ? savedLayout : 'grid')
  const restoredFocus = parseKey(saved?.focused ?? read(storage, STORAGE_FOCUS, null))
  $sessionWorkspaceFocused.set($sessionWorkspaceSelection.get().find(key => restoredFocus && sameWorkspaceSession(key, restoredFocus)) ?? $sessionWorkspaceSelection.get()[0] ?? null)
  $sessionWorkspaceSplits.set(parseSplits(read(storage, splitKey(), DEFAULT_SPLITS)))

  const persist = () => {
    const key = `arrangement.v2.${ownerScope()}`
    write(storage, key, { selection: $sessionWorkspaceSelection.get(), layout: $sessionWorkspaceLayout.get(), focused: $sessionWorkspaceFocused.get() })
    write(storage, 'arrangement.last.v2', key)
  }

  const offSelection = $sessionWorkspaceSelection.listen(() => {
    if (recoverableLegacy && $sessionWorkspaceSelection.get().length > 0) {
      recoverableLegacy = undefined
      $sessionWorkspaceCanRecoverLegacy.set(false)
    }

    $sessionWorkspaceSplits.set(parseSplits(read(storage, splitKey(), DEFAULT_SPLITS)))
    persist()
  })

  const offLayout = $sessionWorkspaceLayout.listen(persist)
  const offFocus = $sessionWorkspaceFocused.listen(persist)
  persist()

  let disposed = false

  const unbind = () => {
    if (disposed) {return}
    disposed = true
    offSelection()
    offLayout()
    offFocus()
    $sessionWorkspaceActive.set(false)
    recoverableLegacy = undefined
    $sessionWorkspaceCanRecoverLegacy.set(false)

    if (unbindCurrent === unbind) {unbindCurrent = undefined; currentStorage = undefined}
  }

  unbindCurrent = unbind

  return unbind
}

export function recoverLegacySessionWorkspace(): void {
  const storage = currentStorage
  const selection = recoverableLegacy

  if (!storage || !selection || $sessionWorkspaceSelection.get().length > 0) {return}

  recoverableLegacy = undefined
  $sessionWorkspaceCanRecoverLegacy.set(false)
  $sessionWorkspaceSelection.set(selection)
  const savedLayout = read<unknown>(storage, STORAGE_LAYOUT, 'grid')
  $sessionWorkspaceLayout.set(savedLayout === 'focus' || savedLayout === 'split' ? savedLayout : 'grid')
  const savedFocus = parseKey(read(storage, STORAGE_FOCUS, null))
  $sessionWorkspaceFocused.set(selection.find(key => savedFocus && sameWorkspaceSession(key, savedFocus)) ?? selection[0] ?? null)
  $sessionWorkspaceSplits.set(parseSplits(read(storage, splitKey(), DEFAULT_SPLITS)))
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
