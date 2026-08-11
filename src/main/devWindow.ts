/**
 * Dev-only window placement (IO-free — tests target this module directly).
 *
 * `npm run dev` relaunches Electron on every main-process change, and each
 * launch fronts + focuses the window, yanking the developer out of whatever
 * they were typing in. Two env vars, honored only in dev, fix that:
 *
 *  - COCKPIT_DEV_BACKGROUND=1  — show the window without stealing focus
 *  - COCKPIT_DEV_DISPLAY=<n>   — open centered on display <n> (0-based,
 *    index into screen.getAllDisplays())
 */

export interface DevWindowPrefs {
  /** show the window without activating/focusing it */
  background: boolean
  /** 0-based display index to open on, or null for the OS default */
  displayIndex: number | null
}

export function readDevWindowPrefs(env: Record<string, string | undefined>): DevWindowPrefs {
  const bg = env['COCKPIT_DEV_BACKGROUND']
  const disp = env['COCKPIT_DEV_DISPLAY']
  return {
    background: bg !== undefined && bg !== '' && bg !== '0',
    displayIndex: disp !== undefined && /^\d+$/.test(disp) ? Number(disp) : null
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Bounds that center a window of the given size in a display's work area. */
export function centeredIn(workArea: Rect, width: number, height: number): Rect {
  const w = Math.min(width, workArea.width)
  const h = Math.min(height, workArea.height)
  return {
    x: workArea.x + Math.round((workArea.width - w) / 2),
    y: workArea.y + Math.round((workArea.height - h) / 2),
    width: w,
    height: h
  }
}
