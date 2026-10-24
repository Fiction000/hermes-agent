import { describe, expect, it } from 'vitest'

import type { SessionOwnerRoute } from '@/store/session-request-router'
import type { SessionTile } from '@/store/session-states'

import {
  addWorkspaceSession,
  sameWorkspaceSession,
  selectedWorkspaceTiles,
  workspaceOwnerRouteForRow,
  type WorkspaceSessionKey
} from './model'

const key = (connectionId: string, storedSessionId = 'shared'): WorkspaceSessionKey => ({
  ownerRoute: { connectionId, profile: 'default' },
  storedSessionId
})

const tile = (storedSessionId: string, ownerRoute: SessionOwnerRoute): SessionTile =>
  ({ storedSessionId, ownerRoute }) as SessionTile

describe('session workspace selection', () => {
  it('keeps a four-session cap and does not add duplicates', () => {
    const four = ['a', 'b', 'c', 'd'].map(id => key('local', id))

    expect(addWorkspaceSession(four, key('local', 'e'))).toEqual(four)
    expect(addWorkspaceSession(four, four[0])).toEqual(four)
    expect(addWorkspaceSession(four.slice(0, 3), key('local', 'd'))).toHaveLength(4)
  })

  it('treats equal stored ids on different owner routes as different sessions', () => {
    expect(sameWorkspaceSession(key('source-a'), key('source-b'))).toBe(false)
    expect(sameWorkspaceSession(key('source-a'), key('source-a'))).toBe(true)
  })

  it('renders selected tiles by both durable id and exact owner route', () => {
    const selected = [key('source-b')]
    const tiles = [tile('shared', { connectionId: 'source-a', profile: 'default' }), tile('shared', { connectionId: 'source-b', profile: 'default' })]

    expect(selectedWorkspaceTiles(tiles, selected)).toEqual([tiles[1]])
  })

  it('keeps a connection-tagged row on its own route even when id lookup points elsewhere', () => {
    const first = { id: 'shared', connection_id: 'source-a', profile: 'default' }
    const second = { id: 'shared', connection_id: 'source-b', profile: 'default' }

    expect(workspaceOwnerRouteForRow(second, [first, second], () => ({ connectionId: 'source-a', profile: 'default' }))).toEqual({
      connectionId: 'source-b',
      profile: 'default'
    })
  })

  it('fails closed for an ambiguous untagged stored id', () => {
    const first = { id: 'shared', connection_id: 'source-a', profile: 'default' }
    const untagged = { id: 'shared', profile: 'default' }

    expect(workspaceOwnerRouteForRow(untagged, [first, untagged], () => ({ connectionId: 'source-a', profile: 'default' }))).toBeUndefined()
  })

  it('resolves a unique untagged row only through an exact owner route', () => {
    const row = { id: 'unique', profile: 'work' }

    expect(workspaceOwnerRouteForRow(row, [row], () => ({ connectionId: 'remote-1', profile: 'work', targetProfile: 'agent' }))).toEqual({
      connectionId: 'remote-1',
      profile: 'work',
      targetProfile: 'agent'
    })
    expect(workspaceOwnerRouteForRow(row, [row], () => 'work')).toBeUndefined()
  })
})
