import type { KeyboardEvent } from 'react'

/**
 * Escape backs out of whatever the control is holding — an armed confirm, a key
 * being typed. The key is stopped here: the control owns this Escape, and App's
 * view-level Escape must not also fire.
 */
export function onEscape(back: () => void): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      back()
    }
  }
}

/**
 * The handlers an armed two-step button wears: it backs out on blur and on Escape,
 * so a question left on screen never outlives the attention it was asked for. One
 * helper for every such button — the disarm rules gate destructive actions, and a
 * hand-typed copy is how one button ends up behaving differently from its neighbour.
 */
export function disarmOn(disarm: () => void): {
  readonly onBlur: () => void
  readonly onKeyDown: (e: KeyboardEvent) => void
} {
  return { onBlur: disarm, onKeyDown: onEscape(disarm) }
}
