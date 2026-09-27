import { useSyncExternalStore } from 'react'

/**
 * A width the person dragged something to, remembered for this machine. A view
 * preference, like the folds (`families.ts`), so it lives in localStorage rather than in
 * config: the width that suits one screen is the wrong one for the next Mac's. `null` is
 * "never dragged", and then the stylesheet's own default decides — the layout every
 * audit and every screenshot is taken of.
 *
 * The rail (`rail.ts`) and the side panel (`panel.ts`) each keep one.
 */
export type StoredWidth = {
  /** The width the person chose, or null while the stylesheet decides. */
  readonly use: () => number | null
  /** Remember a width — or forget it (`null`) and let the stylesheet decide again. */
  readonly set: (px: number | null) => void
}

/**
 * The store under `key`, holding what it reads and writes to `min`–`max`. Only the
 * floor refuses a value: under it a stored number is no width a drag could leave, while
 * one past the ceiling is the ceiling.
 */
export function storedWidth(key: string, bounds: { readonly min: number; readonly max: number }): StoredWidth {
  const listeners = new Set<() => void>()
  /** Storage refused to save — the width still holds for this run. */
  let unsaved: number | null | undefined
  const held = (px: number): number => Math.min(bounds.max, Math.max(bounds.min, Math.round(px)))

  const read = (): number | null => {
    if (unsaved !== undefined) return unsaved
    let raw: string | null = null
    try {
      raw = window.localStorage.getItem(key)
    } catch {
      return null
    }
    if (raw === null) return null
    const n = Number(raw)
    // a hand-mangled value is no width
    return Number.isFinite(n) && n >= bounds.min ? held(n) : null
  }
  const subscribe = (cb: () => void): (() => void) => {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }

  return {
    use: () => useSyncExternalStore(subscribe, read),
    set: (px) => {
      const next = px === null ? null : held(px)
      try {
        if (next === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, String(next))
        unsaved = undefined
      } catch {
        unsaved = next
      }
      for (const cb of listeners) cb()
    }
  }
}
