import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import type { AttentionTarget } from '../shared/types'
import { PUSH, type PushChannel } from '../shared/contract'
import { clampZoom, restoredBounds, WINDOW_FLOOR, zoomedFloor } from '../shared/window'
import { loadConfig, setWindowPlacement } from './config'
import { centeredIn, readDevWindowPrefs, type Rect } from './dev-window'
import { branchForCwd } from './repos'

/*
 * The one window: creating it (placement, zoom floor, the renderer's lockdown), pushing
 * to it, and bringing it forward for a notification. Main keeps running with no window
 * on macOS, so everything here tolerates there being none.
 */

let win: BrowserWindow | null = null
/** A notification clicked while no renderer could hear it — the next one takes it. */
let pendingOpen: AttentionTarget | null = null
/** Who hears the window gain and lose focus (the attention desk); set once at startup. */
let focusListener: (focused: boolean) => void = () => {}

export function onWindowFocus(listener: (focused: boolean) => void): void {
  focusListener = listener
}

/** The open window, if any — a dialog needs a parent, and there may be none. */
export function currentWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

/** The target a notification click left for a renderer that wasn't listening yet, once. */
export function takePendingOpen(): AttentionTarget | null {
  const target = pendingOpen
  pendingOpen = null
  return target
}

/**
 * Push an event to the renderer. Streams and scans outlive the window on macOS
 * (window-all-closed doesn't quit) — sending to a destroyed webContents would
 * throw inside a stream handler and take the whole main process down.
 */
export function sendToWin(channel: PushChannel, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** A notification was clicked: bring the window forward and open what it was about (if anything). */
export function openAttentionTarget(target: AttentionTarget | null): void {
  if (!win || win.isDestroyed()) {
    // the window was closed (macOS keeps running) — its successor asks once it listens
    pendingOpen = target
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  app.focus({ steal: true })
  if (!target) return
  if (win.webContents.isLoading()) pendingOpen = target
  else sendToWin(PUSH.attentionOpen, target)
}

/**
 * Dev-only: resolve COCKPIT_DEV_DISPLAY to that display's work area, and print
 * the display table so the developer can see which index is which screen.
 */
function pickDevDisplayArea(index: number): Rect | null {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  for (const [i, d] of displays.entries()) {
    const tags = [d.id === primary.id ? 'primary' : '', i === index ? '← COCKPIT_DEV_DISPLAY' : '']
    console.log(
      `[dev] display ${i}: ${d.size.width}x${d.size.height} at (${d.bounds.x},${d.bounds.y}) ${tags.filter(Boolean).join(' ')}`.trimEnd()
    )
  }
  const chosen = displays[index]
  if (!chosen) {
    console.warn(`[dev] COCKPIT_DEV_DISPLAY=${index} is out of range — using the OS default`)
    return null
  }
  return chosen.workArea
}

/**
 * Unpackaged-only: the branch of the checkout this instance runs from, so parallel
 * dev, e2e and ui-tour instances from different worktrees are tellable apart. The app
 * path is the checkout under `npm run dev` but `out/main` under `electron out/main`,
 * so the checkout is found by the same ancestor walk every session's cwd goes through.
 * Best-effort — no repo, or an unreadable HEAD, quietly yields null.
 */
function readDevBranch(): string | null {
  return branchForCwd(app.getAppPath())
}

/**
 * Keep the minimum the OS enforces in step with the zoom, so the layout is never handed
 * fewer CSS pixels than the floor it is written down to, and lift a window already under
 * the new minimum — `setMinimumSize` alone leaves a smaller window smaller. A maximized
 * or full-screen window already holds everything the display has, so it is left alone.
 *
 * Returns the zoom it settled on, so main and the renderer's chip read the same number.
 */
export function applyWindowFloor(zoom: number, { grow = true }: { grow?: boolean } = {}): number {
  const z = clampZoom(zoom)
  const w = win
  if (!w || w.isDestroyed()) return z
  const min = zoomedFloor(z, screen.getDisplayMatching(w.getBounds()).workAreaSize)
  w.setMinimumSize(min.width, min.height)
  if (!grow || w.isMaximized() || w.isFullScreen()) return z
  const [width = 0, height = 0] = w.getSize()
  if (width < min.width || height < min.height)
    w.setSize(Math.max(width, min.width), Math.max(height, min.height), true)
  return z
}

/** How long a drag or a resize settles before the placement is written. */
const PLACEMENT_SAVE_MS = 800
/** A renderer that dies again this soon after a reload is left alone rather than reloaded in a loop */
const RENDERER_RECOVERY_MS = 10_000

/**
 * The one page this app loads needs a single web permission: writing text to the
 * clipboard (the copy buttons). Everything else — camera, microphone, location,
 * notifications through the page, HID, serial — is refused rather than left to
 * Electron's default, which grants every request. Notifications are main's
 * (`Notification` in attention.ts), never the page's.
 */
const RENDERER_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/**
 * A link the renderer asks to open, as the URL to hand the OS — or null. Parsed,
 * not pattern-matched: the parser lower-cases the scheme, so `HTTPS://` — which the
 * transcript's own link filter accepts — opens rather than doing nothing, and
 * nothing but http(s) ever reaches `openExternal`.
 */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

export function createWindow(): void {
  // dev-only: `npm run dev` relaunches never steal focus (COCKPIT_DEV_BACKGROUND=0
  // opts out), and the window can open on a chosen display — a packaged app
  // always fronts itself and ignores these env vars
  const devPrefs = app.isPackaged
    ? { background: false, displayIndex: null }
    : readDevWindowPrefs(process.env)
  // unpackaged only: brand the window with the source branch (title + top banner)
  const devBranch = app.isPackaged ? null : readDevBranch()
  const devArea = devPrefs.displayIndex !== null ? pickDevDisplayArea(devPrefs.displayIndex) : null

  // Where it was last time, when the screens still allow it — an update replaces the
  // whole bundle, and reopening somewhere else is the one part of that the user feels.
  // A dev display override narrows the screens that count to the chosen one: a saved
  // placement there is honoured (full screen included, so the e2e placement round trip
  // runs the same with the override as without), anything else opens centred on it.
  // Placing via constructor x/y (not a post-hoc setBounds) is what reliably lands the
  // window on another display under macOS separate-Spaces.
  const saved = loadConfig().window
  const restored = restoredBounds(saved, devArea ? [devArea] : screen.getAllDisplays().map((d) => d.workArea))
  const placed = restored ?? (devArea ? centeredIn(devArea, 1100, 760) : null)
  const openFullScreen = restored !== null && saved?.fullScreen === true

  win = new BrowserWindow({
    show: !devPrefs.background,
    ...(placed ? { x: placed.x, y: placed.y } : {}),
    width: placed?.width ?? 1100,
    height: placed?.height ?? 760,
    // Full screen is restored here rather than after `show`: entering it later plays
    // the whole macOS animation, in front of the user, every single launch.
    //
    // Spread, never passed as a plain boolean: Electron reads an explicit
    // `fullscreen: false` as "this window is not fullscreenable" and clears
    // NSWindowCollectionBehaviorFullScreenPrimary, which demotes the green button to
    // zoom and makes ⌃⌘F, View ▸ Enter Full Screen and `setFullScreen(true)` all
    // no-ops. Every launch that is not restoring a full-screen window takes that
    // branch, so the one window nobody could ever put into full screen was the
    // ordinary one. Leaving the option out is the only way to say "windowed, but
    // fullscreenable" — `e2e/smoke.spec.ts` holds the line.
    ...(openFullScreen ? { fullscreen: true } : {}),
    // the supported floor, in CSS pixels at 100% — the e2e minimum-size gate audits
    // the layout at exactly these numbers. Zoom raises it (applyWindowFloor), since
    // the same window holds fewer CSS pixels the further it is zoomed in.
    minWidth: WINDOW_FLOOR.width,
    minHeight: WINDOW_FLOOR.height,
    title: devBranch ? `Cockpit — ${devBranch}` : 'Cockpit',
    // matches --bg in style.css so pre-paint and resize flashes stay on-theme
    backgroundColor: '#0c1219',
    // frameless-with-inset-traffic-lights: the app draws its own chrome (macOS)
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // the renderer holds window.cockpit (spawns CLIs) — it must never navigate away
  // from the app, and dropped files must not become navigations
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    // the origin, not a prefix: `http://localhost:5173.evil.test` starts with the dev URL
    if (!app.isPackaged && devUrl && sameOrigin(url, devUrl)) return
    e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url)
    if (external) void shell.openExternal(external)
    return { action: 'deny' }
  })
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(RENDERER_PERMISSIONS.has(permission))
  )
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => RENDERER_PERMISSIONS.has(permission))

  // A renderer that dies (out of memory, a GPU reset, killed from Activity Monitor)
  // leaves a blank window whose only way back was closing it. Main's state is intact,
  // so a reload is a full recovery — but never in a loop, if it dies again at once.
  let recoveredAt = 0
  win.webContents.on('render-process-gone', (_e, details) => {
    const w = win
    if (details.reason === 'clean-exit' || !w || w.isDestroyed()) return
    console.error(`[window] renderer gone (${details.reason}, exit ${details.exitCode})`)
    if (Date.now() - recoveredAt < RENDERER_RECOVERY_MS) return
    recoveredAt = Date.now()
    w.webContents.reload()
  })

  if (devPrefs.background) {
    const w = win
    w.once('ready-to-show', () => w.showInactive())
  }
  if (devPrefs.background || devArea) {
    const w = win
    w.once('show', () => console.log(`[dev] window shown at ${JSON.stringify(w.getBounds())}`))
  }

  // pinch-zoom would silently distort the layout — keyboard zoom (⌘+/-) stays available
  void win.webContents.setVisualZoomLevelLimits(1, 1)

  // The zoom is the user's, not the session's — restore what they last set. The window's
  // minimum goes first because it is derived from the zoom: a window that opens under the
  // floor has already shown a frame of the layout it cannot hold. A load resets the
  // frame's own zoom, so the factor is re-applied per load rather than once.
  const savedZoom = clampZoom(loadConfig().zoom ?? 1)
  applyWindowFloor(savedZoom)
  if (savedZoom !== 1) {
    const w = win
    w.webContents.on('dom-ready', () => {
      if (!w.isDestroyed()) w.webContents.setZoomFactor(savedZoom)
    })
  }

  // dev-server URL only in dev — a packaged app must never load an env-supplied origin
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    // the branch rides in as a query param — no IPC surface for a dev-only affordance
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (devBranch) url.searchParams.set('devBranch', devBranch)
    void win.loadURL(url.toString())
  } else {
    // a built but unpackaged run (e2e, the ui-tour, `electron out/main`) is still a dev
    // instance someone has to tell apart — the branch rides in the same way
    void win.loadFile(join(__dirname, '../renderer/index.html'), devBranch ? { query: { devBranch } } : {})
  }

  // the zoomed floor is bounded by the display, so a window dragged to a smaller one
  // gets its minimum re-judged there. Minimum only — resizing a window mid-drag would
  // fight the hand moving it, and 'moved' fires for every pixel of that drag.
  win.on('moved', () => {
    const w = win
    if (w && !w.isDestroyed()) applyWindowFloor(w.webContents.getZoomFactor(), { grow: false })
  })

  // Remembered on the way out, and debounced while it is being dragged or resized so
  // a crash or a force-quit does not cost the placement — 'move' and 'resize' fire for
  // every pixel of a drag, and each save rewrites the whole config file.
  const remember = (): void => {
    const w = win
    if (!w || w.isDestroyed()) return
    // getNormalBounds, not getBounds: in full screen the latter is the whole display,
    // and what has to be saved is the window to fall back to when it leaves
    try {
      setWindowPlacement({ ...w.getNormalBounds(), fullScreen: w.isFullScreen() })
    } catch (err) {
      // a full disk or an unreadable config — on a timer and in 'close', so a throw
      // here would be the main-process error dialog, for a window position
      console.error('[window] failed to remember the placement:', err)
    }
  }
  let rememberSoon: NodeJS.Timeout | null = null
  const rememberLater = (): void => {
    if (rememberSoon) clearTimeout(rememberSoon)
    // unref'd: a pending write must never be what keeps the process alive
    rememberSoon = setTimeout(remember, PLACEMENT_SAVE_MS).unref()
  }
  win.on('move', rememberLater)
  win.on('resize', rememberLater)
  win.on('enter-full-screen', rememberLater)
  win.on('leave-full-screen', rememberLater)
  win.on('close', () => {
    if (rememberSoon) clearTimeout(rememberSoon)
    remember()
  })

  // a turn that ends while nobody is in front of the window is news (attention.ts)
  win.on('focus', () => focusListener(true))
  win.on('blur', () => focusListener(false))
  win.on('closed', () => {
    win = null
    focusListener(false)
  })
}
