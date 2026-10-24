import { describe, expect, it } from 'vitest'

import { clampSplit, placeWorkspaceSession, workspaceOwnerKey } from './layout'
import type { WorkspaceSessionKey } from './model'

const key = (id: string): WorkspaceSessionKey => ({ storedSessionId: id, ownerRoute: { connectionId: 'local', profile: 'work' } })
describe('workspace arrangement', () => {
  it('reorders without losing the fourth session or changing owner identities', () => {
    const selected = ['a', 'b', 'c', 'd'].map(key)
    expect(placeWorkspaceSession(selected, selected[3], 0).map(item => item.storedSessionId)).toEqual(['d', 'a', 'b', 'c'])
    expect(placeWorkspaceSession(selected, key('e'), 1)).toEqual(selected)
    expect(selected[3].ownerRoute.profile).toBe('work')
  })
  it('inserts at an edge and deduplicates the exact owner', () => {
    expect(placeWorkspaceSession([key('a'), key('b')], key('c'), 1).map(item => item.storedSessionId)).toEqual(['a', 'c', 'b'])
    expect(placeWorkspaceSession([key('a'), key('b')], key('a'), 1).map(item => item.storedSessionId)).toEqual(['b', 'a'])
  })
  it('enforces minimum pane bounds and finite restored ratios', () => {
    expect(clampSplit(-1, 1000, 280)).toBeCloseTo(.28)
    expect(clampSplit(2, 1000, 280)).toBeCloseTo(.72)
    expect(clampSplit(Number.NaN, 1000, 280)).toBe(.5)
    expect(clampSplit(.1, 400, 280)).toBe(.5)
  })
  it('scopes split sizes by connection, profile and target', () => {
    expect(workspaceOwnerKey(key('a').ownerRoute)).not.toBe(workspaceOwnerKey({ ...key('a').ownerRoute, targetProfile: 'other' }))
  })
})
