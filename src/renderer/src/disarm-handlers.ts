import type { KeyboardEvent } from 'react'

/**
 * The ways out of an armed destructive step, for a button that stays the same element
 * armed or not — spread onto it: blur or Escape backs out, the rule `ConfirmRemove`
 * keeps for its own armed button. Escape goes no further while there is a step to back
 * out of, because the view around the button closes on Escape too.
 */
export function disarmHandlers(
  armed: boolean,
  disarm: () => void
): { readonly onBlur: () => void; readonly onKeyDown: (e: KeyboardEvent) => void } {
  return {
    onBlur: () => {
      if (armed) disarm()
    },
    onKeyDown: (e) => {
      if (armed && e.key === 'Escape') {
        e.stopPropagation()
        disarm()
      }
    }
  }
}
