import type { SashBounds } from './Sash'
import { storedWidth } from './stored-width'

/**
 * How wide the person dragged the rail (`stored-width.ts`: per machine, in localStorage).
 * Until they ever have, the stylesheet's own share of the viewport decides.
 *
 * The bounds are the stylesheet's too (`.app` in style.css holds `--rail` to the same
 * clamp); the two are kept in step by hand. The floor is the narrowest rail the
 * `@container rail` rules at the end of style.css are written for, and the ceiling is
 * what the deck can spare: it keeps the 360px it has at the 560px window every view is
 * audited at, so no drag ever shows the deck narrower than the floor already does.
 */

/** The narrowest rail: the 700px window's own, and the one every rail rule is written for. */
export const RAIL_MIN = 200
/** Past this the rail is the window. */
export const RAIL_MAX = 600
/** What the deck keeps whatever the drag: its width at the 560px window every view is audited at. */
export const DECK_MIN = 360

/** The widths a rail may take in a viewport this wide. */
export function railBounds(viewport: number): SashBounds {
  return { min: RAIL_MIN, max: Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.floor(viewport) - DECK_MIN)) }
}

const rail = storedWidth('cockpit:rail-width', { min: RAIL_MIN, max: RAIL_MAX })

/** The width the person chose, or null while the stylesheet decides. */
export const useRailWidth = rail.use
/** Remember a width — or forget it (`null`) and let the stylesheet decide again. */
export const setRailWidth = rail.set
