import type { ElectronApplication } from '@playwright/test'

/** How long a graceful quit gets before the app's process group is killed. */
const QUIT_MS = 10_000
/** How long Playwright then gets to notice the kill before teardown stops waiting. */
const KILL_MS = 5_000

/**
 * Close an Electron app under test in bounded time — a graceful quit, then a SIGKILL
 * of its whole process group — so an afterAll hook never eats its timeout. Never throws.
 *
 * Killing just `app.process()` bounds nothing. Playwright's close() resolves on the
 * child's 'close' event, which Node emits only once the process has exited *and* every
 * stdio pipe has shut, and Chromium's helpers (zygote, GPU, renderer, utility) inherit
 * the app's stdout and stderr. One that outlives the main process holds the pipe open,
 * so close() keeps waiting on an app that is already gone — and so does Playwright's own
 * worker teardown, which waits on the same event.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process()
  const closed = app.close().catch(() => {})
  if (await settles(closed, QUIT_MS)) return

  console.warn(`[e2e] app.close() still waiting after ${QUIT_MS}ms — killing the app's process group`)
  try {
    // Playwright spawns Electron detached, as a group leader: -pid reaches every helper
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
  } catch {
    // the group is already gone
  }
  // a process that left the group can still hold a pipe — drop our ends so 'close' fires
  for (const stream of child.stdio) stream?.destroy()
  if (!(await settles(closed, KILL_MS))) console.warn('[e2e] app.close() still waiting after the kill — moving on')
}

async function settles(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(resolve, ms, false)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}
