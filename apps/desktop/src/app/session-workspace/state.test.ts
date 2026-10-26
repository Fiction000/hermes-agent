import { describe, expect, it } from 'vitest'

import type { PluginStorage } from '@/contrib/plugin'
import { $sessionWorkspaceActive } from '@/store/session-workspace'

import type { WorkspaceSessionKey } from './model'
import {
  $sessionWorkspaceCanRecoverLegacy,
  $sessionWorkspaceFocused,
  $sessionWorkspaceLayout,
  $sessionWorkspaceSelection,
  $sessionWorkspaceSplits,
  bindSessionWorkspaceStorage,
  recoverLegacySessionWorkspace,
  setSessionWorkspaceFocused,
  setSessionWorkspaceLayout,
  setSessionWorkspaceSelection,
  setSessionWorkspaceSplits
} from './state'

function memoryStorage(): { data: Map<string, unknown>; storage: PluginStorage } {
  const data = new Map<string, unknown>()

  return {
    data,
    storage: {
      get<T>(key: string, fallback: T): T {
        return data.has(key) ? (data.get(key) as T) : fallback
      },
      set(key, value) {
        data.set(key, value)
      },
      remove(key) {
        data.delete(key)
      }
    }
  }
}

const selection: WorkspaceSessionKey[] = [
  { storedSessionId: 'stored-a', ownerRoute: { connectionId: 'source-a', profile: 'work', targetProfile: 'agent' } },
  { storedSessionId: 'stored-b', ownerRoute: { connectionId: 'source-b', profile: 'default' } }
]

describe('session workspace persistence', () => {
  it('migrates v1 without deleting it and restores v2 arrangement and sizes after reorder', () => {
    const { storage, data } = memoryStorage()
    data.set('selection.v1', selection)
    data.set('layout.v1', 'focus')
    const unbind = bindSessionWorkspaceStorage(storage)
    expect($sessionWorkspaceSelection.get()).toEqual(selection)
    setSessionWorkspaceLayout('split')
    setSessionWorkspaceSplits({ column: .6, row: .42 })
    setSessionWorkspaceSelection([...selection].reverse())
    expect($sessionWorkspaceSplits.get()).toEqual({ column: .6, row: .42 })
    setSessionWorkspaceFocused(selection[1])
    unbind()
    const dispose = bindSessionWorkspaceStorage(storage)
    expect($sessionWorkspaceLayout.get()).toBe('split')
    expect($sessionWorkspaceSelection.get()).toEqual([...selection].reverse())
    expect($sessionWorkspaceSplits.get()).toEqual({ column: .6, row: .42 })
    expect($sessionWorkspaceFocused.get()).toEqual(selection[1])
    expect(data.get('layout.v1')).toBe('focus')
    expect([...data.keys()].some(key => key.startsWith('arrangement.v2.') && key.includes('source-a'))).toBe(true)
    dispose()
  })

  it('does not leak split sizes across owner targets and ignores a stale focus', () => {
    const { storage, data } = memoryStorage()
    data.set('selection.v1', selection)
    data.set('focused.v1', { storedSessionId: 'not-selected', ownerRoute: selection[0].ownerRoute })
    const unbind = bindSessionWorkspaceStorage(storage)
    expect($sessionWorkspaceFocused.get()).toEqual(selection[0])
    setSessionWorkspaceSplits({ column: .57, row: .47 })
    setSessionWorkspaceSelection([{ ...selection[0], ownerRoute: { ...selection[0].ownerRoute, targetProfile: 'other' } }])
    expect($sessionWorkspaceSplits.get()).toEqual({ column: .64, row: .5 })
    setSessionWorkspaceSelection(selection)
    expect($sessionWorkspaceSplits.get()).toEqual({ column: .57, row: .47 })
    unbind()
  })
  it('restores the owner-aware selection, layout, and focused session', () => {
    const { storage } = memoryStorage()
    const dispose = bindSessionWorkspaceStorage(storage)

    setSessionWorkspaceSelection(selection)
    setSessionWorkspaceLayout('focus')
    setSessionWorkspaceFocused(selection[1])
    dispose()

    const unbind = bindSessionWorkspaceStorage(storage)

    expect($sessionWorkspaceSelection.get()).toEqual(selection)
    expect($sessionWorkspaceLayout.get()).toBe('focus')
    expect($sessionWorkspaceFocused.get()).toEqual(selection[1])
    expect($sessionWorkspaceActive.get()).toBe(false)

    unbind()
  })

  it('rejects malformed persisted owners and still caps the restored selection', () => {
    const { storage, data } = memoryStorage()
    data.set('selection.v1', [
      ...Array.from({ length: 5 }, (_, index) => ({
        storedSessionId: `stored-${index}`,
        ownerRoute: { connectionId: `source-${index}`, profile: 'default' }
      })),
      { storedSessionId: 'unsafe', ownerRoute: { profile: 'default' } }
    ])

    const unbind = bindSessionWorkspaceStorage(storage)

    expect($sessionWorkspaceSelection.get()).toHaveLength(4)
    expect($sessionWorkspaceSelection.get().some(item => item.storedSessionId === 'unsafe')).toBe(false)

    unbind()
  })

  it('offers legacy recovery without restoring it until explicitly requested', () => {
    const { storage, data } = memoryStorage()
    const legacy = [...selection, ...selection.map((item, index) => ({ ...item, storedSessionId: `legacy-${index}` }))]
    data.set('arrangement.last.v2', 'arrangement.v2.[]')
    data.set('arrangement.v2.[]', { selection: [], layout: 'grid', focused: null })
    data.set('selection.v1', legacy)
    data.set('layout.v1', 'focus')
    data.set('focus.v1', selection[1])
    data.set('splits.v2.' + JSON.stringify([JSON.stringify(['source-a', 'work', 'agent']), JSON.stringify(['source-b', 'default', 'default'])]), { column: .58, row: .43 })

    const unbind = bindSessionWorkspaceStorage(storage)
    expect($sessionWorkspaceSelection.get()).toEqual([])
    expect($sessionWorkspaceCanRecoverLegacy.get()).toBe(true)
    expect(data.get('selection.v1')).toEqual(legacy)

    recoverLegacySessionWorkspace()
    expect($sessionWorkspaceSelection.get()).toEqual(legacy)
    expect($sessionWorkspaceLayout.get()).toBe('focus')
    expect($sessionWorkspaceFocused.get()).toEqual(selection[1])
    expect($sessionWorkspaceSplits.get()).toEqual({ column: .58, row: .43 })
    expect($sessionWorkspaceCanRecoverLegacy.get()).toBe(false)
    expect(data.get('selection.v1')).toEqual(legacy)
    unbind()

    const dispose = bindSessionWorkspaceStorage(storage)
    expect($sessionWorkspaceSelection.get()).toEqual(legacy)
    expect($sessionWorkspaceLayout.get()).toBe('focus')
    dispose()
  })

  it('preserves nonempty v2 and an intentional clear until recovery is requested', () => {
    const { storage, data } = memoryStorage()
    data.set('arrangement.last.v2', 'arrangement.v2')
    data.set('arrangement.v2', { selection: selection.slice(0, 1), layout: 'grid' })
    data.set('selection.v1', selection)
    const unbind = bindSessionWorkspaceStorage(storage)
    expect($sessionWorkspaceCanRecoverLegacy.get()).toBe(false)
    unbind()

    const next = memoryStorage()
    next.data.set('selection.v1', selection)
    const dispose = bindSessionWorkspaceStorage(next.storage)
    setSessionWorkspaceSelection([])
    dispose()
    const rebound = bindSessionWorkspaceStorage(next.storage)
    expect($sessionWorkspaceSelection.get()).toEqual([])
    expect($sessionWorkspaceCanRecoverLegacy.get()).toBe(true)
    rebound()
    recoverLegacySessionWorkspace()
    expect($sessionWorkspaceSelection.get()).toEqual([])
  })

  it('sanitizes, deduplicates and caps explicit legacy recovery', () => {
    const { storage, data } = memoryStorage()
    const valid = Array.from({ length: 5 }, (_, index) => ({ storedSessionId: `legacy-${index}`, ownerRoute: { connectionId: 'synthetic-owner', profile: 'default', mode: 'local' as const } }))
    const legacy = [valid[0], valid[0], { storedSessionId: 'invalid', ownerRoute: {} }, ...valid.slice(1)]
    data.set('arrangement.last.v2', 'arrangement.v2.[]')
    data.set('arrangement.v2.[]', { selection: [], layout: 'grid', focused: null })
    data.set('selection.v1', legacy)
    data.set('layout.v1', 'invalid-layout')
    data.set('focus.v1', valid[4])
    const dispose = bindSessionWorkspaceStorage(storage)
    recoverLegacySessionWorkspace()
    expect($sessionWorkspaceSelection.get()).toEqual(valid.slice(0, 4))
    expect($sessionWorkspaceFocused.get()).toEqual(valid[0])
    expect($sessionWorkspaceLayout.get()).toBe('grid')
    expect(data.get('selection.v1')).toEqual(legacy)
    dispose()
  })

  it('does not carry a legacy recovery candidate across storage bindings', () => {
    const first = memoryStorage()
    first.data.set('arrangement.v2', { selection: [] })
    first.data.set('selection.v1', selection)
    const unbindFirst = bindSessionWorkspaceStorage(first.storage)
    expect($sessionWorkspaceCanRecoverLegacy.get()).toBe(true)
    const second = memoryStorage()
    const unbindSecond = bindSessionWorkspaceStorage(second.storage)
    const before = new Map(first.data)
    unbindFirst()
    recoverLegacySessionWorkspace()
    expect($sessionWorkspaceSelection.get()).toEqual([])
    expect($sessionWorkspaceCanRecoverLegacy.get()).toBe(false)
    expect(first.data).toEqual(before)
    unbindSecond()
  })

  it('does not replace a manual selection with a stale recovery candidate', () => {
    const { storage, data } = memoryStorage()
    data.set('arrangement.v2', { selection: [] })
    data.set('selection.v1', selection)
    const dispose = bindSessionWorkspaceStorage(storage)
    const manual = [{ ...selection[0], storedSessionId: 'manual-selection' }]
    setSessionWorkspaceSelection(manual)
    recoverLegacySessionWorkspace()
    expect($sessionWorkspaceSelection.get()).toEqual(manual)
    expect($sessionWorkspaceCanRecoverLegacy.get()).toBe(false)
    dispose()
  })

  it('does not offer recovery when legacy selection is invalid after sanitizing', () => {
    const { storage, data } = memoryStorage()
    data.set('arrangement.last.v2', 'arrangement.v2')
    data.set('arrangement.v2', { selection: [], layout: 'grid' })
    data.set('selection.v1', [{ storedSessionId: '', ownerRoute: {} }])
    const unbind = bindSessionWorkspaceStorage(storage)
    expect($sessionWorkspaceCanRecoverLegacy.get()).toBe(false)
    expect($sessionWorkspaceSelection.get()).toEqual([])
    unbind()
  })
})
