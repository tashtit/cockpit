/**
 * The way out of an armed destructive step, for a button that stays the same element
 * armed or not — spread onto it: blur backs out.
 */
export function disarmHandlers(armed: boolean, disarm: () => void): { readonly onBlur: () => void } {
  return {
    onBlur: () => {
      if (armed) disarm()
    }
  }
}
