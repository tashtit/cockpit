import type { SashBounds } from './Sash'
import { storedWidth } from './stored-width'

/**
 * How wide the person dragged the side panel (`stored-width.ts`: per machine, in
 * localStorage). The Work panel beside a chat and the Evidence panel beside a roundtable
 * are one frame (`SidePanel.tsx`), so they keep one width. Until it is ever dragged, the
 * stylesheet's own share of the deck decides: 38% of it, 300–460px.
 *
 * The bounds are the stylesheet's too (`.work-panel`'s flex-basis clamp in style.css);
 * the two are kept in step by hand. The panel never goes under its 300px floor, and the
 * conversation beside it always keeps 420px — together the 720px of deck under which the
 * panel stops sitting beside the conversation and covers it instead (the `@container
 * chat-deck` rule), where there is no edge left to drag.
 */

/** The narrowest panel: its floor beside the conversation. */
export const PANEL_MIN = 300
/** What the conversation keeps whatever the drag: a reply wrapping every few words is no conversation. */
export const CONVERSATION_MIN = 420

/** The widths the panel may take in a deck this wide. */
export function panelBounds(deck: number): SashBounds {
  return { min: PANEL_MIN, max: Math.max(PANEL_MIN, Math.floor(deck) - CONVERSATION_MIN) }
}

// no ceiling of its own: a deck wide enough to spare the conversation its 420px can give
// the rest to a diff, and a stored width past what this deck spares is held back by the
// stylesheet, not rewritten
const panel = storedWidth('cockpit:panel-width', { min: PANEL_MIN, max: Number.MAX_SAFE_INTEGER })

/** The width the person chose, or null while the stylesheet decides. */
export const usePanelWidth = panel.use
/** Remember a width — or forget it (`null`) and let the stylesheet decide again. */
export const setPanelWidth = panel.set
