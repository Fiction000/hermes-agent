import {
  isSessionOwnerRoute,
  type SessionOwnerRoute,
  sessionOwnerRouteFromRow,
  type SessionOwnerScope
} from '@/store/session-request-router'
import type { SessionTile, SessionTileWorkspaceScope } from '@/store/session-states'
import type { SessionInfo } from '@/types/hermes'

export interface WorkspaceSessionKey {
  ownerRoute: SessionOwnerRoute
  storedSessionId: string
}

export const WORKSPACE_MAX_SESSIONS = 4

/** Resolve the exact owner for a visible row without guessing across stored-id
 * collisions. A connection-tagged row is authoritative; the existing owner
 * resolver may enrich that same route with a remote target profile. An
 * untagged row can use the resolver only when its stored id is unique in the
 * visible roster. */
export function workspaceOwnerRouteForRow(
  row: Pick<SessionInfo, 'connection_id' | 'id' | 'profile'>,
  rows: readonly Pick<SessionInfo, 'connection_id' | 'id' | 'profile'>[],
  lookupOwner: (storedSessionId: string) => SessionOwnerScope
): SessionOwnerRoute | undefined {
  const tagged = sessionOwnerRouteFromRow(row)

  if (tagged) {
    const known = lookupOwner(row.id)

    return isSessionOwnerRoute(known) && known.connectionId === tagged.connectionId && known.profile === tagged.profile
      ? known
      : tagged
  }

  if (rows.filter(candidate => candidate.id === row.id).length !== 1) {
    return undefined
  }

  const known = lookupOwner(row.id)

  return isSessionOwnerRoute(known) ? known : undefined
}

function sameOwnerRoute(a: SessionOwnerRoute, b: SessionOwnerRoute): boolean {
  return (
    a.connectionId === b.connectionId &&
    a.profile === b.profile &&
    (a.targetProfile ?? a.profile) === (b.targetProfile ?? b.profile)
  )
}

export function sameWorkspaceSession(a: WorkspaceSessionKey, b: WorkspaceSessionKey): boolean {
  return a.storedSessionId === b.storedSessionId && sameOwnerRoute(a.ownerRoute, b.ownerRoute)
}

export function addWorkspaceSession(
  selected: readonly WorkspaceSessionKey[],
  candidate: WorkspaceSessionKey,
  limit = WORKSPACE_MAX_SESSIONS
): WorkspaceSessionKey[] {
  if (selected.some(item => sameWorkspaceSession(item, candidate)) || selected.length >= limit) {
    return [...selected]
  }

  return [...selected, candidate]
}

export function removeWorkspaceSession(
  selected: readonly WorkspaceSessionKey[],
  candidate: WorkspaceSessionKey
): WorkspaceSessionKey[] {
  return selected.filter(item => !sameWorkspaceSession(item, candidate))
}

export function selectedWorkspaceTiles(
  tiles: readonly SessionTile[],
  selected: readonly WorkspaceSessionKey[]
): SessionTile[] {
  return selected.flatMap(key => {
    const match = tiles.find(
      tile => tile.storedSessionId === key.storedSessionId && tile.ownerRoute && sameOwnerRoute(tile.ownerRoute, key.ownerRoute)
    )

    return match ? [match] : []
  })
}

export function workspaceTileScope(key: WorkspaceSessionKey): SessionTileWorkspaceScope {
  return {
    ownerProfile: key.ownerRoute.profile,
    ownerRoute: key.ownerRoute,
    workspaceMode: 'sessions'
  }
}
