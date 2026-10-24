import { useStore } from '@nanostores/react'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { usePluginI18n } from '@/i18n'

import { clampSplit } from './layout'
import { sameWorkspaceSession, type WorkspaceSessionKey } from './model'
import { $sessionWorkspaceSplits, setSessionWorkspaceSplits, type WorkspaceLayout } from './state'

export interface WorkspacePlacement { key: WorkspaceSessionKey; index: number; origin: HTMLElement | null; target?: number; edge?: 'before' | 'after' }
export interface WorkspaceDragDetail { id: string; x: number; y: number; pointerId: number; origin: HTMLElement }
export const WORKSPACE_DRAG_EVENT = 'hermes-workspace-drag'

interface BoardProps {
  selected: WorkspaceSessionKey[]
  layout: WorkspaceLayout
  focused: WorkspaceSessionKey | null
  renderSlot: (key: WorkspaceSessionKey | null, index: number) => ReactNode
  onFocus: (key: WorkspaceSessionKey) => void
  onPlace: (key: WorkspaceSessionKey, index: number) => void
  resolveDragged: (id: string) => WorkspaceSessionKey | null
  sessionLabel: (key: WorkspaceSessionKey) => string
}

export function WorkspaceBoard({ selected, layout, focused, renderSlot, onFocus, onPlace, resolveDragged, sessionLabel }: BoardProps) {
  const t = usePluginI18n('session-workspace')
  const splits = useStore($sessionWorkspaceSplits)
  const board = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<WorkspacePlacement | null>(null)
  const placementRef = useRef(placement)
  placementRef.current = placement
  const dragCleanup = useRef<(() => void) | undefined>(undefined)
  const visible = layout === 'focus' ? 1 : layout === 'split' ? 3 : 4
  const focusIndex = Math.max(0, selected.findIndex(key => focused && sameWorkspaceSession(key, focused)))
  const indices = layout === 'focus' ? [focusIndex] : layout === 'split' && focusIndex === 3 ? [0, 1, 3] : [0, 1, 2, 3].slice(0, visible)

  function finish(commit: boolean) {
    const current = placementRef.current

    if (commit && current && current.index >= 0) { onPlace(current.key, current.index) }
    setPlacement(null)
    placementRef.current = null
    dragCleanup.current?.()
    current?.origin?.focus({ preventScroll: true })
    requestAnimationFrame(() => current?.origin?.isConnected && current.origin.focus({ preventScroll: true }))
  }

  function startPointer(key: WorkspaceSessionKey, detail: WorkspaceDragDetail) {
    dragCleanup.current?.()
    let moved = false

    const move = (event: PointerEvent) => {
      if (event.pointerId !== detail.pointerId) { return }

      if (!moved && Math.hypot(event.clientX - detail.x, event.clientY - detail.y) < 6) { return }
      moved = true
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-workspace-slot]')
      const targetIndex = target ? Number(target.dataset.workspaceSlot) : -1
      const rect = target?.getBoundingClientRect()
      const edge: WorkspacePlacement['edge'] = rect && event.clientX < rect.left + rect.width * .2 ? 'before' : rect && event.clientX > rect.right - rect.width * .2 ? 'after' : undefined
      const sourceIndex = selected.findIndex(item => sameWorkspaceSession(item, key))
      const index = targetIndex < 0 ? -1 : !edge ? targetIndex : targetIndex + (edge === 'after' ? 1 : 0) - (sourceIndex >= 0 && (edge === 'after' ? sourceIndex <= targetIndex : sourceIndex < targetIndex) ? 1 : 0)
      const next = { key, index, target: targetIndex, edge, origin: detail.origin }
      placementRef.current = next
      setPlacement(next)
      event.preventDefault()
    }

    const up = (event: PointerEvent) => {
      if (event.pointerId !== detail.pointerId) { return }

      if (moved) {
        const suppress = (click: MouseEvent) => { click.preventDefault(); click.stopImmediatePropagation() }
        document.addEventListener('click', suppress, { capture: true, once: true })
        setTimeout(() => document.removeEventListener('click', suppress, true), 0)
      }

      finish(moved && (placementRef.current?.index ?? -1) >= 0)
    }

    const cancel = () => finish(false)
    document.addEventListener('pointermove', move, { passive: false })
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)

    dragCleanup.current = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', cancel)
      dragCleanup.current = undefined
    }
  }

  const receiveRef = useRef<(event: Event) => void>(() => {})

  receiveRef.current = (event: Event) => {
    const detail = (event as CustomEvent<WorkspaceDragDetail>).detail
    const key = resolveDragged(detail.id)

    if (key) { startPointer(key, detail) }
  }

  useEffect(() => {
    const receive = (event: Event) => receiveRef.current(event)
    document.addEventListener(WORKSPACE_DRAG_EVENT, receive)

    return () => { document.removeEventListener(WORKSPACE_DRAG_EVENT, receive); dragCleanup.current?.() }
  }, [])

  useEffect(() => {
    if (!placement) { return }

    const keyboard = (event: KeyboardEvent) => {
      if (!['Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { return }
      event.preventDefault()
      event.stopImmediatePropagation()

      if (event.key === 'Escape') { finish(false) }
      else if (event.key === 'Enter') { finish(true) }
      else {
        const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
        setPlacement(current => current ? { ...current, index: indices[(Math.max(0, indices.indexOf(current.index)) + delta + visible) % visible] } : null)
      }
    }

    document.addEventListener('keydown', keyboard, true)

    return () => document.removeEventListener('keydown', keyboard, true)
  })

  function resize(axis: 'column' | 'row', element: HTMLElement, x: number, y: number) {
    const rect = board.current!.getBoundingClientRect()
    const initial = { ...splits }
    element.setPointerCapture?.(Number(element.dataset.pointer))

    const move = (event: PointerEvent) => {
      const extent = axis === 'column' ? rect.width - 12 : rect.height - 12
      const position = axis === 'column' ? event.clientX - x : event.clientY - y
      const ratio = clampSplit(initial[axis] + position / extent, extent, axis === 'column' ? 280 : 272)
      setSessionWorkspaceSplits({ ...initial, [axis]: ratio })
    }

    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up) }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', up)
  }

  const stable = [...selected].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

  return <>
    {layout !== 'grid' ? <nav aria-label={t('page.openSessions')} className="flex shrink-0 flex-wrap gap-1" data-workspace-control>
      {selected.map((key, index) => <Button key={JSON.stringify(key)} onClick={() => onFocus(key)} size="xs" variant={index === focusIndex ? 'secondary' : 'ghost'}>{index + 1} · {sessionLabel(key)}</Button>)}
    </nav> : null}
    <div className="session-workspace-board" data-layout={layout} ref={board} style={{ '--workspace-column': `${splits.column * 100}%`, '--workspace-row': `${splits.row * 100}%` } as CSSProperties}>
      {stable.map(key => {
        const index = selected.findIndex(item => sameWorkspaceSession(item, key))
        const position = indices.indexOf(index)

        return <div className="session-workspace-position" data-workspace-slot={index} hidden={position < 0} key={JSON.stringify(key)} style={{ order: index, gridArea: layout === 'focus' ? '1 / 1 / 2 / 2' : layout === 'split' && position === 0 ? '1 / 1 / 4 / 2' : `${layout === 'split' ? position === 1 ? 1 : 3 : index < 2 ? 1 : 3} / ${layout === 'split' ? 3 : index % 2 === 0 ? 1 : 3}` }}>
          <Button aria-label={t('page.moveSession', index + 1)} className="session-workspace-move" data-workspace-control onClick={event => setPlacement({ key, index, origin: event.currentTarget })} onPointerDown={event => {
            if (event.button !== 0) { return }
            startPointer(key, { id: key.storedSessionId, x: event.clientX, y: event.clientY, pointerId: event.pointerId, origin: event.currentTarget })
          }} size="icon-xs" variant="ghost">⠿</Button>
          {renderSlot(key, index)}
          {(placement?.target ?? placement?.index) === index ? <div className="session-workspace-drop" data-edge={placement?.edge} role="status">{t('page.dropHere')}</div> : null}
        </div>
      })}
      {Array.from({ length: visible }, (_, index) => index >= selected.length ? <div className="session-workspace-position" data-workspace-slot={index} key={`empty-${index}`} style={{ gridArea: layout === 'split' && index === 0 ? '1 / 1 / 4 / 2' : `${layout === 'split' ? index === 1 ? 1 : 3 : index < 2 ? 1 : 3} / ${layout === 'split' ? 3 : index % 2 === 0 ? 1 : 3}` }}>
        {renderSlot(null, index)}
        {(placement?.target ?? placement?.index) === index ? <div className="session-workspace-drop" data-edge={placement?.edge} role="status">{t('page.dropHere')}</div> : null}
      </div> : null)}
      {layout !== 'focus' ? (['column', 'row'] as const).map(axis => <div aria-label={t(axis === 'column' ? 'page.resizeColumns' : 'page.resizeRows')} aria-orientation={axis === 'column' ? 'vertical' : 'horizontal'} aria-valuemax={80} aria-valuemin={20} aria-valuenow={Math.round(splits[axis] * 100)} className={`session-workspace-sash session-workspace-sash-${axis}`} data-workspace-control key={axis} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { return }
        event.preventDefault()
        const rect = board.current!.getBoundingClientRect()
        setSessionWorkspaceSplits({ ...splits, [axis]: clampSplit(splits[axis] + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -.02 : .02), axis === 'column' ? rect.width - 12 : rect.height - 12, axis === 'column' ? 280 : 272) })
      }} onPointerDown={event => { event.preventDefault(); event.currentTarget.dataset.pointer = String(event.pointerId); resize(axis, event.currentTarget, event.clientX, event.clientY) }} role="separator" tabIndex={0} />) : null}
    </div>
    {placement ? <p className="session-workspace-placement" data-workspace-control role="status">{t('page.placementKeys')} <Button onClick={() => finish(false)} size="xs" variant="ghost">{t('page.cancel')}</Button></p> : null}
  </>
}
