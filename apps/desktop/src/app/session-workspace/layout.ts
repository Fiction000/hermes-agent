import type { SessionOwnerRoute } from '@/store/session-request-router'

import { sameWorkspaceSession, WORKSPACE_MAX_SESSIONS, type WorkspaceSessionKey } from './model'

export interface WorkspaceSplits { column: number; row: number }
export const DEFAULT_SPLITS: WorkspaceSplits = { column: .64, row: .5 }
export const workspaceOwnerKey = (route: SessionOwnerRoute) => JSON.stringify([route.connectionId, route.profile, route.targetProfile ?? route.profile])

export function clampSplit(ratio: number, extent: number, minimum: number): number {
  if (!Number.isFinite(ratio) || extent <= minimum * 2) { return .5 }

  return Math.max(minimum / extent, Math.min(1 - minimum / extent, ratio))
}

export function parseSplits(value: unknown): WorkspaceSplits {
  const candidate = value as Partial<WorkspaceSplits> | null
  const safe = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) ? Math.max(.2, Math.min(.8, n)) : fallback

  return { column: safe(candidate?.column, DEFAULT_SPLITS.column), row: safe(candidate?.row, DEFAULT_SPLITS.row) }
}

export function placeWorkspaceSession(selected: readonly WorkspaceSessionKey[], candidate: WorkspaceSessionKey, index: number): WorkspaceSessionKey[] {
  const exists = selected.some(item => sameWorkspaceSession(item, candidate))

  if (!exists && selected.length >= WORKSPACE_MAX_SESSIONS) { return [...selected] }
  const next = selected.filter(item => !sameWorkspaceSession(item, candidate))
  next.splice(Math.max(0, Math.min(next.length, index)), 0, candidate)

  return next
}
