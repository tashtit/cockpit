/**
 * Cockpit's own config, `cockpit-config.json` in userData: the agent homes it indexes and
 * the ones the person removed, what they archived, hid or ordered, the library, shared
 * instructions, BYOK and ACP definitions, and the view preferences. Read defensively
 * (`parseConfig` drops what this build can't use from the lists startup builds on; the
 * rest is checked where it is read, as `sanitizeAcpAgent` does), never overwritten while it cannot be read
 * (`assertOverwritable` — a setter must not write defaults over the person's file), and
 * written whole and owner-only: it holds MCP servers' env values in the clear.
 */
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  AcpAgent,
  AttentionPrefs,
  LibraryEntry,
  ModelEndpoint,
  SessionMeta,
  SourceDir,
  TimeFormat,
  UpdatePrefs
} from '../shared/types'
import { detectAgentHomes, reconcileDetected } from './agent-homes'
import { clampStaleDays } from './cleanup-core'
import { sanitizeControlMap, withControl, type ControlEntry } from './session-control-core'
import { writeFileAtomic } from './replace-file'
import { readIfPresent } from './state-file'
import { isLatest, withRecent } from './recent-map'
import { sanitizeAcpAgent } from '../shared/acp'
import { clampZoom, type WindowPlacement } from '../shared/window'
import {
  DEFAULT_BRANCH_PREFIX,
  branchPrefixOf,
  branchPrefixRefusal,
  normalizeBranchPrefix
} from '../shared/branch-prefix'
import { isSessionProvider } from '../shared/providers'

export type AppConfig = {
  readonly sources: SourceDir[]
  /**
   * Agent homes the person removed in Settings (resolved paths), which detection never
   * adds back. Only Remove writes it, and Add clears a path from it: an older build that
   * drops sources it cannot read must not look like a removal (see reconcileDetected).
   */
  readonly dismissedSources?: string[]
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
  /** What the branches Cockpit cuts for worktrees start with; absent = `cockpit/` */
  readonly branchPrefix?: string
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
  /**
   * Sessions that changed hands — Cockpit started one, took one over, or released one
   * back to its agent — keyed by `${provider}:${nativeId}`. A session not listed is
   * with its agent, unless it runs in one of Cockpit's own worktrees (`controlOf`).
   */
  readonly sessionControl?: Record<string, ControlEntry>
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

/** First run: every agent home on this machine, nothing yet removed. */
function firstRunConfig(): AppConfig {
  return { sources: detectAgentHomes(), dismissedSources: [], archived: [] }
}

/**
 * The config with any agent home that appeared since the last launch added — an agent
 * installed later, an editor that gained Cline — saved when that changed anything.
 * Homes are added once: removing one in Settings is final (see reconcileDetected).
 */
export function adoptDetectedSources(): AppConfig {
  const cfg = loadConfig()
  const next = reconcileDetected(cfg.sources, cfg.dismissedSources, detectAgentHomes())
  if (!next.changed) return cfg
  const updated = { ...cfg, sources: next.sources, dismissedSources: next.dismissed }
  saveConfig(updated)
  return updated
}

/**
 * `adoptDetectedSources` for a caller that must carry on whatever happens: startup, where
 * a throw leaves an app in the Dock with no window, and the end of a turn, inside the
 * stream handler. A home that could not be saved is logged and adopted on a later try;
 * the config as it stands runs meanwhile.
 */
export function tryAdoptDetectedSources(): AppConfig {
  try {
    return adoptDetectedSources()
  } catch (err) {
    console.error('[config] could not save the agent homes found since the last launch:', err)
    return loadConfig()
  }
}

/** The one parse both readers share, so "valid config" can never mean two things. */
function parseConfig(raw: string): AppConfig {
  const cfg = JSON.parse(raw) as AppConfig
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.sources)) {
    throw new Error('config has no sources[]')
  }
  // A hand edit, or a build that knew a provider this one doesn't, meets startup
  // here — and startup indexes the sources and builds sets from these lists before
  // the window opens. One wrong-typed field used to throw there, which left the app
  // in the Dock with no window and no error. Drop what this build can't use instead.
  return {
    ...cfg,
    sources: cfg.sources.filter(isSource).map((s) => ({
      path: s.path,
      provider: s.provider,
      label: typeof s.label === 'string' ? s.label : s.provider
    })),
    archived: stringList(cfg.archived),
    archivedRoundtables: stringList(cfg.archivedRoundtables),
    hiddenRepos: stringList(cfg.hiddenRepos),
    repoOrder: stringList(cfg.repoOrder),
    dismissedSources: stringList(cfg.dismissedSources),
    sessionControl: cfg.sessionControl === undefined ? undefined : sanitizeControlMap(cfg.sessionControl)
  }
}

function isSource(s: unknown): s is SourceDir {
  const o = s as Partial<SourceDir> | null
  return !!o && typeof o.path === 'string' && o.path !== '' && isSessionProvider(o.provider)
}

function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
}

/**
 * Like loadConfig, but a config that exists and cannot be read is an error rather
 * than a fresh start. Restore writes the whole config, so it must never build on
 * in-memory defaults: that would turn one unreadable file into a lost one.
 */
export function readConfigStrict(): AppConfig {
  const raw = readIfPresent(configPath())
  if (raw === null) return firstRunConfig()
  try {
    return parseConfig(raw)
  } catch (err) {
    throw new Error(`${configPath()} is unreadable (${(err as Error).message}) — fix or move it first`)
  }
}

/** The configured source a session was indexed under — its config home — while it is still configured. */
export function sourceFor(session: Pick<SessionMeta, 'provider' | 'source'>): SourceDir | undefined {
  return loadConfig().sources.find((s) => s.provider === session.provider && s.label === session.source)
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
  const cfg = firstRunConfig()
  if (missing) saveConfig(cfg)
  return cfg
}

/** The config lists an id is either on or off: what is archived, what is hidden. */
type ListField = 'archived' | 'archivedRoundtables' | 'hiddenRepos'

/** Put `ids` on the list (or take them off) and save; the whole list as it now stands. */
function toggleListed(field: ListField, ids: readonly string[], on: boolean): string[] {
  const cfg = loadConfig()
  const set = new Set(cfg[field] ?? [])
  for (const id of ids) {
    if (on) set.add(String(id))
    else set.delete(String(id))
  }
  const next = [...set]
  saveConfig({ ...cfg, [field]: next })
  return next
}

export function setSessionArchived(sessionId: string, archived: boolean): string[] {
  return toggleListed('archived', [sessionId], archived)
}

/** Same two tiers as a session: archiving a table only hides it, and is reversible. */
export function setRoundtableArchived(id: string, archived: boolean): string[] {
  return toggleListed('archivedRoundtables', [id], archived)
}

/** Batch counterpart of setSessionArchived — cleanup archives hundreds at once. */
export function setSessionsArchived(ids: readonly string[], archived: boolean): string[] {
  return toggleListed('archived', ids, archived)
}

export function setRepoHidden(repoKey: string, hidden: boolean): string[] {
  return toggleListed('hiddenRepos', [repoKey], hidden)
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

/** The prefix new worktree branches get — the default unless a valid one was set. */
export function branchPrefix(cfg: AppConfig = loadConfig()): string {
  return branchPrefixOf(cfg.branchPrefix)
}

/** Set it from what the person typed; '' goes back to the default. Throws the reason for a name git would refuse. */
export function setBranchPrefix(raw: string): string {
  const prefix = normalizeBranchPrefix(raw)
  const refusal = branchPrefixRefusal(prefix)
  if (refusal) throw new Error(refusal)
  const keep = prefix === '' || prefix === DEFAULT_BRANCH_PREFIX ? undefined : prefix
  saveConfig({ ...loadConfig(), branchPrefix: keep })
  return keep ?? DEFAULT_BRANCH_PREFIX
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

const ATTENTION_KEYS = ['notifications', 'sound', 'badge', 'cleanup'] as const

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
    badge: typeof set.badge === 'boolean' ? set.badge : on,
    cleanup: typeof set.cleanup === 'boolean' ? set.cleanup : on
  }
}

export function setAttentionPrefs(next: AttentionPrefs): AttentionPrefs {
  const cfg = loadConfig()
  const current = attentionPrefs()
  const byDefault = app?.isPackaged === true
  // only a switch flipped away from this build's default is written: an untouched one
  // keeps following the build, so turning sound off in the installed app never switches
  // a dev run's banners on. One flipped back is forgotten rather than stored — turning
  // notifications off and on again in the installed app would otherwise leave `true`
  // behind, and every dev run sharing its userData would notify
  const stored: { -readonly [K in keyof AttentionPrefs]?: boolean } = { ...cfg.attention }
  for (const key of ATTENTION_KEYS) {
    // renderer input is untrusted — anything but true is off
    const value = next?.[key] === true
    if (value === current[key]) continue
    if (value === byDefault) delete stored[key]
    else stored[key] = value
  }
  saveConfig({ ...cfg, attention: stored })
  return attentionPrefs()
}

/**
 * Whether archiving a session stops what it left running (`archive-watch.ts`): in an
 * installed app, as the attention switches are on. A dev run indexes the real HOME, so
 * every one running would otherwise act on every archive — the providers' own apps'
 * included — unless COCKPIT_ARCHIVE_WATCH=1 asks for it.
 */
export function archiveWatchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return app?.isPackaged === true || env['COCKPIT_ARCHIVE_WATCH'] === '1'
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
function withAcpAgent(cfg: AppConfig, agent: AcpAgent): AppConfig {
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
  const current = cfg.sessionEndpoints ?? {}
  // claude emits two session events per turn — skip the rewrite when nothing changes
  if (isLatest(current, sessionId, endpointId)) return
  // re-inserted even when bound already, so a session still in use outlives the cap
  const next = withRecent(current, { id: sessionId, value: endpointId, cap: SESSION_ENDPOINT_CAP })
  saveConfig({ ...cfg, sessionEndpoints: next })
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
  // claude emits two session events per turn — skip the rewrite when nothing changes
  if (isLatest(current, newSessionId, sourceSessionId)) return current
  const next = withRecent(current, { id: newSessionId, value: sourceSessionId, cap: SESSION_LINEAGE_CAP })
  saveConfig({ ...cfg, continuedFrom: next })
  return next
}

export function sessionLineageFor(sessionId: string): string | undefined {
  return loadConfig().continuedFrom?.[sessionId]
}

export const SESSION_CONTROL_CAP = 1000

/**
 * Record that a session changed hands. Returns the whole updated map so the caller
 * can hand it straight to the indexer (the bindSessionLineage pattern).
 */
export function bindSessionControl(sessionId: string, entry: ControlEntry): Record<string, ControlEntry> {
  const cfg = loadConfig()
  const current = cfg.sessionControl ?? {}
  const next = withControl(current, sessionId, entry, SESSION_CONTROL_CAP)
  if (next === current) return current
  saveConfig({ ...cfg, sessionControl: { ...next } })
  return { ...next }
}

export function sessionControlFor(sessionId: string): ControlEntry | undefined {
  return loadConfig().sessionControl?.[sessionId]
}

export function saveConfig(cfg: AppConfig): void {
  assertOverwritable()
  // owner-only: the config holds MCP servers' env values in plaintext
  writeFileAtomic(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 })
}

/**
 * Every write passes here. A config that exists and cannot be read is the user's,
 * not a blank slate: loadConfig runs on defaults then, and every setter builds on
 * loadConfig — so the first one to save (moving the window is enough) would write
 * those defaults over it. Refuse instead, until the file is fixed or moved.
 */
function assertOverwritable(): void {
  readConfigStrict()
}
