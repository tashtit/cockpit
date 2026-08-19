import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ModelEndpoint, SourceDir, TimeFormat } from '../shared/types'

type AppConfig = {
  readonly sources: SourceDir[]
  /** Session ids the user archived in Cockpit (provider logs have no such flag) */
  readonly archived?: string[]
  /** Shared AI instruction baselines — fanned out into each agent's own file */
  readonly sharedInstructions?: {
    readonly global?: string
    /** Keyed by repo root path */
    readonly repos?: Record<string, string>
  }
  /** Repo keys the user chose not to display (everything is visible by default) */
  readonly hiddenRepos?: string[]
  /** Days of history to display — sessions idle longer are hidden; 0/absent = all */
  readonly historyDays?: number
  /** Clock format for session times in the UI; absent = 24h */
  readonly timeFormat?: TimeFormat
  /** User-defined BYOK model providers (API keys live keychain-encrypted in secrets.ts, never here) */
  readonly modelEndpoints?: ModelEndpoint[]
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
      const cfg = JSON.parse(raw) as AppConfig
      if (Array.isArray(cfg.sources)) return cfg
      throw new Error('config has no sources[]')
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

export function setRepoHidden(repoKey: string, hidden: boolean): string[] {
  const cfg = loadConfig()
  const set = new Set(cfg.hiddenRepos ?? [])
  if (hidden) set.add(repoKey)
  else set.delete(repoKey)
  const keys = [...set]
  saveConfig({ ...cfg, hiddenRepos: keys })
  return keys
}

export function setHistoryDays(days: number): number {
  const cfg = loadConfig()
  const d = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  saveConfig({ ...cfg, historyDays: d })
  return d
}

export function setTimeFormat(format: TimeFormat): TimeFormat {
  const cfg = loadConfig()
  // renderer input is untrusted — anything but the one alternate value means default
  const f: TimeFormat = format === '12h' ? '12h' : '24h'
  saveConfig({ ...cfg, timeFormat: f })
  return f
}

export function listModelEndpoints(): ModelEndpoint[] {
  return loadConfig().modelEndpoints ?? []
}

/** Upsert by id, in place — a models-cache refresh must not reorder the user's list. */
export function addModelEndpoint(ep: ModelEndpoint): ModelEndpoint[] {
  const cfg = loadConfig()
  const existing = cfg.modelEndpoints ?? []
  const eps = existing.some((e) => e.id === ep.id)
    ? existing.map((e) => (e.id === ep.id ? ep : e))
    : [...existing, ep]
  // re-adding a provider under the label it was removed with adopts the sessions
  // that were bound to it, so "refuses until it is re-added" is actually true
  const reclaimed = Object.entries(cfg.removedEndpoints ?? {})
    .filter(([, label]) => label === ep.label)
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
  saveConfig({
    ...cfg,
    modelEndpoints: eps,
    sessionEndpoints: sessions,
    removedEndpoints: tombstones
  })
  return eps
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

const SESSION_ENDPOINT_CAP = 500

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

const SESSION_LINEAGE_CAP = 500

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
