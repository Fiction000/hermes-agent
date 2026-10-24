import { describe, expect, it } from 'vitest'

import type { PluginStorage } from '@/contrib/plugin'
import { $sessionWorkspaceActive } from '@/store/session-workspace'

import type { WorkspaceSessionKey } from './model'
import {
  $sessionWorkspaceFocused,
  $sessionWorkspaceLayout,
  $sessionWorkspaceSelection,
  $sessionWorkspaceSplits,
  bindSessionWorkspaceStorage,
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
})
