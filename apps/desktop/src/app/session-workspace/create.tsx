import { useStore } from '@nanostores/react'
import { useRef, useState } from 'react'

import { createGatewaySession, desktopSessionCreateParams } from '@/app/session/hooks/use-session-actions/session-create-request'
import { upsertOptimisticSession } from '@/app/session/hooks/use-session-actions/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { usePluginI18n } from '@/i18n'
import { createClientSessionState } from '@/lib/chat-runtime'
import { requestGatewayForAgent, retainGatewayForAgent } from '@/store/gateway'
import { $profiles, resolveActiveSourceOwnerRoute, resolveNewChatOwnerRoute } from '@/store/profile'
import { holdSessionOwnerUntilForeground } from '@/store/session-owner-holds'
import type { SessionOwnerRoute } from '@/store/session-request-router'
import { openSessionTile, patchSessionTile, publishSessionState } from '@/store/session-states'

import { workspaceOwnerKey } from './layout'
import { addWorkspaceSession, WORKSPACE_MAX_SESSIONS, type WorkspaceSessionKey, workspaceTileScope } from './model'
import { $sessionWorkspaceSelection, setSessionWorkspaceFocused, setSessionWorkspaceSelection } from './state'

export async function createWorkspaceSession(owner: SessionOwnerRoute, title: string): Promise<WorkspaceSessionKey> {
  if ($sessionWorkspaceSelection.get().length >= WORKSPACE_MAX_SESSIONS) { throw new Error('Workspace full') }
  const release = await retainGatewayForAgent(owner.connectionId, owner.profile, { spawnPriority: 'foreground' })

  try {
    const params = await desktopSessionCreateParams('', owner, owner.profile, false, false)
    const created = await createGatewaySession(owner, { ...params, request_id: crypto.randomUUID(), ...(title.trim() ? { title: title.trim() } : {}) }, (method, args) => requestGatewayForAgent(owner.connectionId, owner.profile, method, args))
    const stored = created.stored_session_id

    if (!stored) { throw new Error('The gateway did not return a stored session identity') }
    const key = { storedSessionId: stored, ownerRoute: owner }
    upsertOptimisticSession(created, stored, title.trim() || null, null, null, undefined, owner)
    holdSessionOwnerUntilForeground(stored, owner)
    publishSessionState(created.session_id, createClientSessionState(stored))
    openSessionTile(stored, 'right', 'workspace', undefined, workspaceTileScope(key))
    patchSessionTile(stored, { runtimeId: created.session_id })
    setSessionWorkspaceSelection(addWorkspaceSession($sessionWorkspaceSelection.get(), key))
    setSessionWorkspaceFocused(key)

    return key
  } finally { release() }
}

export function WorkspaceCreateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = usePluginI18n('session-workspace')
  const profiles = useStore($profiles)
  const selected = useStore($sessionWorkspaceSelection)
  const owners = new Map<string, SessionOwnerRoute>()

  for (const route of [resolveNewChatOwnerRoute(), ...profiles.map(profile => resolveActiveSourceOwnerRoute(profile.name))]) {
    if (route) { owners.set(workspaceOwnerKey(route), route) }
  }

  const [ownerId, setOwnerId] = useState('')
  const [title, setTitle] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const owner = owners.get(ownerId) ?? owners.values().next().value
  const full = selected.length >= WORKSPACE_MAX_SESSIONS

  return <Dialog onOpenChange={value => { if (!inFlight.current) { onOpenChange(value); setError('') } }} open={open}>
    <DialogContent className="max-w-md">
      <DialogHeader><DialogTitle>{t('page.newSession')}</DialogTitle></DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={async event => {
        event.preventDefault()

        if (inFlight.current || !owner || full) { return }
        inFlight.current = true
        setPending(true)
        setError('')

        try {
          const key = await createWorkspaceSession({ ...owner }, title)
          onOpenChange(false)
          setTitle('')
          requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-workspace-session="${CSS.escape(key.storedSessionId)}"] [contenteditable="true"]`)?.focus())
        } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
        finally { inFlight.current = false; setPending(false) }
      }}>
        <label className="flex flex-col gap-2 text-xs">{t('page.owner')}
          <select aria-label={t('page.owner')} className="session-workspace-owner" disabled={pending} onChange={event => setOwnerId(event.target.value)} value={owner ? workspaceOwnerKey(owner) : ''}>
            {[...owners].map(([id, route]) => <option key={id} value={id}>{route.profile} · {route.connectionId}{route.targetProfile && route.targetProfile !== route.profile ? ` · ${route.targetProfile}` : ''}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-2 text-xs">{t('page.sessionName')}<Input disabled={pending} onChange={event => setTitle(event.target.value)} placeholder={t('page.untitled')} value={title} /></label>
        {error || !owner || full ? <p className="text-xs text-destructive" role="alert">{error || (full ? t('picker.limit') : t('picker.ownerUnavailable'))}</p> : null}
        <div className="flex justify-end gap-2"><Button disabled={pending} onClick={() => onOpenChange(false)} type="button" variant="ghost">{t('page.cancel')}</Button><Button disabled={pending || !owner || full} type="submit">{pending ? t('page.creating') : t('page.create')}</Button></div>
      </form>
    </DialogContent>
  </Dialog>
}
