import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ChatRequest, Provider, SessionQuery } from '../shared/types'
import { SessionIndexer } from './indexer'
import { ChatManager } from './chat'
import { loadConfig, saveConfig, setRepoHidden, setSessionArchived } from './config'
import { getPrs } from './github'
import { createPr, createWorkspace } from './workspace'
import { getExtensions, shareMcp, shareSkill } from './extensions'
import {
  applyInstructions,
  getInstructions,
  saveBaseline,
  saveInstructionFile
} from './instructions'
import { getAccounts, setCopilotActiveUser } from './accounts'
import { getUsage } from './usage'
import { homedir } from 'node:os'

// e2e/dev isolation only — a packaged app must never honor a data-dir override
if (!app.isPackaged && process.env['COCKPIT_USER_DATA']) {
  app.setPath('userData', resolve(process.env['COCKPIT_USER_DATA']))
}

let win: BrowserWindow | null = null
let indexer: SessionIndexer
let chat: ChatManager

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 560,
    minHeight: 420,
    title: 'Cockpit',
    backgroundColor: '#0b0d12',
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
    if (!app.isPackaged && devUrl && url.startsWith(devUrl)) return
    e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // pinch-zoom would silently distort the layout — keyboard zoom (⌘+/-) stays available
  void win.webContents.setVisualZoomLevelLimits(1, 1)

  // dev-server URL only in dev — a packaged app must never load an env-supplied origin
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** IPC path args come from the renderer — only act on roots the indexer itself derived. */
function assertKnownRepoRoot(repoRoot: unknown): string {
  if (typeof repoRoot !== 'string') throw new Error('invalid repo root')
  const r = resolve(repoRoot)
  if (!indexer.knownRepoRoots().has(r)) throw new Error(`unknown repo root: ${r}`)
  return r
}

function worktreesDir(): string {
  return join(app.getPath('userData'), 'worktrees')
}

app.whenReady().then(() => {
  const cfg = loadConfig()
  indexer = new SessionIndexer(() => win?.webContents.send('index-updated'), {
    cacheFile: join(app.getPath('userData'), 'index-cache.json')
  })
  indexer.setArchived(cfg.archived ?? [])
  indexer.setHiddenRepos(cfg.hiddenRepos ?? [])
  void indexer.setSources(cfg.sources)

  ipcMain.handle('sources:get', () => loadConfig().sources)
  ipcMain.handle('sources:stats', () => indexer.sourceStats(loadConfig().sources))
  ipcMain.handle('sources:pick-dir', async () => {
    // main-process dialog: the renderer never supplies a path, it receives one
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose a config home to index',
      defaultPath: homedir(),
      properties: ['openDirectory', 'showHiddenFiles']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })
  ipcMain.handle('sources:add', (_e, path: string, provider: Provider, label: string) => {
    const p = resolve(String(path))
    if (!existsSync(p) || !statSync(p).isDirectory()) {
      throw new Error(`Not a directory: ${p}`)
    }
    const cfg = loadConfig()
    if (!cfg.sources.some((s) => s.path === p)) {
      cfg.sources.push({ path: p, provider, label })
      saveConfig(cfg)
      void indexer.setSources(cfg.sources)
    }
    return cfg.sources
  })
  ipcMain.handle('sources:remove', (_e, path: string) => {
    const cfg = loadConfig()
    cfg.sources = cfg.sources.filter((s) => s.path !== path)
    saveConfig(cfg)
    void indexer.setSources(cfg.sources)
    return cfg.sources
  })
  ipcMain.handle('repos:list', () => indexer.listRepos())
  ipcMain.handle('sessions:page', (_e, query: SessionQuery) => indexer.page(query))
  ipcMain.handle('sessions:messages', (_e, id: string) => indexer.getMessages(id))
  ipcMain.handle('sessions:archive', (_e, id: string, archived: boolean) => {
    indexer.setArchived(setSessionArchived(id, archived))
  })
  ipcMain.handle('repos:set-hidden', (_e, key: string, hidden: boolean) => {
    indexer.setHiddenRepos(setRepoHidden(String(key), Boolean(hidden)))
  })
  ipcMain.handle('github:prs', (_e, repoRoot: string) => getPrs(assertKnownRepoRoot(repoRoot)))
  ipcMain.handle('workspace:create', (_e, repoRoot: string, name?: string) =>
    createWorkspace(assertKnownRepoRoot(repoRoot), name)
  )
  ipcMain.handle('workspace:pr', (_e, cwd: string) => {
    const c = resolve(String(cwd))
    const underWorktrees = c.startsWith(worktreesDir() + '/')
    const underKnownRoot = [...indexer.knownRepoRoots()].some(
      (r) => c === r || c.startsWith(r + '/')
    )
    if (!underWorktrees && !underKnownRoot) throw new Error(`unknown workspace: ${c}`)
    return createPr(c)
  })
  ipcMain.handle('extensions:get', () => getExtensions())
  ipcMain.handle('extensions:share-mcp', (_e, name: string, to: Provider) => shareMcp(name, to))
  ipcMain.handle('extensions:share-skill', (_e, name: string, from: Provider, to: Provider) =>
    shareSkill(name, from, to)
  )

  // instruction scopes come from the renderer — null = global, else a repo the
  // indexer itself derived (never an arbitrary path)
  const instructionScope = (repoRoot: unknown): string | null =>
    repoRoot === null ? null : assertKnownRepoRoot(repoRoot)
  ipcMain.handle('instructions:get', (_e, repoRoot: string | null) =>
    getInstructions(instructionScope(repoRoot))
  )
  ipcMain.handle('instructions:save-baseline', (_e, repoRoot: string | null, baseline: string) =>
    saveBaseline(instructionScope(repoRoot), String(baseline))
  )
  ipcMain.handle('instructions:apply', (_e, repoRoot: string | null, onlyPath?: string) =>
    applyInstructions(instructionScope(repoRoot), onlyPath ? String(onlyPath) : undefined)
  )
  ipcMain.handle(
    'instructions:save-file',
    (_e, repoRoot: string | null, path: string, content: string) =>
      saveInstructionFile(instructionScope(repoRoot), String(path), String(content))
  )
  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })

  ipcMain.handle('accounts:get', () => getAccounts(loadConfig().sources))
  ipcMain.handle('usage:get', () => getUsage(loadConfig().sources))

  chat = new ChatManager((ev) => win?.webContents.send('chat-event', ev))
  ipcMain.handle('chat:send', (_e, req: ChatRequest) => {
    // copilot multi-account: activate the chosen logged-in user before spawning
    if (req.provider === 'copilot' && req.copilotUser) {
      setCopilotActiveUser(req.configDir ?? join(homedir(), '.copilot'), req.copilotUser)
    }
    return chat.send(req)
  })
  ipcMain.handle('chat:cancel', (_e, turnId: string) => chat.cancel(turnId))

  // Cockpit mark in the dock (packaged builds get it via the bundle icon instead)
  if (process.platform === 'darwin') {
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

app.on('window-all-closed', () => {
  indexer?.stopWatchers()
  indexer?.saveCache()
  chat?.cancelAll()
  if (process.platform !== 'darwin') app.quit()
})
