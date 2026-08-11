import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SourceDir, TimeFormat } from '../shared/types'

interface AppConfig {
  sources: SourceDir[]
  /** Session ids the user archived in Cockpit (provider logs have no such flag) */
  archived?: string[]
  /** Shared AI instruction baselines — fanned out into each agent's own file */
  sharedInstructions?: {
    global?: string
    /** Keyed by repo root path */
    repos?: Record<string, string>
  }
  /** Repo keys the user chose not to display (everything is visible by default) */
  hiddenRepos?: string[]
  /** Days of history to display — sessions idle longer are hidden; 0/absent = all */
  historyDays?: number
  /** Clock format for session times in the UI; absent = 24h */
  timeFormat?: TimeFormat
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
  cfg.archived = [...set]
  saveConfig(cfg)
  return cfg.archived
}

export function setRepoHidden(repoKey: string, hidden: boolean): string[] {
  const cfg = loadConfig()
  const set = new Set(cfg.hiddenRepos ?? [])
  if (hidden) set.add(repoKey)
  else set.delete(repoKey)
  cfg.hiddenRepos = [...set]
  saveConfig(cfg)
  return cfg.hiddenRepos
}

export function setHistoryDays(days: number): number {
  const cfg = loadConfig()
  const d = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
  cfg.historyDays = d
  saveConfig(cfg)
  return d
}

export function setTimeFormat(format: TimeFormat): TimeFormat {
  const cfg = loadConfig()
  // renderer input is untrusted — anything but the one alternate value means default
  const f: TimeFormat = format === '12h' ? '12h' : '24h'
  cfg.timeFormat = f
  saveConfig(cfg)
  return f
}

export function saveConfig(cfg: AppConfig): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}
