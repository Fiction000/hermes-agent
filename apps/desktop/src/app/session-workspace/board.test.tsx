/* eslint-disable no-restricted-globals -- Exercise document-level pointer and keyboard gesture listeners. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WORKSPACE_DRAG_EVENT, WorkspaceBoard } from './board'
import type { WorkspaceSessionKey } from './model'

vi.mock('@/i18n', () => ({ usePluginI18n: () => (key: string) => key }))
afterEach(async () => { cleanup(); await new Promise(resolve => setTimeout(resolve, 1)) })
const keys: WorkspaceSessionKey[] = ['a', 'b', 'c', 'd'].map(storedSessionId => ({ storedSessionId, ownerRoute: { connectionId: 'local', profile: 'work' } }))

function setup() {
  const place = vi.fn()
  const props = { selected: keys, layout: 'grid' as const, focused: keys[0], sessionLabel: (key: WorkspaceSessionKey) => key.storedSessionId, renderSlot: (key: WorkspaceSessionKey | null) => <textarea aria-label={key?.storedSessionId} defaultValue="日本語の下書き" />, onFocus: vi.fn(), onPlace: place, resolveDragged: () => keys[0] }

  return { place, props, ...render(<WorkspaceBoard {...props} />) }
}

describe('workspace gestures', () => {
  it('keeps the active pointer gesture alive across preview renders and commits the final target', () => {
    const { container, place } = setup()
    const origin = screen.getAllByRole('button')[0]
    const target = container.querySelector('[data-workspace-slot="2"]')!
    document.elementFromPoint = vi.fn(() => target as Element)
    fireEvent(document, new CustomEvent(WORKSPACE_DRAG_EVENT, { detail: { id: 'a', pointerId: 1, x: 0, y: 0, origin } }))
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 20, clientY: 30 })
    expect(screen.getByText('page.dropHere')).toBeTruthy()
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 25, clientY: 35 })
    fireEvent.pointerUp(document, { pointerId: 1 })
    expect(place).toHaveBeenCalledWith(keys[0], 2)
    vi.restoreAllMocks()
  })
  it('supports keyboard placement and Escape focus return without remounting drafts', () => {
    const { props, rerender, place } = setup()
    const draft = screen.getByRole('textbox', { name: 'a' })
    const origin = screen.getAllByRole('button')[0]
    fireEvent.click(origin)
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(place).toHaveBeenCalledWith(keys[0], 1)
    fireEvent.click(origin)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(origin)
    rerender(<WorkspaceBoard {...props} layout="split" selected={[keys[3], ...keys.slice(0, 3)]} />)
    expect(screen.getByRole('textbox', { name: 'a', hidden: true })).toBe(draft)
    expect((draft as HTMLTextAreaElement).value).toBe('日本語の下書き')
    expect(screen.getAllByRole('textbox', { hidden: true })).toHaveLength(4)
  })
})
