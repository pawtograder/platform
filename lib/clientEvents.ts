/**
 * Browser CustomEvent names used as a tiny pub/sub between unrelated parts
 * of the UI. We use `window` events instead of React contexts when the
 * publisher and subscriber live in incompatible provider trees — for
 * example, the global search palette is rendered outside of
 * `KeyboardShortcutsProvider`, so it cannot call `useKeyboardShortcuts()`
 * directly to open the shortcuts help dialog.
 *
 * Keep the set small and the names prefixed with `pawtograder:` so they
 * don't collide with framework- or browser-defined events.
 */
export const OPEN_SHORTCUTS_HELP_EVENT = "pawtograder:open-shortcuts-help";
export const OPEN_NOTIFICATIONS_EVENT = "pawtograder:open-notifications";
export const TOGGLE_ANONYMIZE_GRADES_EVENT = "pawtograder:toggle-anonymize-grades";
