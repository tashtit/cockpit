import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  AttentionFocus,
  AttentionPrefs,
  AttentionTarget,
  ChatRequest,
  NewRoundtableRequest,
  PermissionMode,
  Provider,
  PanelKind,
  SourceDir,
  PanelTarget,
  SessionMeta,
  SessionQuery,
  TimeFormat
} from '../shared/types'
import { sanitizeEndpoint } from '../shared/endpoints'
import { SessionIndexer } from './indexer'
import { ChatManager } from './chat'
import {
  getPanel,
  matchPanelEntry,
  removePanelEntry,
  restorePanelEntry,
  setPanelSwitch
} from './library'
import { assertChatImages, saveChatImage } from './chat-images'
import {
  addModelEndpoint,
  attentionPrefs,
  bindSessionEndpoint,
  bindSessionLineage,
  listModelEndpoints,
  loadConfig,
  removeModelEndpoint,
  saveConfig,
  sessionEndpointFor,
  setAttentionPrefs,
  updateModelEndpoint,
  sessionLineageFor,
  setHistoryDays,
  setRepoHidden,
  setSessionArchived,
  setSessionsArchived,
  setStaleDays,
  setTimeFormat
} from './config'
import { deleteSessions, removeWorktrees, scanCleanup, type CleanupDeps } from './cleanup'
import { DEFAULT_STALE_DAYS } from './cleanup-core'
import { getHandoffBriefing, improveHandoffBriefing } from './handoff'
import { getDefaultBranch, getPrs } from './github'
import { createPr, createWorkspace } from './workspace'
import { asDiffScope, getWorkspaceDiff } from './diff'
import { asPrNumber, getPrFeedback, getPrFixBriefing } from './pr-feedback'
import { RoundtableManager, type SeatInit, type TablePlace } from './roundtable'
import { clampRounds } from './roundtable-core'
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
  adoptInstructionsFrom,
  applyInstructions,
  getInstructions,
  saveBaseline,
  saveInstructionFile
} from './instructions'
import { shareInstructions } from './instructions-share'
import { getAccounts, setCopilotActiveUser } from './accounts'
import { centeredIn, readDevWindowPrefs } from './dev-window'
import { branchFromHead, parseGitdirPointer } from './repos'
import { deleteEndpointKey, getEndpointKey, setEndpointKey } from './secrets'
import {
  previewOf,
  readBackup,
  restoreBackup,
  undoRestore,
  writeBackup,
  type KeyStore
} from './backup'
import type { Bundle } from './backup-core'
import { resolveRepo } from './repos'
import { fetchEndpointModels } from './endpoint-models'
import { getUsage } from './usage'
import { getProfile } from './profile'
import { appInfo, UpdateManager } from './updates'
import { AttentionDesk, electronSurface } from './attention'
import { tableOutcome } from './attention-core'
import { homedir } from 'node:os'

// e2e/dev isolation only — a packaged app must never honor a data-dir override
if (!app.isPackaged && process.env['COCKPIT_USER_DATA']) {
  app.setPath('userData', resolve(process.env['COCKPIT_USER_DATA']))
}

let win: BrowserWindow | null = null
let indexer: SessionIndexer
let chat: ChatManager
let roundtables: RoundtableManager | null = null
let attention: AttentionDesk | null = null
/** A notification clicked while no renderer could hear it — the next one takes it. */
let pendingOpen: AttentionTarget | null = null

/**
 * Push an event to the renderer. Streams and scans outlive the window on macOS
 * (window-all-closed doesn't quit) — sending to a destroyed webContents would
 * throw inside a stream handler and take the whole main process down.
 */
function sendToWin(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * Handoffs into copilot: `copilot -p` never announces its session id on stdout, so
 * the lineage is resolved against the index instead — the next new copilot session
 * in the same cwd claims the pending entry. Best-effort by design (entries expire);
 * the renderer's in-memory chip covers the live session either way.
 */
type PendingCopilotHandoff = { cwd: string; sourceId: string; spawnedAt: number }
const pendingCopilot: PendingCopilotHandoff[] = []
const COPILOT_LINEAGE_TTL_MS = 10 * 60_000
const COPILOT_LINEAGE_MAX = 20

function resolveCopilotHandoffs(): void {
  // emitUpdate is debounced, so the setLineage below cannot re-enter synchronously;
  // the follow-up update finds this list empty and stops the cycle
  if (pendingCopilot.length === 0) return
  const now = Date.now()
  for (let i = pendingCopilot.length - 1; i >= 0; i--) {
    if (now - pendingCopilot[i].spawnedAt > COPILOT_LINEAGE_TTL_MS) pendingCopilot.splice(i, 1)
  }
  const candidates = indexer.allSessions().filter((s) => s.provider === 'copilot' && s.cwd)
  for (let i = 0; i < pendingCopilot.length; i++) {
    const p = pendingCopilot[i]
    const match = candidates
      .filter(
        (s) =>
          resolve(s.cwd as string) === resolve(p.cwd) &&
          // fs birthtime can precede the spawn timestamp slightly
          s.startedAt >= p.spawnedAt - 60_000 &&
          // never re-claim a session that already has lineage
          sessionLineageFor(s.id) === undefined
      )
      .sort((a, b) => a.startedAt - b.startedAt)[0]
    if (match) {
      try {
        indexer.setLineage(bindSessionLineage(match.id, p.sourceId))
      } catch (err) {
        console.error('[handoff] failed to persist copilot lineage:', err)
      }
      pendingCopilot.splice(i, 1)
      i--
    }
  }
}

/** Copilot never names its session: once the index has it, an id-less landing becomes that session. */
function resolveAttention(): void {
  let copilot: SessionMeta[] | null = null
  attention?.resolve((u) => {
    if (u.provider !== 'copilot' || !u.cwd) return null
    const cwd = resolve(u.cwd)
    copilot ??= indexer.allSessions().filter((s) => s.provider === 'copilot' && s.cwd)
    const match = copilot
      .filter((s) => resolve(s.cwd as string) === cwd && s.startedAt >= u.startedAt - 60_000)
      .sort((a, b) => a.startedAt - b.startedAt)[0]
    return match?.id ?? null
  })
}

/** A notification was clicked: bring the window forward and open what it was about (if anything). */
function openAttentionTarget(target: AttentionTarget | null): void {
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
  else sendToWin('attention-open', target)
}

/** What the window shows is renderer input: only ever compared, never a path — but still shaped. */
function asAttentionFocus(raw: unknown): AttentionFocus {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (f['kind'] === 'roundtable' && typeof f['id'] === 'string') {
    return { kind: 'roundtable', id: f['id'].slice(0, 512) }
  }
  const provider = (['claude', 'codex', 'copilot'] as const).find((p) => p === f['provider'])
  if (f['kind'] === 'session' && provider && typeof f['cwd'] === 'string') {
    return {
      kind: 'session',
      id: typeof f['id'] === 'string' ? f['id'].slice(0, 512) : null,
      provider,
      cwd: f['cwd'].slice(0, 4096)
    }
  }
  return { kind: 'none' }
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
  // dev-only: `npm run dev` relaunches never steal focus (COCKPIT_DEV_BACKGROUND=0
  // opts out), and the window can open on a chosen display — a packaged app
  // always fronts itself and ignores these env vars
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

  // a turn that ends while nobody is in front of the window is news (attention.ts)
  win.on('focus', () => attention?.setWindowFocused(true))
  win.on('blur', () => attention?.setWindowFocused(false))
  win.on('closed', () => {
    win = null
    attention?.setWindowFocused(false)
  })
}

/** IPC path args come from the renderer — only act on roots the indexer itself derived. */
const PANEL_KINDS: readonly PanelKind[] = ['mcp', 'skill', 'plugin', 'marketplace', 'instructions']

function asPanelKind(kind: unknown): PanelKind {
  const found = PANEL_KINDS.find((k) => k === kind)
  if (!found) throw new Error('unknown panel kind')
  return found
}

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
  indexer = new SessionIndexer(
    () => {
      resolveCopilotHandoffs()
      resolveAttention()
      sendToWin('index-updated')
    },
    { cacheFile: join(app.getPath('userData'), 'index-cache.json') }
  )
  indexer.setArchived(cfg.archived ?? [])
  indexer.setHiddenRepos(cfg.hiddenRepos ?? [])
  indexer.setHistoryDays(cfg.historyDays ?? 0)
  indexer.setLineage(cfg.continuedFrom ?? {})
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
  ipcMain.handle('sessions:get', (_e, id: string) => indexer.getSession(String(id)))
  ipcMain.handle('sessions:messages', (_e, id: string) => indexer.getMessages(id))
  ipcMain.handle('handoff:briefing', (_e, id: string) => getHandoffBriefing(indexer, String(id)))
  ipcMain.handle('handoff:improve', (_e, id: string) => improveHandoffBriefing(indexer, String(id)))
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
  ipcMain.handle('github:default-branch', (_e, repoRoot: string) =>
    getDefaultBranch(assertKnownRepoRoot(repoRoot))
  )
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
  // review before landing: the diff is read-only, so any dir a chat may run in is
  // fair to inspect; the scope is renderer input and is re-checked before it
  // selects git arguments
  ipcMain.handle('workspace:diff', (_e, cwd: string, scope: unknown) =>
    getWorkspaceDiff(assertKnownCwd(cwd), asDiffScope(scope))
  )
  // an open PR's feedback and its fix prompt: the root is one the indexer derived,
  // and the number is renderer input that only ever reaches gh as a positive integer
  ipcMain.handle('github:pr-feedback', (_e, repoRoot: string, n: unknown) =>
    getPrFeedback(assertKnownRepoRoot(repoRoot), asPrNumber(n))
  )
  ipcMain.handle('github:pr-fix', (_e, repoRoot: string, n: unknown) =>
    getPrFixBriefing(assertKnownRepoRoot(repoRoot), asPrNumber(n))
  )
  ipcMain.handle('extensions:get', () => getExtensions())
  // agent comes from the renderer and (for login) becomes a spawned command —
  // only ever accept the three known providers
  const asProvider = (agent: unknown): Provider => {
    if (agent === 'claude' || agent === 'codex' || agent === 'copilot') return agent
    throw new Error('unknown agent')
  }
  /*
   * The panel: Cockpit's own config for one scope. A scope is either global or a
   * repo root the indexer itself derived — never an arbitrary renderer path, since
   * these handlers write config files and run agent CLIs inside it.
   */
  const asScope = (repoRoot: unknown): string | null =>
    repoRoot === null || repoRoot === undefined ? null : assertKnownRepoRoot(repoRoot)
  const asTarget = (t: PanelTarget): PanelTarget => ({
    repoRoot: asScope(t?.repoRoot),
    kind: asPanelKind(t?.kind),
    name: String(t?.name ?? '')
  })
  ipcMain.handle('panel:get', (_e, repoRoot: string | null) => getPanel(asScope(repoRoot)))
  ipcMain.handle('panel:set-switch', (_e, target: PanelTarget, agent: Provider, on: boolean) =>
    setPanelSwitch(asTarget(target), asProvider(agent), Boolean(on))
  )
  ipcMain.handle('panel:match', (_e, target: PanelTarget, source: Provider) =>
    matchPanelEntry(asTarget(target), asProvider(source))
  )
  ipcMain.handle('panel:remove', (_e, target: PanelTarget) => removePanelEntry(asTarget(target)))
  ipcMain.handle('panel:restore', (_e, target: PanelTarget) => restorePanelEntry(asTarget(target)))
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
  ipcMain.handle('instructions:adopt-file', (_e, repoRoot: string | null, path: string) =>
    adoptInstructionsFrom(instructionScope(repoRoot), String(path))
  )
  ipcMain.handle('instructions:share', (_e, repoRoot: string) =>
    shareInstructions(assertKnownRepoRoot(repoRoot))
  )
  ipcMain.handle('shell:open', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return Promise.resolve()
  })

  ipcMain.handle('accounts:get', () => getAccounts(loadConfig().sources))
  ipcMain.handle('usage:get', () => getUsage(loadConfig().sources))
  ipcMain.handle('profile:get', () => getProfile(indexer.allSessions(), loadConfig().sources))

  // app updates from GitHub Releases — the manager refuses everything but an installed
  // macOS build, so dev runs and e2e never reach the network
  const updates = new UpdateManager((state) => sendToWin('update-state', state))
  ipcMain.handle('app:info', () => appInfo())
  ipcMain.handle('updates:get', () => updates.current)
  ipcMain.handle('updates:check', () => updates.check())
  ipcMain.handle('updates:download', () => updates.download())
  ipcMain.handle('updates:install', () => {
    // the installer quits the app — persist the index first, as window-all-closed does
    if (updates.current.status !== 'ready') return
    indexer.saveCache()
    updates.install()
  })

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
  ipcMain.handle('endpoints:set-key', (_e, id: string, apiKey: string) => {
    const ep = listModelEndpoints().find((e) => e.id === String(id))
    if (!ep) throw new Error('Unknown model provider.')
    const key = String(apiKey).trim()
    if (!key || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error('Invalid API key value.')
    setEndpointKey(ep.id, key) // throws before anything is saved if the keychain is unavailable
    updateModelEndpoint({ ...ep, hasKey: true })
    return listModelEndpoints()
  })
  ipcMain.handle('endpoints:models', (_e, id: string) => {
    const ep = listModelEndpoints().find((e) => e.id === String(id))
    if (!ep) throw new Error('Unknown model provider.')
    return fetchEndpointModels(ep, ep.hasKey ? getEndpointKey(ep.id) : undefined)
  })

  /* backup: a file the user keeps, restorable here or on another Mac */

  const keyStore: KeyStore = {
    get: (id) => getEndpointKey(id),
    set: (id, key) => setEndpointKey(id, key),
    remove: (id) => deleteEndpointKey(id)
  }
  /** The indexer's own repo key is the portable one — `gh:owner/repo`, else the root. */
  const refFor = (repoRoot: string): string => {
    const fullName = resolveRepo(repoRoot)?.repo.fullName
    return fullName ? `gh:${fullName.toLowerCase()}` : repoRoot
  }
  /**
   * Every repo the index has ever seen, not just the ones the history window shows:
   * a machine set up from a backup has old sessions, and a repo hidden behind the
   * window would otherwise look like it isn't here at all.
   */
  const knownRepos = (): ReadonlyMap<string, string> => {
    const map = new Map<string, string>()
    for (const s of indexer.allSessions()) {
      if (s.repo?.root && !map.has(s.repo.key)) map.set(s.repo.key, s.repo.root)
    }
    return map
  }
  const restoreDeps = {
    keys: keyStore,
    knownRepos,
    syncSources: (sources: readonly SourceDir[]) => indexer.setSources([...sources])
  }
  /** A restored config only reaches the tree once the indexer is told about it. */
  const republishConfig = (): void => {
    const cfg = loadConfig()
    indexer.setArchived(cfg.archived ?? [])
    indexer.setHiddenRepos(cfg.hiddenRepos ?? [])
    indexer.setHistoryDays(cfg.historyDays ?? 0)
    indexer.setLineage(cfg.continuedFrom ?? {})
    void indexer.setSources(cfg.sources)
    sendToWin('index-updated')
  }
  /** Parsed files waiting for a confirmed restore — one slot, and it goes stale. */
  const pendingBackups = new Map<string, { bundle: Bundle; at: number }>()
  const BACKUP_TOKEN_TTL_MS = 10 * 60 * 1000
  const takePending = (token: string): Bundle => {
    const found = pendingBackups.get(String(token))
    if (!found || Date.now() - found.at > BACKUP_TOKEN_TTL_MS) {
      pendingBackups.delete(String(token))
      throw new Error('that backup is no longer open — choose the file again')
    }
    return found.bundle
  }

  ipcMain.handle('backup:export', async (_e, passphrase?: string) => {
    // main-process dialog: the renderer never supplies a path, it receives one
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export Cockpit backup',
      defaultPath: join(app.getPath('downloads'), `cockpit-backup-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'Cockpit backup', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    return writeBackup(res.filePath, {
      keys: keyStore,
      refFor,
      appVersion: app.getVersion()
    }, passphrase === undefined ? undefined : String(passphrase))
  })
  ipcMain.handle('backup:open', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Restore from a Cockpit backup',
      defaultPath: app.getPath('downloads'),
      filters: [{ name: 'Cockpit backup', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const bundle = readBackup(res.filePaths[0])
    const token = randomUUID()
    pendingBackups.clear()
    pendingBackups.set(token, { bundle, at: Date.now() })
    return previewOf(bundle, token, knownRepos())
  })
  ipcMain.handle('backup:restore', async (_e, token: string, passphrase?: string) => {
    const bundle = takePending(token)
    const summary = await restoreBackup(
      bundle,
      restoreDeps,
      passphrase === undefined ? undefined : String(passphrase)
    )
    // a wrong passphrase throws before this line, so the file stays open to retry
    pendingBackups.delete(String(token))
    republishConfig()
    return summary
  })
  ipcMain.handle('backup:undo-restore', (_e, undoId: string) => {
    undoRestore(String(undoId), keyStore)
    republishConfig()
  })

  /*
   * Attention: a notification, a sound and the Dock badge when a turn ends unseen.
   * attention-core decides, the desk carries it out; the renderer reports what is on
   * screen and the window's focus events say whether anyone is in front of it.
   */
  const desk = new AttentionDesk({
    file: join(app.getPath('userData'), 'attention.json'),
    surface: electronSurface(),
    prefs: attentionPrefs(),
    titleFor: (u) => (u.id ? (indexer.getSession(u.id)?.title ?? null) : null),
    onLandings: (landings) => sendToWin('landings', landings),
    onOpen: openAttentionTarget
  })
  attention = desk
  ipcMain.handle('attention:prefs', () => desk.currentPrefs)
  ipcMain.handle('attention:set-prefs', (_e, prefs: AttentionPrefs) => {
    const saved = setAttentionPrefs(prefs)
    desk.setPrefs(saved)
    return saved
  })
  ipcMain.handle('attention:test', () => desk.test())
  ipcMain.handle('attention:focus', (_e, focus: unknown) => desk.setFocus(asAttentionFocus(focus)))
  ipcMain.handle('attention:landings', () => desk.landings())
  ipcMain.handle('attention:take-open', () => {
    const target = pendingOpen
    pendingOpen = null
    return target
  })

  // BYOK turns in flight: when the stream reveals the native session id, remember which
  // endpoint the session runs on so later resumes stay on that backend
  const byokTurns = new Map<string, { provider: Provider; endpointId: string }>()
  // Handoff turns in flight: same lifecycle, persisting continuedFrom lineage instead
  const handoffTurns = new Map<string, { provider: Provider; sourceId: string }>()
  chat = new ChatManager(
    (ev) => {
      // roundtable turns stream on their own channel — never as plain chat events
      if (roundtables?.handleChatEvent(ev)) return
      const byok = byokTurns.get(ev.turnId)
      if (byok && ev.type === 'session') {
        try {
          bindSessionEndpoint(`${byok.provider}:${ev.nativeSessionId}`, byok.endpointId)
        } catch (err) {
          // a config-write failure must not blow up inside the stream handler
          console.error('[chat] failed to persist session endpoint binding:', err)
        }
      }
      const handoff = handoffTurns.get(ev.turnId)
      if (handoff && ev.type === 'session') {
        try {
          indexer.setLineage(
            bindSessionLineage(`${handoff.provider}:${ev.nativeSessionId}`, handoff.sourceId)
          )
        } catch (err) {
          console.error('[chat] failed to persist handoff lineage:', err)
        }
      }
      if (ev.type === 'done') {
        byokTurns.delete(ev.turnId)
        handoffTurns.delete(ev.turnId)
      }
      desk.chatEvent(ev)
      sendToWin('chat-event', ev)
    },
    {
      onBusyChange: (ids) => sendToWin('busy-sessions', ids),
      onTurnStart: (turnId, req) => {
        // a seat's turn is its table's business — the table lands once, as a whole
        if (roundtables?.tableIdForCwd(req.cwd)) return
        desk.turnStarted({
          turnId,
          provider: req.provider,
          cwd: req.cwd,
          prompt: req.prompt,
          resumeNativeId: req.resumeNativeId
        })
      },
      onTurnCancel: (turnId) => desk.turnCancelled(turnId),
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
    // the handoff source is renderer input — only accept sessions the index knows
    if (req.handoffFrom !== undefined) {
      const src = String(req.handoffFrom)
      const source = src.length > 256 ? null : indexer.getSession(src)
      if (!source) throw new Error(`unknown handoff source: ${src.slice(0, 80)}`)
      // a seat-session is a table's internal, not a conversation of the user's —
      // handing off from one would seed a writable session with relay scaffolding
      if (source.cwd && roundtables?.tableIdForCwd(source.cwd)) {
        throw new Error('Roundtable seat sessions cannot be handed off — start from the table.')
      }
      req = { ...req, handoffFrom: src }
    }
    // roundtable rooms are driven only by their table's round loop — a seat-session
    // opened from the debug list is read-only for now
    if (roundtables?.tableIdForCwd(req.cwd)) {
      throw new Error('This session belongs to a roundtable — talk to it at the table instead.')
    }
    // copilot multi-account: activate the chosen logged-in user before spawning
    if (req.provider === 'copilot' && req.copilotUser) {
      setCopilotActiveUser(req.configDir ?? join(homedir(), '.copilot'), req.copilotUser)
    }
    const turnId = chat.send(req)
    if (req.options?.modelEndpoint) {
      byokTurns.set(turnId, { provider: req.provider, endpointId: req.options.modelEndpoint })
    }
    if (req.handoffFrom) {
      if (req.provider === 'copilot') {
        pendingCopilot.push({ cwd: req.cwd, sourceId: req.handoffFrom, spawnedAt: Date.now() })
        if (pendingCopilot.length > COPILOT_LINEAGE_MAX) pendingCopilot.shift()
      } else {
        handoffTurns.set(turnId, { provider: req.provider, sourceId: req.handoffFrom })
      }
    } else if (req.resumeNativeId && req.provider !== 'copilot') {
      // claude mints a fresh native id per resumed turn — the new id must keep the
      // lineage of the id it resumed (the sessionEndpointFor pattern above)
      const lineage = sessionLineageFor(`${req.provider}:${req.resumeNativeId}`)
      if (lineage) handoffTurns.set(turnId, { provider: req.provider, sourceId: lineage })
    }
    return turnId
  })
  ipcMain.handle('chat:cancel', (_e, turnId: string) => chat.cancel(turnId))

  // roundtables: several agents, one shared discussion, driven through the same
  // ChatManager (its emit hands their stream events to the manager above)
  const tables = new RoundtableManager(join(app.getPath('userData'), 'roundtables'), {
    sendTurn: (req) => chat.send(req),
    cancelTurn: (turnId) => chat.cancel(turnId),
    emit: (ev) => {
      sendToWin('roundtable-event', ev)
      // a table's run ending is news the way a turn's is — unless the user stopped it
      if (ev.type !== 'round' || ev.running || ev.stopped) return
      try {
        const t = tables.get(ev.id)
        desk.tableEnded({ id: t.id, title: t.title, outcome: tableOutcome(t) })
      } catch {
        /* the table is gone */
      }
    }
  })
  roundtables = tables
  // seat-sessions (anything whose cwd is a table's room/worktree) leave the normal
  // session listings and page only under their table
  indexer.setRoundtableResolver((cwd) => tables.tableIdForCwd(cwd))
  ipcMain.handle('roundtable:list', () => tables.list())
  ipcMain.handle('roundtable:get', (_e, id: string) => tables.get(String(id)))
  ipcMain.handle('roundtable:create', async (_e, req: NewRoundtableRequest) => {
    const topic = String(req?.topic ?? '').trim()
    if (!topic) throw new Error('A topic is required.')
    if (topic.length > 20_000) throw new Error('Topic is too long.')
    // seats are renderer input: known providers only (a provider may repeat with a
    // different model), and any config home re-validated against main-derived
    // sources before a CLI runs on it. Discussion-only — no permission mode exists.
    const seats: SeatInit[] = []
    for (const raw of Array.isArray(req?.seats) ? req.seats : []) {
      const provider = asProvider(raw?.provider)
      const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined
      seats.push({
        provider,
        configDir:
          raw.configDir === undefined ? undefined : assertKnownConfigDir(raw.configDir, provider),
        copilotUser: raw.copilotUser === undefined ? undefined : String(raw.copilotUser),
        accountLabel:
          raw.accountLabel === undefined ? undefined : String(raw.accountLabel).slice(0, 200),
        options: model ? { model } : undefined
      })
    }
    if (seats.length < 2) throw new Error('Pick at least two seats for a roundtable.')
    if (seats.length > 4) throw new Error('A table seats at most four.')
    // consensus knobs are renderer input: whitelist the mode, clamp the round cap
    const tableMode = req?.mode === 'consensus' ? 'consensus' : 'open'
    const maxRounds = clampRounds(req?.maxRounds)
    let place: TablePlace | null = null
    if (req.repoRoot !== null && req.repoRoot !== undefined) {
      const root = assertKnownRepoRoot(req.repoRoot)
      const ws = await createWorkspace(root, `table ${topic.slice(0, 30)}`)
      place = { cwd: ws.cwd, branch: ws.branch, repoRoot: root }
    }
    return tables.create({ topic, seats, mode: tableMode, maxRounds }, place)
  })
  ipcMain.handle('roundtable:send', (_e, id: string, text: string) =>
    tables.sendMessage(String(id), String(text))
  )
  ipcMain.handle('roundtable:continue', (_e, id: string) => tables.continueRound(String(id)))
  ipcMain.handle('roundtable:stop', (_e, id: string) => tables.stop(String(id)))

  /*
   * Cleanup: the cross-agent, cross-repo view of what has gone stale. Every input
   * it acts on is main-derived — session ids are re-looked-up in the index and
   * their files re-checked against the configured sources, and worktree paths are
   * re-derived from git before a single one is removed (see cleanup.ts).
   */
  const cleanupDeps = (): CleanupDeps => ({
    sessions: () => indexer.cleanupSessions(),
    repoRoots: () => [...indexer.knownRepoRoots()],
    cockpitWorktreeRoot: worktreesDir(),
    busyIds: () => new Set(chat.busySessions().map((b) => b.id)),
    tableForCwd: (cwd) => roundtables?.tableIdForCwd(cwd) ?? null,
    sourceDirs: () => loadConfig().sources.map((s) => s.path)
  })
  /** Renderer id lists are untrusted and unbounded — cap and stringify them here. */
  const asIdList = (raw: unknown): string[] =>
    (Array.isArray(raw) ? raw : []).slice(0, 5000).map((v) => String(v))
  ipcMain.handle('cleanup:stale-days', () => loadConfig().staleDays ?? DEFAULT_STALE_DAYS)
  ipcMain.handle('cleanup:set-stale-days', (_e, days: number) => {
    setStaleDays(Number(days))
  })
  ipcMain.handle('cleanup:scan', () =>
    scanCleanup(cleanupDeps(), loadConfig().staleDays ?? DEFAULT_STALE_DAYS)
  )
  ipcMain.handle('cleanup:archive-sessions', (_e, ids: string[]) => {
    // the reversible tier: config only, nothing on disk is touched
    const known = new Set(indexer.cleanupSessions().map((s) => s.id))
    const wanted = asIdList(ids).filter((id) => known.has(id))
    indexer.setArchived(setSessionsArchived(wanted, true))
    return { cleaned: wanted.length, freedBytes: 0, failed: [] }
  })
  ipcMain.handle('cleanup:delete-sessions', async (_e, ids: string[]) => {
    const wanted = asIdList(ids)
    // the same threshold the scan used, so the cascade can only take worktrees the
    // user was actually shown as going with these sessions
    const result = await deleteSessions(
      cleanupDeps(),
      wanted,
      loadConfig().staleDays ?? DEFAULT_STALE_DAYS
    )
    // an archived id whose file is gone is dead config — drop it, then re-index so
    // the tree stops offering sessions that no longer exist
    indexer.setArchived(setSessionsArchived(wanted, false))
    await indexer.rescan()
    return result
  })
  ipcMain.handle('cleanup:remove-worktrees', async (_e, paths: string[]) => {
    const result = await removeWorktrees(cleanupDeps(), asIdList(paths))
    await indexer.rescan()
    return result
  })

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

app.on('window-all-closed', () => {
  indexer?.stopWatchers()
  indexer?.saveCache()
  chat?.cancelAll()
  if (process.platform !== 'darwin') app.quit()
})
