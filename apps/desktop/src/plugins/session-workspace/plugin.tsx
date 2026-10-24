// First-party adapter: the bundled-plugin loader discovers this file, while
// the workspace implementation lives with the core chat/session surface.
// eslint-disable-next-line no-restricted-imports -- This is a first-party adapter to the native chat surface, not a third-party plugin import.
export { default } from '../../app/session-workspace/plugin'
