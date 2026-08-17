import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ChatRequest, Provider, SessionQuery, TimeFormat } from '../shared/types'
import { sanitizeEndpoint } from '../shared/endpoints'
import { SessionIndexer } from './indexer'
import { ChatManager } from './chat'
import { assertChatImages, saveChatImage } from './chat-images'
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
import { branchFromHead, centeredIn, parseGitdirPointer, readDevWindowPrefs } from './dev-window'
import { deleteEndpointKey, getEndpointKey, setEndpointKey } from './secrets'
import { fetchEndpointModels } from './endpoint-models'
import { getUsage } from './usage'
import { getProfile } from './profile'
import { homedir } from 'node:os'

// e2e/dev isolation only — a packaged app must never honor a data-dir override
if (!app.isPackaged && process.env['COCKPIT_USER_DATA']) {
  app.setPath('userData', resolve(process.env['COCKPIT_USER_DATA']))
}

let win: BrowserWindow | null = null
let indexer: SessionIndexer
let chat: ChatManager

/**
 * Push an event to the renderer. Streams and scans outlive the window on macOS
 * (window-all-closed doesn't quit) — sending to a destroyed webContents would
 * throw inside a stream handler and take the whole main process down.
 */
function sendToWin(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

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

/**
 * Dev-only: the branch of the checkout `npm run dev` runs from, so parallel
 * dev instances from different worktrees are tellable apart. Best-effort —
 * anything unexpected (no repo, odd formats) quietly yields null.
 */
function readDevBranch(): string | null {
  try {
    const root = app.getAppPath()
    const dotGit = join(root, '.git')
    let gitDir = dotGit
    if (statSync(dotGit).isFile()) {
      const target = parseGitdirPointer(readFileSync(dotGit, 'utf8'))
      if (!target) return null
      gitDir = resolve(root, target)
    }
    return branchFromHead(readFileSync(join(gitDir, 'HEAD'), 'utf8'))
  } catch {
    return null
  }
}

function createWindow(): void {
  // dev-only: keep `npm run dev` relaunches from stealing focus, and let the
  // window open on a chosen display — a packaged app ignores these env vars
  const devPrefs = app.isPackaged
    ? { background: false, displayIndex: null }
    : readDevWindowPrefs(process.env)
  // dev-only: brand the window with the source branch (title + top banner)
  const devBranch = app.isPackaged ? null : readDevBranch()
  // placing via constructor x/y (not a post-hoc setBounds) is what reliably
  // lands the window on another display under macOS separate-Spaces
  const devBounds = devPrefs.displayIndex !== null ? pickDevDisplayBounds(devPrefs.displayIndex) : null

  win = new BrowserWindow({
    show: !devPrefs.background,
    ...(devBounds ? { x: devBounds.x, y: devBounds.y } : {}),
    width: devBounds?.width ?? 1100,
    height: devBounds?.height ?? 760,
    // the supported floor — the e2e minimum-size gate audits the layout at
    // exactly these numbers; change them together or the gate fails
    minWidth: 560,
    minHeight: 420,
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
    // the branch rides in as a query param — no IPC surface for a dev-only affordance
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (devBranch) url.searchParams.set('devBranch', devBranch)
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    win = null
  })
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

/** Where pasted chat images live — the only root chat:send accepts image paths from. */
function chatImagesDir(): string {
  return join(app.getPath('userData'), 'chat-images')
}

/**
 * A chat turn spawns an autonomous CLI agent in `cwd` — the renderer must only be
 * able to point it at directories the app itself derived: the app's worktrees, a
 * known repo root (or below), or the recorded cwd of an indexed session.
 */
function assertKnownCwd(cwd: unknown): string {
  if (typeof cwd !== 'string') throw new Error('invalid working directory')
  const c = resolve(cwd)
  if (c === worktreesDir() || c.startsWith(worktreesDir() + '/')) return c
  if ([...indexer.knownRepoRoots()].some((r) => c === r || c.startsWith(r + '/'))) return c
  if (indexer.knownSessionCwds().has(c)) return c
  throw new Error(`unknown working directory: ${c}`)
}

/** Config homes are main-derived too: only a configured source (or the provider default). */
function assertKnownConfigDir(configDir: unknown, provider: Provider): string {
  if (typeof configDir !== 'string') throw new Error('invalid config home')
  // `provider` is renderer input with a compile-time-only type — it is about to be
  // interpolated into a path, so re-check it here rather than trusting the caller
  if (!(['claude', 'codex', 'copilot'] as Provider[]).includes(provider)) {
    throw new Error('unknown agent')
  }
  const c = resolve(configDir)
  if (c === join(homedir(), `.${provider}`)) return c
  const known = loadConfig().sources.some((s) => s.provider === provider && resolve(s.path) === c)
  if (!known) throw new Error(`unknown ${provider} config home: ${c}`)
  return c
}

app.whenReady().then(() => {
  const cfg = loadConfig()
  indexer = new SessionIndexer(() => sendToWin('index-updated'), {
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
  ipcMain.handle('profile:get', () => getProfile(indexer.allSessions(), loadConfig().sources))

  ipcMain.handle('endpoints:get', () => listModelEndpoints())
  ipcMain.handle('endpoints:add', (_e, input: unknown) => {
    // the key never enters the endpoint definition — strip it, encrypt it separately
    const { apiKey, ...def } = (input ?? {}) as { apiKey?: unknown }
    const ep = sanitizeEndpoint(def, randomUUID())
    if (!ep) {
      throw new Error('Invalid provider: a name, a type, an http(s) base URL, and well-formed headers are required.')
    }
    const key = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (key) {
      if (key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error('Invalid API key value.')
      setEndpointKey(ep.id, key) // throws before anything is saved if the keychain is unavailable
    }
    return addModelEndpoint(key ? { ...ep, hasKey: true } : ep)
  })
  ipcMain.handle('endpoints:remove', (_e, id: string) => {
    deleteEndpointKey(String(id))
    return removeModelEndpoint(String(id))
  })
  ipcMain.handle('endpoints:models', (_e, id: string) => {
    const ep = listModelEndpoints().find((e) => e.id === String(id))
    if (!ep) throw new Error('Unknown model provider.')
    return fetchEndpointModels(ep, ep.hasKey ? getEndpointKey(ep.id) : undefined)
  })

  // BYOK turns in flight: when the stream reveals the native session id, remember which
  // endpoint the session runs on so later resumes stay on that backend
  const byokTurns = new Map<string, { provider: Provider; endpointId: string }>()
  chat = new ChatManager(
    (ev) => {
      const byok = byokTurns.get(ev.turnId)
      if (byok && ev.type === 'session') {
        try {
          bindSessionEndpoint(`${byok.provider}:${ev.nativeSessionId}`, byok.endpointId)
        } catch (err) {
          // a config-write failure must not blow up inside the stream handler
          console.error('[chat] failed to persist session endpoint binding:', err)
        }
      }
      if (ev.type === 'done') byokTurns.delete(ev.turnId)
      sendToWin('chat-event', ev)
    },
    {
      onBusyChange: (ids) => sendToWin('busy-sessions', ids),
      resolveEndpoint: (id) => listModelEndpoints().find((e) => e.id === id),
      resolveKey: (ep) => getEndpointKey(ep.id)
    }
  )
  ipcMain.handle('sessions:busy', () => chat.busySessions())
  ipcMain.handle('chat:save-image', (_e, data: Uint8Array, mime: string) =>
    saveChatImage(chatImagesDir(), data, mime)
  )
  ipcMain.handle('chat:send', (_e, req: ChatRequest) => {
    // pasted-image paths are renderer input — only accept files chat:save-image wrote
    {
      const { images: rawImages, ...rest } = req
      const images = assertChatImages(chatImagesDir(), rawImages)
      req = images ? { ...rest, images } : rest
    }
    // the working directory and config home are renderer input too — both must
    // come from app-derived state before a provider CLI is spawned against them
    req = {
      ...req,
      cwd: assertKnownCwd(req.cwd),
      configDir:
        req.configDir === undefined ? undefined : assertKnownConfigDir(req.configDir, req.provider)
    }
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
