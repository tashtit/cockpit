/**
 * The modifier every Cockpit shortcut rides: ⌘ on a Mac, Ctrl elsewhere. Never both on a
 * Mac — there Ctrl is the text field's own: Ctrl+K deletes to the end of the line, Ctrl+N
 * moves down one, Ctrl+D deletes forward, in the composer as in every macOS text field,
 * and a shortcut that answered to Ctrl too took them away. A platform the renderer
 * cannot read (jsdom's empty one) is a Mac, as the app is.
 */
const CTRL_PLATFORM = /Win|Linux|X11|CrOS/i.test(globalThis.navigator?.platform ?? '')

export function commandKey(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return CTRL_PLATFORM ? e.ctrlKey : e.metaKey
}
