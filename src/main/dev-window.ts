/**
 * Dev-only window placement (IO-free — tests target this module directly).
 *
 * `npm run dev` relaunches Electron on every main-process change, and a launch
 * that fronts + focuses the window yanks the developer out of whatever they
 * were typing in. Dev builds therefore show the window *without* activating it
 * by default; two env vars, honored only in dev, tune that:
 *
 *  - COCKPIT_DEV_BACKGROUND=0  — opt back in to a fronted, focused window
 *  - COCKPIT_DEV_DISPLAY=<n>   — open centered on display <n> (0-based,
 *    index into screen.getAllDisplays())
 *
 * This module also holds the pure parsing behind the dev branch indicator:
 * parallel `npm run dev` instances from different worktrees look identical, so
 * dev builds surface the source checkout's branch (window title + sidebar chip).
 */

export type DevWindowPrefs = {
  /** show the window without activating/focusing it (the dev default) */
  readonly background: boolean
  /** 0-based display index to open on, or null for the OS default */
  readonly displayIndex: number | null
}

export function readDevWindowPrefs(env: Record<string, string | undefined>): DevWindowPrefs {
  const bg = env['COCKPIT_DEV_BACKGROUND']
  const disp = env['COCKPIT_DEV_DISPLAY']
  return {
    // background is the dev default — only an explicit off switch fronts the window
    background: bg !== '0' && bg !== 'false',
    displayIndex: disp !== undefined && /^\d+$/.test(disp) ? Number(disp) : null
  }
}

export type Rect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The gitdir a worktree's `.git` *file* points at (linked worktrees have a
 * pointer file where the main checkout has a directory). Null if the content
 * isn't a pointer — possibly relative; the caller resolves it.
 */
export function parseGitdirPointer(dotGitContents: string): string | null {
  const m = /^gitdir:[ \t]*(.+)$/.exec(dotGitContents.trim())
  return m?.[1]?.trim() ?? null
}

/**
 * Branch name from a gitdir's HEAD contents (`ref: refs/heads/<branch>`), or
 * the abbreviated commit hash when detached. Null for anything unrecognized.
 */
export function branchFromHead(headContents: string): string | null {
  const head = headContents.trim()
  const ref = /^ref:[ \t]*refs\/heads\/(.+)$/.exec(head)
  if (ref?.[1]) return ref[1]
  return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : null
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
