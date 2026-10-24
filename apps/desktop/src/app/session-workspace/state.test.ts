import { describe, expect, it } from 'vitest'

import type { PluginStorage } from '@/contrib/plugin'
import { $sessionWorkspaceActive } from '@/store/session-workspace'

import type { WorkspaceSessionKey } from './model'
import {
  $sessionWorkspaceFocused,
  $sessionWorkspaceLayout,
  $sessionWorkspaceSelection,
  bindSessionWorkspaceStorage,
  setSessionWorkspaceFocused,
  setSessionWorkspaceLayout,
  setSessionWorkspaceSelection
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
