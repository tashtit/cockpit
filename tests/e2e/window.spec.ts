import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { closeApp } from './close-app'
import { launchEnv } from './launch-env'

/**
 * The window's own behaviour across a quit: where it reopens, and whether it can be
 * put into full screen at all. Everything here needs its own launch–close–relaunch
 * cycle rather than the shared app the other specs hold, because the thing under test
 * is what one run writes down and the next one reads back.
 *
 * The placement round trip runs everywhere. The full-screen cases are darwin-only and
 * say so: they are about NSWindow collection behaviour, which is the only place the
 * regression they guard can exist — and this tier runs on Linux under xvfb in CI,
 * where a real full-screen transition proves nothing either way. `packaged.spec.ts`
 * is the macOS-side guard that does run on a runner; see the note there.
 *
 * A full-screen transition activates the app — AppKit fronts any window entering it,
 * shown inactive or not — so the two that perform one only run when asked to with
 * `COCKPIT_E2E_TAKE_FOCUS=1`. Every other launch here stays in the background on the
 * developer's chosen display, and a default run never takes the keyboard from
 * whoever is typing while it runs.
 */
const mainEntry = resolve('out/main/index.js')
if (!existsSync(mainEntry)) {
  throw new Error('out/main/index.js missing — run `npm run build` before `npm run test:e2e`')
}

const TAKES_FOCUS = process.env['COCKPIT_E2E_TAKE_FOCUS'] === '1'
const TAKES_FOCUS_SKIP = 'enters full screen, which fronts the app — set COCKPIT_E2E_TAKE_FOCUS=1 to run'

/** How long a macOS full-screen transition gets — it is animated, and asynchronous. */
const TRANSITION_MS = 8_000

let open: ElectronApplication | null = null

/** One app at a time, on a userData dir the caller keeps across relaunches. */
async function launch(userData: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [mainEntry],
    // launchEnv's empty HOME keeps the index empty, so nothing about the person running
    // this decides how long the window takes to settle
    env: launchEnv({ COCKPIT_USER_DATA: userData })
  })
  open = app
  await app.firstWindow()
  return app
}

async function quit(app: ElectronApplication): Promise<void> {
  await closeApp(app)
  open = null
}

test.afterEach(async () => {
  if (open) await closeApp(open)
  open = null
})

/** What main reports about the one window — the whole surface these tests assert on. */
function windowState(app: ElectronApplication): Promise<{
  fullScreen: boolean
  fullScreenable: boolean
  normal: { x: number; y: number; width: number; height: number }
}> {
  return app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    return { fullScreen: w.isFullScreen(), fullScreenable: w.isFullScreenable(), normal: w.getNormalBounds() }
  })
}

test('an ordinary window is fullscreenable', async () => {
  test.skip(process.platform !== 'darwin', 'NSWindow collection behaviour — macOS only')
  const app = await launch(mkdtempSync(join(tmpdir(), 'cockpit-window-')))

  // Electron reads an explicit `fullscreen: false` as "this window is not
  // fullscreenable" and clears NSWindowCollectionBehaviorFullScreenPrimary, taking the
  // green button, ⌃⌘F and the View menu with it. The option is only ever true when a
  // saved full-screen placement is being restored, so passing it as a plain boolean
  // disabled full screen on every other launch — which is nearly all of them.
  expect((await windowState(app)).fullScreenable).toBe(true)
})

test('an ordinary window can be put into full screen', async () => {
  test.skip(process.platform !== 'darwin', 'NSWindow collection behaviour — macOS only')
  test.skip(!TAKES_FOCUS, TAKES_FOCUS_SKIP)
  const app = await launch(mkdtempSync(join(tmpdir(), 'cockpit-window-')))

  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    if (w.isFullScreen()) return
    const entered = new Promise<void>((r) => {
      w.once('enter-full-screen', () => r())
    })
    w.setFullScreen(true)
    await entered
  })
  expect((await windowState(app)).fullScreen).toBe(true)
})

test('a window closed in full screen reopens in it', async () => {
  test.skip(process.platform !== 'darwin', 'NSWindow collection behaviour — macOS only')
  test.skip(!TAKES_FOCUS, TAKES_FOCUS_SKIP)
  const userData = mkdtempSync(join(tmpdir(), 'cockpit-window-'))

  const first = await launch(userData)
  const windowed = (await windowState(first)).normal
  await first.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    const entered = new Promise<void>((r) => {
      w.once('enter-full-screen', () => r())
    })
    w.setFullScreen(true)
    await entered
  })
  // the placement is written by the window's own 'close' handler, so it has to be a
  // real quit — killing the app would prove nothing about what the next launch reads
  await quit(first)

  const second = await launch(userData)
  await expect
    .poll(async () => (await windowState(second)).fullScreen, { timeout: TRANSITION_MS })
    .toBe(true)
  const restored = await windowState(second)
  // still fullscreenable, so leaving full screen is not a one-way door
  expect(restored.fullScreenable).toBe(true)
  // getNormalBounds is the windowed size to fall back to — full screen must not have
  // overwritten it with the display
  expect(restored.normal).toEqual(windowed)
})

test('a window closed windowed reopens windowed, where it was', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'cockpit-window-'))

  const first = await launch(userData)
  const placed = await first.evaluate(async ({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    // inside the work area of the display it is already on, so restoredBounds can
    // honour it on any screen this runs on
    const area = screen.getDisplayMatching(w.getBounds()).workArea
    const bounds = { x: area.x + 60, y: area.y + 60, width: 900, height: 700 }
    w.setBounds(bounds)
    return bounds
  })
  await quit(first)

  const second = await launch(userData)
  const restored = await windowState(second)
  expect(restored.fullScreen).toBe(false)
  expect(restored.normal).toEqual(placed)
})
