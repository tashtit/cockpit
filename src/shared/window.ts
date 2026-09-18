/**
 * The window's own numbers — the layout floor and the zoom range — in the two units a
 * desktop window is measured in, and the one conversion between them.
 *
 * The floor is written in CSS pixels: the shed rules at the end of style.css, the design
 * system's "supported minimum window" and the e2e audit that gates it are all 560×420 of
 * those. The OS sizes windows in device-independent points instead, and the two are the
 * same only at 100% — zoom divides the CSS viewport by its factor, so a 560pt window at
 * 150% lays out 373 CSS px wide, three breakpoints below anything the layout was written
 * for (the chat header escapes the window, the composer bar clips its own controls).
 * `zoomedFloor` is what keeps the floor where it is documented: the minimum the OS
 * enforces grows with the zoom, so ⌘+ can never walk the layout through it.
 */

type Size = { readonly width: number; readonly height: number }

/** The supported minimum window, in CSS pixels. Change this and the e2e gate together. */
export const WINDOW_FLOOR: Size = { width: 560, height: 420 }

/** UI stays usable at any zoom the user can reach. The ceiling is 2.0 on purpose:
 *  WCAG 1.4.4 wants text to reach 200% without loss of content, and this app's chrome
 *  is deliberately dense (11–13px), so low-vision users need the whole range. */
export const ZOOM_MIN = 0.7
export const ZOOM_MAX = 2

/** The one place a zoom factor is bounded — preload applies it, the renderer reads it
 *  back to keep the zoom chip honest, main sizes the window against it. */
export function clampZoom(factor: number): number {
  return Number.isFinite(factor) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor)) : 1
}

/**
 * The window minimum, in points, that leaves the layout its floor in CSS pixels at this
 * zoom. Zooming out only ever hands the layout more of them, so below 100% the floor is
 * simply the floor.
 *
 * The display bounds it: a minimum larger than the screen is a window nobody can place or
 * move, so where the zoomed floor does not fit, the minimum stops at the work area and the
 * layout takes what is left — the shed rules go down past the floor for exactly this case.
 */
export function zoomedFloor(zoom: number, work: Size): Size {
  const z = Math.max(1, clampZoom(zoom))
  return {
    width: Math.min(Math.round(WINDOW_FLOOR.width * z), Math.max(1, Math.round(work.width))),
    height: Math.min(Math.round(WINDOW_FLOOR.height * z), Math.max(1, Math.round(work.height)))
  }
}
