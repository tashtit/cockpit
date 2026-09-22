import { useSyncExternalStore } from 'react'

/**
 * How wide the person dragged the rail. A view preference for this machine, like the
 * folds (`families.ts`), so it lives in localStorage rather than in config: the width
 * that suits one screen is the wrong one for the next Mac's. `null` is "never dragged",
 * and then the stylesheet's own share of the viewport decides — the layout every audit
 * and every screenshot is taken of.
 *
 * The bounds are the stylesheet's too (`.app` in style.css holds `--rail` to the same
 * clamp); the two are kept in step by hand. The floor is the narrowest rail the
 * `@container rail` rules at the end of style.css are written for, and the ceiling is
 * what the deck can spare: it keeps the 360px it has at the 560px window every view is
 * audited at, so no drag ever shows the deck narrower than the floor already does.
 */
const KEY = 'cockpit:rail-width'

/** The narrowest rail: the 700px window's own, and the one every rail rule is written for. */
export const RAIL_MIN = 200
/** Past this the rail is the window. */
export const RAIL_MAX = 600
/** What the deck keeps whatever the drag: its width at the 560px window every view is audited at. */
export const DECK_MIN = 360
/** One arrow key's worth. */
export const RAIL_STEP = 16

export type RailBounds = { readonly min: number; readonly max: number }

/** The widths a rail may take in a viewport this wide. */
export function railBounds(viewport: number): RailBounds {
  return { min: RAIL_MIN, max: Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.floor(viewport) - DECK_MIN)) }
}

/** A width held to the bounds, in whole pixels. */
export function clampRail(px: number, viewport: number): number {
  const { min, max } = railBounds(viewport)
  return Math.min(max, Math.max(min, Math.round(px)))
}

const listeners = new Set<() => void>()
/** Storage refused to save — the width still holds for this run. */
let unsaved: number | null | undefined

function read(): number | null {
  if (unsaved !== undefined) return unsaved
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  const n = Number(raw)
  // a hand-mangled value is no width; one past the ceiling is the ceiling
  return Number.isFinite(n) && n >= RAIL_MIN ? Math.min(RAIL_MAX, Math.round(n)) : null
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The width the person chose, or null while the stylesheet decides. */
export function useRailWidth(): number | null {
  return useSyncExternalStore(subscribe, read)
}

/** Remember a width — or forget it (`null`) and let the stylesheet decide again. */
export function setRailWidth(px: number | null): void {
  const next = px === null ? null : Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)))
  try {
    if (next === null) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, String(next))
    unsaved = undefined
  } catch {
    unsaved = next
  }
  for (const cb of listeners) cb()
}
