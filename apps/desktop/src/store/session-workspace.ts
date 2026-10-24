import { atom } from 'nanostores'

/** True only while the opt-in session workspace route is mounted. */
export const $sessionWorkspaceActive = atom(false)
