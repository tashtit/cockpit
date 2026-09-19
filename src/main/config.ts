import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type {
  AcpAgent,
  AttentionPrefs,
  LibraryEntry,
  ModelEndpoint,
  SourceDir,
  TimeFormat,
  UpdatePrefs
} from '../shared/types'
import { clampStaleDays } from './cleanup-core'
import { sanitizeAcpAgent } from '../shared/acp'
import { clampZoom, type WindowPlacement } from '../shared/window'

export type AppConfig = {
  readonly sources: SourceDir[]
  /** Session ids the user archived in Cockpit (provider logs have no such flag) */
  readonly archived?: string[]
  /** Roundtable ids the user archived — the tables themselves stay on disk */
  readonly archivedRoundtables?: string[]
  /** Shared AI instruction baselines — fanned out into each agent's own file */
  readonly sharedInstructions?: {
    readonly global?: string
    /** Keyed by repo root path */
    readonly repos?: Record<string, string>
  }
  /**
   * Cockpit's own config: what it manages and which agents it is switched on for.
   * Separate from the agents' configs on purpose — an entry survives being switched
   * off everywhere, which is what makes a switch reversible rather than a delete.
   */
  readonly library?: {
    readonly global?: LibraryEntry[]
    /** Keyed by repo root path, like sharedInstructions */
    readonly repos?: Record<string, LibraryEntry[]>
  }
  /** Repo keys the user chose not to display (everything is visible by default) */
  readonly hiddenRepos?: string[]
  /** Repo keys in the order the user dragged them into; absent/empty = A→Z */
  readonly repoOrder?: string[]
  /** Days of history to display — sessions idle longer are hidden; 0/absent = all */
  readonly historyDays?: number
  /** Idle threshold the cleanup view calls stale, in days; absent = 30 */
  readonly staleDays?: number
  /** Clock format for session times in the UI; absent = 24h */
  readonly timeFormat?: TimeFormat
  /**
   * Interface zoom the user last set, as a webFrame factor; absent = 100%. Main
   * restores it before the window paints, because it also decides the window's
   * minimum size (`zoomedFloor`) — a level restored by the renderer after load
   * would mean a window that spends its first frames under the layout's floor.
   */
  readonly zoom?: number
  /**
   * Where the window was when it last closed — position, windowed size and whether
   * it was full screen. Restored on launch so an update, which replaces the whole
   * bundle, does not also move the app to a different size on a different screen.
   */
  readonly window?: WindowPlacement
  /** User-defined BYOK model providers (API keys live keychain-encrypted in secrets.ts, never here) */
  readonly modelEndpoints?: ModelEndpoint[]
  /**
   * Agents the user defined for Cockpit to drive over ACP. Built-ins are not stored —
   * they ship in `BUILTIN_ACP_AGENTS` so an upgraded CLI is picked up without a config
   * migration, and so a stale copy of one can never outlive the code that defines it.
   */
  readonly acpAgents?: AcpAgent[]
  /** ModelEndpoint.id each BYOK session runs on, keyed by `${provider}:${nativeId}` */
  readonly sessionEndpoints?: Record<string, string>
  /**
   * Labels of removed endpoints that sessions are still bound to, keyed by the old
   * id. Ids are fresh UUIDs, so without this a re-added provider could never
   * reclaim its sessions and their bindings would refuse forever.
   */
  readonly removedEndpoints?: Record<string, string>
  /** Handoff lineage: source session each session continues, keyed by `${provider}:${nativeId}` */
  readonly continuedFrom?: Record<string, string>
  /** Notification, sound and Dock-badge switches the user flipped; an absent one follows the build */
  readonly attention?: Partial<AttentionPrefs>
  /** Automatic download/install switches the user flipped; an absent one is on */
  readonly updates?: Partial<UpdatePrefs>
}

/**
 * Dev/test override (index.ts applies the same var to app.setPath, so in dev both
 * agree); packaged builds always use the real userData dir. `app` has no runtime
 * under vitest, which is what makes this module unit-testable.
 */
export function userDataDir(): string {
  const override = process.env['COCKPIT_USER_DATA']
  if (override && app?.isPackaged !== true) return resolve(override)
  return app.getPath('userData')
}

function configPath(): string {
  return join(userDataDir(), 'cockpit-config.json')
}

/** The config file itself — backup snapshots copy the raw bytes, not a re-serialization. */
export function configFilePath(): string {
  return configPath()
}

/** First run: auto-detect default provider homes. */
function detectDefaults(): SourceDir[] {
  const h = homedir()
  const candidates: SourceDir[] = [
    { path: join(h, '.claude'), provider: 'claude', label: 'claude-default' },
    { path: join(h, '.codex'), provider: 'codex', label: 'codex-default' },
    { path: join(h, '.copilot'), provider: 'copilot', label: 'copilot-default' }
  ]
  return candidates.filter((c) => existsSync(c.path))
}

/** The one parse both readers share, so "valid config" can never mean two things. */
function parseConfig(raw: string): AppConfig {
  const cfg = JSON.parse(raw) as AppConfig
  if (!Array.isArray(cfg.sources)) throw new Error('config has no sources[]')
  return cfg
}

/**
 * Like loadConfig, but a config that exists and cannot be read is an error rather
 * than a fresh start. Restore writes the whole config, so it must never build on
 * in-memory defaults: that would turn one unreadable file into a lost one.
 */
export function readConfigStrict(): AppConfig {
  let raw: string
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sources: detectDefaults(), archived: [] }
    throw new Error(`cannot read ${configPath()}: ${(err as Error).message}`)
  }
  try {
    return parseConfig(raw)
  } catch (err) {
    throw new Error(`${configPath()} is unreadable (${(err as Error).message}) — fix or move it first`)
  }
}

export function loadConfig(): AppConfig {
  let raw: string | null = null
  // Only a genuinely absent file is a first run. Any other read failure (EACCES
  // after a permissions mishap, EISDIR, a transient EMFILE while the indexer holds
  // thousands of descriptors) must not be mistaken for "no config yet" — that is
  // what used to overwrite the real one with defaults.
  let missing = false
  try {
    raw = readFileSync(configPath(), 'utf8')
  } catch (err) {
    missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    if (!missing) console.error(`[config] cannot read ${configPath()}:`, err)
  }
  if (raw !== null) {
    try {
      return parseConfig(raw)
    } catch (err) {
      // an existing-but-unreadable config must never be clobbered: keep the raw
      // bytes recoverable, run on in-memory defaults, and don't persist them
      try {
        writeFileSync(configPath() + '.corrupt', raw)
      } catch {
        /* backup is best-effort */
      }
      console.error(`[config] unreadable ${configPath()} (backed up to .corrupt):`, err)
    }
  }
  const cfg = { sources: detectDefaults(), archived: [] }
  if (missing) saveConfig(cfg)
  return cfg
}

export function setSessionArchived(sessionId: string, archived: boolean): string[] {
  const cfg = loadConfig()
  const set = new Set(cfg.archived ?? [])
  if (archived) set.add(sessionId)
  else set.delete(sessionId)
  const ids = [...set]
  saveConfig({ ...cfg, archived: ids })
  return ids
}

/** Same two tiers as a session: archiving a table only hides it, and is reversible. */
export function setRoundtableArchived(id: string, archived: boolean): string[] {
  const cfg = loadConfig()
  const set = new Set(cfg.archivedRoundtables ?? [])
  if (archived) set.add(id)
  else set.delete(id)
  const ids = [...set]
  saveConfig({ ...cfg, archivedRoundtables: ids })
  return ids
}

/** Batch counterpart of setSessionArchived — cleanup archives hundreds at once. */
export function setSessionsArchived(ids: readonly string[], archived: boolean): string[] {
  const cfg = loadConfig()
  const set = new Set(cfg.archived ?? [])
  for (const id of ids) {
    if (archived) set.add(String(id))
    else set.delete(String(id))
  }
  const next = [...set]
  saveConfig({ ...cfg, archived: next })
  return next
}

export function setRepoHidden(repoKey: string, hidden: boolean): string[] {
  const cfg = loadConfig()
  const set = new Set(cfg.hiddenRepos ?? [])
  if (hidden) set.add(repoKey)
  else set.delete(repoKey)
  const keys = [...set]
  saveConfig({ ...cfg, hiddenRepos: keys })
  return keys
}

export function setRepoOrder(repoKeys: readonly string[]): string[] {
  const cfg = loadConfig()
  const keys = [...new Set(repoKeys.map(String))].filter((k) => k !== 'general')
  saveConfig({ ...cfg, repoOrder: keys })
  return keys
}

export function setHistoryDays(days: number): number {
  const cfg = loadConfig()
  const d = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  saveConfig({ ...cfg, historyDays: d })
  return d
}

export function setStaleDays(days: number): number {
  const cfg = loadConfig()
  const d = clampStaleDays(days)
  saveConfig({ ...cfg, staleDays: d })
  return d
}

export function setZoom(factor: number): number {
  const cfg = loadConfig()
  const z = clampZoom(factor)
  saveConfig({ ...cfg, zoom: z })
  return z
}

export function setWindowPlacement(placement: WindowPlacement): void {
  saveConfig({ ...loadConfig(), window: placement })
}

export function setTimeFormat(format: TimeFormat): TimeFormat {
  const cfg = loadConfig()
  // renderer input is untrusted — anything but the one alternate value means default
  const f: TimeFormat = format === '12h' ? '12h' : '24h'
  saveConfig({ ...cfg, timeFormat: f })
  return f
}

const ATTENTION_KEYS = ['notifications', 'sound', 'badge'] as const

/**
 * A switch the user never touched is on in an installed app and off everywhere else,
 * so `npm run dev`, e2e and the UI tour stay silent unless someone turned them on.
 */
export function attentionPrefs(): AttentionPrefs {
  const on = app?.isPackaged === true
  const set = loadConfig().attention ?? {}
  return {
    notifications: typeof set.notifications === 'boolean' ? set.notifications : on,
    sound: typeof set.sound === 'boolean' ? set.sound : on,
    badge: typeof set.badge === 'boolean' ? set.badge : on
  }
}

export function setAttentionPrefs(next: AttentionPrefs): AttentionPrefs {
  const cfg = loadConfig()
  const current = attentionPrefs()
  // only a flipped switch is written: an untouched one keeps following the build, so
  // turning sound off in the installed app never switches a dev run's banners on
  const stored: { -readonly [K in keyof AttentionPrefs]?: boolean } = { ...cfg.attention }
  for (const key of ATTENTION_KEYS) {
    // renderer input is untrusted — anything but true is off
    const value = next?.[key] === true
    if (value !== current[key]) stored[key] = value
  }
  saveConfig({ ...cfg, attention: stored })
  return attentionPrefs()
}

const UPDATE_KEYS = ['download', 'install'] as const

/**
 * Both on until the user says otherwise: an installed Cockpit keeping itself
 * current is the point, and every other build reports `unsupported` before these
 * are ever read. Off is a real choice too — a metered connection, or wanting to
 * read the release notes first — so a flipped switch is stored and honoured.
 */
export function updatePrefs(): UpdatePrefs {
  const set = loadConfig().updates ?? {}
  return {
    download: set.download !== false,
    install: set.install !== false
  }
}

export function setUpdatePrefs(next: UpdatePrefs): UpdatePrefs {
  const cfg = loadConfig()
  const stored: { -readonly [K in keyof UpdatePrefs]?: boolean } = { ...cfg.updates }
  // renderer input is untrusted, and these switches act on their own — anything
  // but a real true is off, the direction a malformed value can do no work in
  for (const key of UPDATE_KEYS) stored[key] = next?.[key] === true
  saveConfig({ ...cfg, updates: stored })
  return updatePrefs()
}

export function listModelEndpoints(): ModelEndpoint[] {
  return loadConfig().modelEndpoints ?? []
}

/**
 * Upsert by id, in place — a models-cache refresh must not reorder the user's list.
 * Pure, so restore can fold several endpoints into one config before writing it.
 */
export function withEndpoint(cfg: AppConfig, ep: ModelEndpoint): AppConfig {
  const existing = cfg.modelEndpoints ?? []
  const eps = existing.some((e) => e.id === ep.id)
    ? existing.map((e) => (e.id === ep.id ? ep : e))
    : [...existing, ep]
  // re-adding a provider under the label it was removed with adopts the sessions
  // that were bound to it, so "refuses until it is re-added" is actually true.
  // A tombstone under this very id goes too — a restored endpoint that kept its
  // id must not be reclaimable by the next provider that happens to share a label.
  const reclaimed = Object.entries(cfg.removedEndpoints ?? {})
    .filter(([oldId, label]) => label === ep.label || oldId === ep.id)
    .map(([oldId]) => oldId)
  const tombstones = Object.fromEntries(
    Object.entries(cfg.removedEndpoints ?? {}).filter(([oldId]) => !reclaimed.includes(oldId))
  )
  const sessions = Object.fromEntries(
    Object.entries(cfg.sessionEndpoints ?? {}).map(([sid, eid]) => [
      sid,
      reclaimed.includes(eid) ? ep.id : eid
    ])
  )
  return { ...cfg, modelEndpoints: eps, sessionEndpoints: sessions, removedEndpoints: tombstones }
}

export function addModelEndpoint(ep: ModelEndpoint): ModelEndpoint[] {
  const next = withEndpoint(loadConfig(), ep)
  saveConfig(next)
  return next.modelEndpoints ?? []
}

/**
 * Update an existing endpoint in place; a no-op when it was removed meanwhile —
 * a models-cache refresh finishing after removal must not resurrect the endpoint.
 */
export function updateModelEndpoint(ep: ModelEndpoint): void {
  const cfg = loadConfig()
  const existing = cfg.modelEndpoints ?? []
  if (!existing.some((e) => e.id === ep.id)) return
  saveConfig({ ...cfg, modelEndpoints: existing.map((e) => (e.id === ep.id ? ep : e)) })
}

/**
 * Re-validated on every read, not just on the way in.
 *
 * Every other config list is data; this one is a command line Cockpit will execute, and
 * the file is editable by hand (and arrives from a restore). Running the same rules the
 * add form ran means an entry that was hand-written, or written by an older build with
 * looser rules, is dropped rather than spawned.
 */
export function listAcpAgents(): AcpAgent[] {
  const stored = loadConfig().acpAgents ?? []
  return stored
    .map((a) => (a?.id ? sanitizeAcpAgent(a, a.id) : null))
    .filter((a): a is AcpAgent => a !== null)
}

/** Upsert by id, in place, so editing an agent keeps its position in the user's list. */
export function withAcpAgent(cfg: AppConfig, agent: AcpAgent): AppConfig {
  const existing = cfg.acpAgents ?? []
  const agents = existing.some((a) => a.id === agent.id)
    ? existing.map((a) => (a.id === agent.id ? agent : a))
    : [...existing, agent]
  return { ...cfg, acpAgents: agents }
}

export function addAcpAgent(agent: AcpAgent): AcpAgent[] {
  const next = withAcpAgent(loadConfig(), agent)
  saveConfig(next)
  return next.acpAgents ?? []
}

export function removeAcpAgent(id: string): AcpAgent[] {
  const cfg = loadConfig()
  const agents = (cfg.acpAgents ?? []).filter((a) => a.id !== id)
  saveConfig({ ...cfg, acpAgents: agents })
  return agents
}

export function removeModelEndpoint(id: string): ModelEndpoint[] {
  const cfg = loadConfig()
  const removed = (cfg.modelEndpoints ?? []).find((e) => e.id === id)
  const eps = (cfg.modelEndpoints ?? []).filter((e) => e.id !== id)
  // sessionEndpoints bindings are kept on purpose: the dangling binding is what
  // makes a resume refuse loudly (endpointPreflight's "no longer configured")
  // instead of silently falling back to the first-party backend. Remember the
  // label so re-adding the provider can adopt those sessions again.
  const stillBound =
    removed && Object.values(cfg.sessionEndpoints ?? {}).includes(id)
      ? { ...cfg.removedEndpoints, [id]: removed.label }
      : cfg.removedEndpoints
  saveConfig({ ...cfg, modelEndpoints: eps, removedEndpoints: stillBound })
  return eps
}

export const SESSION_ENDPOINT_CAP = 500

/** Remember which endpoint a session was started with so resume stays on that backend. */
export function bindSessionEndpoint(sessionId: string, endpointId: string): void {
  const cfg = loadConfig()
  const entries = Object.entries(cfg.sessionEndpoints ?? {})
  // claude emits two session events per turn — skip the rewrite when nothing changes
  const last = entries[entries.length - 1]
  if (last && last[0] === sessionId && last[1] === endpointId) return
  // re-insert so JSON key order doubles as recency for the cap below
  const kept = entries.filter(([sid]) => sid !== sessionId)
  kept.push([sessionId, endpointId])
  saveConfig({
    ...cfg,
    sessionEndpoints: Object.fromEntries(kept.slice(Math.max(0, kept.length - SESSION_ENDPOINT_CAP)))
  })
}

export function sessionEndpointFor(sessionId: string): string | undefined {
  return loadConfig().sessionEndpoints?.[sessionId]
}

export const SESSION_LINEAGE_CAP = 500

/**
 * Remember which session a handed-off session continues. Returns the whole updated
 * map so the caller can hand it straight to the indexer (the setSessionArchived
 * pattern). Same mechanics as bindSessionEndpoint: key order doubles as recency.
 */
export function bindSessionLineage(
  newSessionId: string,
  sourceSessionId: string
): Record<string, string> {
  const cfg = loadConfig()
  const current = cfg.continuedFrom ?? {}
  // a session can never continue itself
  if (newSessionId === sourceSessionId) return current
  const entries = Object.entries(current)
  // claude emits two session events per turn — skip the rewrite when nothing changes
  const last = entries[entries.length - 1]
  if (last && last[0] === newSessionId && last[1] === sourceSessionId) return current
  const kept = entries.filter(([sid]) => sid !== newSessionId)
  kept.push([newSessionId, sourceSessionId])
  const next = Object.fromEntries(kept.slice(Math.max(0, kept.length - SESSION_LINEAGE_CAP)))
  saveConfig({ ...cfg, continuedFrom: next })
  return next
}

export function sessionLineageFor(sessionId: string): string | undefined {
  return loadConfig().continuedFrom?.[sessionId]
}

export function sessionLineage(): Record<string, string> {
  return loadConfig().continuedFrom ?? {}
}

export function saveConfig(cfg: AppConfig): void {
  mkdirSync(userDataDir(), { recursive: true })
  // write-then-rename: a crash mid-write must never leave a truncated config
  const tmp = configPath() + '.tmp'
  writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  renameSync(tmp, configPath())
}
