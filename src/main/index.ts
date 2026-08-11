import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ChatRequest, Provider, SessionQuery, TimeFormat } from '../shared/types'
import { sanitizeEndpoint } from '../shared/endpoints'
import { SessionIndexer } from './indexer'
import { ChatManager } from './chat'
import {
  addModelEndpoint,
  bindSessionEndpoint,
  listModelEndpoints,
  loadConfig,
  removeModelEndpoint,
  saveConfig,
  sessionEndpointFor,
  setHistoryDays,
  setRepoHidden,
  setSessionArchived,
  setTimeFormat
} from './config'
import { getPrs } from './github'
import { createPr, createWorkspace } from './workspace'
import {
  assertClaudeProjectServer,
  getExtensions,
  getMcpConfig,
  removeMcp,
  shareMcp,
  shareSkill
} from './extensions'
import { loginMcp, probeMcp } from './mcp'
import {
  applyInstructions,
  getInstructions,
  saveBaseline,
  saveInstructionFile
} from './instructions'
import { getAccounts, setCopilotActiveUser } from './accounts'
import { centeredIn, readDevWindowPrefs } from './dev-window'
import { getUsage } from './usage'
import { homedir } from 'node:os'

// e2e/dev isolation only — a packaged app must never honor a data-dir override
if (!app.isPackaged && process.env['COCKPIT_USER_DATA']) {
  app.setPath('userData', resolve(process.env['COCKPIT_USER_DATA']))
}

let win: BrowserWindow | null = null
let indexer: SessionIndexer
let chat: ChatManager

/**
 * Dev-only: resolve COCKPIT_DEV_DISPLAY to concrete window bounds, and print
 * the display table so the developer can see which index is which screen.
 */
function pickDevDisplayBounds(index: number): ReturnType<typeof centeredIn> | null {
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
  return centeredIn(chosen.workArea, 1100, 760)
}

function createWindow(): void {
  // dev-only: keep `npm run dev` relaunches from stealing focus, and let the
  // window open on a chosen display — a packaged app ignores these env vars
  const devPrefs = app.isPackaged
    ? { background: false, displayIndex: null }
    : readDevWindowPrefs(process.env)
  // placing via constructor x/y (not a post-hoc setBounds) is what reliably
  // lands the window on another display under macOS separate-Spaces
  const devBounds = devPrefs.displayIndex !== null ? pickDevDisplayBounds(devPrefs.displayIndex) : null

  win = new BrowserWindow({
    show: !devPrefs.background,
    ...(devBounds ? { x: devBounds.x, y: devBounds.y } : {}),
    width: devBounds?.width ?? 1100,
    height: devBounds?.height ?? 760,
    minWidth: 560,
    minHeight: 420,
    title: 'Cockpit',
    // matches --bg in style.css so pre-paint and resize flashes stay on-theme
    backgroundColor: '#0b0d16',
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

  if (devPrefs.background) {
    const w = win
    w.once('ready-to-show', () => w.showInactive())
  }
  if (devPrefs.background || devBounds) {
    const w = win
    w.once('show', () => console.log(`[dev] window shown at ${JSON.stringify(w.getBounds())}`))
  }

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
  indexer.setHistoryDays(cfg.historyDays ?? 0)
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
    // renderer args are untrusted — an unknown provider would crash the next scan
    if (!(['claude', 'codex', 'copilot'] as Provider[]).includes(provider)) {
      throw new Error(`Unknown provider: ${String(provider)}`)
    }
    const p = resolve(String(path))
    if (!existsSync(p) || !statSync(p).isDirectory()) {
      throw new Error(`Not a directory: ${p}`)
    }
    const cfg = loadConfig()
    if (cfg.sources.some((s) => s.path === p)) return cfg.sources
    const sources = [...cfg.sources, { path: p, provider, label }]
    saveConfig({ ...cfg, sources })
    void indexer.setSources(sources)
    return sources
  })
  ipcMain.handle('sources:remove', (_e, path: string) => {
    const cfg = loadConfig()
    const sources = cfg.sources.filter((s) => s.path !== path)
    saveConfig({ ...cfg, sources })
    void indexer.setSources(sources)
    return sources
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
  ipcMain.handle('history:get', () => loadConfig().historyDays ?? 0)
  ipcMain.handle('history:set', (_e, days: number) => {
    indexer.setHistoryDays(setHistoryDays(Number(days)))
  })
  ipcMain.handle('time-format:get', () => loadConfig().timeFormat ?? '24h')
  ipcMain.handle('time-format:set', (_e, format: TimeFormat) => {
    setTimeFormat(format)
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
  // agent comes from the renderer and (for login) becomes a spawned command —
  // only ever accept the three known providers
  const asProvider = (agent: unknown): Provider => {
    if (agent === 'claude' || agent === 'codex' || agent === 'copilot') return agent
    throw new Error('unknown agent')
  }
  ipcMain.handle('extensions:remove-mcp', (_e, name: string, agent: Provider, projectPath?: string) =>
    removeMcp(String(name), asProvider(agent), projectPath ? String(projectPath) : undefined)
  )
  ipcMain.handle('extensions:check-mcp', (_e, name: string) => probeMcp(getMcpConfig(String(name))))
  ipcMain.handle('extensions:login-mcp', (_e, name: string, agent: Provider, projectPath?: string) => {
    const provider = asProvider(agent)
    // projectPath is renderer input — only trust it once it matches a claude
    // project entry read from ~/.claude.json itself
    const cwd =
      provider === 'claude' && projectPath
        ? assertClaudeProjectServer(String(name), String(projectPath))
        : undefined
    return loginMcp(String(name), provider, { cwd })
  })

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

  ipcMain.handle('endpoints:get', () => listModelEndpoints())
  ipcMain.handle('endpoints:add', (_e, input: unknown) => {
    const ep = sanitizeEndpoint(input, randomUUID())
    if (!ep) throw new Error('Invalid endpoint: a label, a type, and an http(s) base URL are required.')
    return addModelEndpoint(ep)
  })
  ipcMain.handle('endpoints:remove', (_e, id: string) => removeModelEndpoint(String(id)))

  // BYOK turns in flight: when the stream reveals the native session id, remember which
  // endpoint the session runs on so later resumes stay on that backend
  const byokTurns = new Map<string, { provider: Provider; endpointId: string }>()
  chat = new ChatManager(
    (ev) => {
      const byok = byokTurns.get(ev.turnId)
      if (byok && ev.type === 'session') {
        bindSessionEndpoint(`${byok.provider}:${ev.nativeSessionId}`, byok.endpointId)
      }
      if (ev.type === 'done') byokTurns.delete(ev.turnId)
      win?.webContents.send('chat-event', ev)
    },
    (ids) => win?.webContents.send('busy-sessions', ids),
    (id) => listModelEndpoints().find((e) => e.id === id)
  )
  ipcMain.handle('sessions:busy', () => chat.busySessions())
  ipcMain.handle('chat:send', (_e, req: ChatRequest) => {
    // a resumed BYOK session keeps the endpoint it was started with
    if (req.resumeNativeId && !req.options?.modelEndpoint) {
      const inherited = sessionEndpointFor(`${req.provider}:${req.resumeNativeId}`)
      if (inherited) req = { ...req, options: { ...req.options, modelEndpoint: inherited } }
    }
    // copilot multi-account: activate the chosen logged-in user before spawning
    if (req.provider === 'copilot' && req.copilotUser) {
      setCopilotActiveUser(req.configDir ?? join(homedir(), '.copilot'), req.copilotUser)
    }
    const turnId = chat.send(req)
    if (req.options?.modelEndpoint) {
      byokTurns.set(turnId, { provider: req.provider, endpointId: req.options.modelEndpoint })
    }
    return turnId
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
