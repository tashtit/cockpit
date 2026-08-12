import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
}

function configPath(): string {
  return join(app.getPath('userData'), 'cockpit-config.json')
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
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const cfg = JSON.parse(raw) as AppConfig
    if (Array.isArray(cfg.sources)) return cfg
  } catch {
    /* first run or corrupt config */
  }
  const cfg = { sources: detectDefaults(), archived: [] }
  saveConfig(cfg)
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
  saveConfig({ ...cfg, modelEndpoints: eps })
  return eps
}

export function removeModelEndpoint(id: string): ModelEndpoint[] {
  const cfg = loadConfig()
  const eps = (cfg.modelEndpoints ?? []).filter((e) => e.id !== id)
  // sessions bound to a deleted endpoint must fail loudly on resume, not dangle
  const sessions = Object.fromEntries(
    Object.entries(cfg.sessionEndpoints ?? {}).filter(([, eid]) => eid !== id)
  )
  saveConfig({ ...cfg, modelEndpoints: eps, sessionEndpoints: sessions })
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

export function saveConfig(cfg: AppConfig): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}
