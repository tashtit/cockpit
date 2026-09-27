import { app, BrowserWindow, Menu, shell } from 'electron'
import { join, resolve } from 'node:path'
import { appMenuTemplate } from './app-menu'
import { loadLoginShellPath } from './env'
import { startServices, type Services } from './services'
import { registerIpc } from './ipc'
import { createWindow } from './window'

/*
 * Main's entry: build the services (services.ts), register every IPC handler (ipc/),
 * set the menu bar (app-menu.ts), open the window (window.ts), and stop what Cockpit
 * started when it quits.
 */

// e2e/dev isolation only — a packaged app must never honor a data-dir override
if (!app.isPackaged && process.env['COCKPIT_USER_DATA']) {
  app.setPath('userData', resolve(process.env['COCKPIT_USER_DATA']))
}

/**
 * Node's answer to an unhandled rejection is to end the process. For a server that is
 * the right call; for a desktop hub it means the window vanishes mid-session, taking
 * every running turn with it, over a background write that nobody was waiting on.
 *
 * Main is full of deliberate fire-and-forget work — a rescan, a cache flush, a
 * notification sound — and each of those already decides what its own failure means.
 * This is the net under the one that forgot, and it only writes the reason down:
 * anything that actually matters to the user is reported through its own IPC reply.
 * `uncaughtException` is deliberately left alone — a throw off the stack can leave
 * state half-written, and there is no honest way to carry on from it.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})

/** Null until the app is ready — the quit hooks below can fire before that. */
let services: Services | null = null

// the person's own PATH (nvm, Homebrew's shellenv, …) for every CLI and every tool an agent
// runs — read from their login shell in the background, because a Finder launch never
// ran their shell startup files; nothing waits on it but the launch-time CLI probes
void loadLoginShellPath()

app.whenReady().then(() => {
  // every handler is registered before the window exists, so nothing the renderer asks
  // can arrive before main can answer it
  services = startServices()
  registerIpc(services)

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({ mac: process.platform === 'darwin', open: (url) => void shell.openExternal(url) })
    )
  )

  // Cockpit mark in the dock — dev only: a packaged build carries it as the bundle icon,
  // and resources/ is not in the asar
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(join(app.getAppPath(), 'resources', 'icon.png'))
    } catch {
      /* icon missing — default electron icon */
    }
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// The window is gone, not the app: on macOS Cockpit stays in the Dock, and the
// watchers are what still tells the user a turn in a terminal ended or stopped to
// ask — news that matters most while no window is up. Stopping them here left the
// tree, live status and those notifications dead after the window came back, until
// a relaunch. Only the work this window started stops with it.
app.on('window-all-closed', () => {
  stopSpawnedWork()
  services?.indexer.saveCache()
  if (process.platform !== 'darwin') app.quit()
})

// ⌘Q, Quit in the menu and an update's restart all go through app.quit(), which
// closes the windows without emitting window-all-closed. Every turn runs in a
// process group of its own (so a cancel reaches its tools), which is also what lets
// it outlive Cockpit — still editing a worktree, still spending — unless it is
// stopped here. SIGTERM only: the SIGKILL a cancel escalates to later needs a timer
// this process won't be alive to run.
app.on('will-quit', () => {
  stopSpawnedWork()
  services?.indexer.stopWatchers()
  services?.indexer.saveCache()
})

/**
 * Tables first: a seat whose turn is cancelled underneath a running round reads as
 * a seat that failed, and the round would carry on and start the next one.
 */
function stopSpawnedWork(): void {
  services?.tables.stopAll()
  services?.chat.cancelAll()
  services?.sideChat.cancelAll()
}

// A downloaded update swaps itself in behind the quit the user already asked for:
// the script waits for this process to go, so nothing is interrupted that wasn't
// ending anyway. Installing from Settings arms it first and this is then a no-op.
app.on('before-quit', () => services?.updates.installOnQuit())
