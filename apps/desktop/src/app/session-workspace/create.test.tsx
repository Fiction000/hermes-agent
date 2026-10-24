import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as I18n from '@/i18n'

import { createWorkspaceSession, WorkspaceCreateDialog } from './create'
import { $sessionWorkspaceSelection, setSessionWorkspaceSelection } from './state'

const api = vi.hoisted(() => ({ create: vi.fn(), retain: vi.fn(async () => () => {}), params: vi.fn(async () => ({ source: 'desktop', profile: 'target' })), open: vi.fn(), patch: vi.fn(), publish: vi.fn() }))
vi.mock('@/app/session/hooks/use-session-actions/session-create-request', () => ({ createGatewaySession: api.create, desktopSessionCreateParams: api.params }))
vi.mock('@/store/gateway', () => ({ retainGatewayForAgent: api.retain, requestGatewayForAgent: vi.fn() }))
vi.mock('@/store/profile', async () => { const { atom } = await import('nanostores');

 return { $profiles: atom([{ name: 'work' }]), resolveNewChatOwnerRoute: () => ({ connectionId: 'native', profile: 'work', targetProfile: 'target' }), resolveActiveSourceOwnerRoute: () => null } })
vi.mock('@/store/session-states', () => ({ openSessionTile: api.open, patchSessionTile: api.patch, publishSessionState: api.publish }))
vi.mock('@/store/session-owner-holds', () => ({ holdSessionOwnerUntilForeground: vi.fn() }))
vi.mock('@/app/session/hooks/use-session-actions/utils', () => ({ upsertOptimisticSession: vi.fn() }))
vi.mock('@/i18n', async importOriginal => ({ ...await importOriginal<typeof I18n>(), usePluginI18n: () => (key: string) => key }))
const owner = { connectionId: 'native', profile: 'work', targetProfile: 'target' }
beforeEach(() => { vi.clearAllMocks(); setSessionWorkspaceSelection([]) })
afterEach(cleanup)
describe('workspace owner-specific creation', () => {
  it('uses the captured production owner contract and leaves existing selection intact', async () => {
    const old = { storedSessionId: 'old', ownerRoute: owner }
    setSessionWorkspaceSelection([old])
    api.create.mockResolvedValue({ stored_session_id: 'new', session_id: 'runtime-new' })
    const created = await createWorkspaceSession(owner, ' 日本語 ')
    expect(api.params).toHaveBeenCalledWith('', owner, 'work', false, false)
    expect(api.create.mock.calls[0][0]).toEqual(owner)
    expect(api.create.mock.calls[0][1]).toMatchObject({ source: 'desktop', profile: 'target', title: '日本語' })
    expect($sessionWorkspaceSelection.get()).toEqual([old, created])
    expect(api.patch).toHaveBeenCalledWith('new', { runtimeId: 'runtime-new' })
  })
  it('blocks capacity without a gateway mutation', async () => {
    setSessionWorkspaceSelection(['a', 'b', 'c', 'd'].map(storedSessionId => ({ storedSessionId, ownerRoute: owner })))
    await expect(createWorkspaceSession(owner, '')).rejects.toThrow('Workspace full')
    expect(api.retain).not.toHaveBeenCalled()
  })
  it('prevents duplicate clicks, presents errors and permits an explicit retry', async () => {
    let reject!: (reason: Error) => void
    api.create.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no }))
    render(<WorkspaceCreateDialog onOpenChange={vi.fn()} open />)
    const submit = screen.getByRole('button', { name: 'page.create' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    await act(async () => reject(new Error('Synthetic offline')))
    expect(screen.getByRole('alert').textContent).toBe('Synthetic offline')
    api.create.mockResolvedValueOnce({ stored_session_id: 'retry', session_id: 'runtime-retry' })
    fireEvent.click(screen.getByRole('button', { name: 'page.create' }))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(2))
  })
})
