import { describe, expect, it } from 'vitest'

import type { SessionOwnerRoute } from '@/store/session-request-router'
import type { SessionTile } from '@/store/session-states'

import {
  addWorkspaceSession,
  sameWorkspaceSession,
  selectedWorkspaceTiles,
  workspaceOwnerRouteForRow,
  type WorkspaceSessionKey,
  workspaceSessionsToRestore
} from './model'

const key = (connectionId: string, storedSessionId = 'shared'): WorkspaceSessionKey => ({
  ownerRoute: { connectionId, profile: 'default' },
  storedSessionId
})

const tile = (storedSessionId: string, ownerRoute: SessionOwnerRoute): SessionTile =>
  ({ storedSessionId, ownerRoute }) as SessionTile

describe('session workspace selection', () => {
  it.each([
    { connectionId: 'other', profile: 'work', targetProfile: 'agent' },
    { connectionId: 'remote', profile: 'other', targetProfile: 'agent' },
    { connectionId: 'remote', profile: 'work', targetProfile: 'other' }
  ])('does not restore the same stored id through a different owner route %j', ownerRoute => {
    const selected = [{ storedSessionId: 'shared', ownerRoute: { connectionId: 'remote', profile: 'work', targetProfile: 'agent' } }]
    const available = [{ storedSessionId: 'shared', ownerRoute }]

    expect(workspaceSessionsToRestore(selected, available, [], new Set())).toEqual([])
  })

  it('restores selected sessions only when the exact owner is available and no tile owns the stored id', () => {
    const selected = [key('source-a', 'present'), key('source-b', 'missing'), key('source-c', 'collision')]
    const available = [selected[0], selected[2]]
    const tiles = [tile('collision', { connectionId: 'other-owner', profile: 'default' })]

    expect(workspaceSessionsToRestore(selected, available, tiles, new Set())).toEqual([selected[0]])
  })

  it('does not restore main-session, lineage-alias, or existing-tile identities', () => {
    const selected = [key('local', 'main'), key('local', 'main-alias'), key('local', 'tile-alias'), key('local', 'clear')]
    const available = [...selected]
    const tiles = [tile('tile', { connectionId: 'local', profile: 'default' })]
    const blocked = new Set(['main', 'main-alias', 'tile-alias', 'tile'])

    expect(workspaceSessionsToRestore(selected, available, tiles, blocked)).toEqual([selected[3]])
  })

  it('restores mixed profiles with exact owner routes and becomes idempotent once tiles exist', () => {
    const selected: WorkspaceSessionKey[] = [
      { storedSessionId: 'local-one', ownerRoute: { connectionId: 'local', profile: 'default' } },
      { storedSessionId: 'remote-two', ownerRoute: { connectionId: 'remote', profile: 'work', targetProfile: 'agent' } }
    ]

    const available = [...selected]

    expect(workspaceSessionsToRestore(selected, available, [], new Set())).toEqual(selected)
    expect(workspaceSessionsToRestore(selected, available, selected.map(item => tile(item.storedSessionId, item.ownerRoute)), new Set())).toEqual([])
  })

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
