import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { SourceDir } from '../shared/types'

interface AppConfig {
  sources: SourceDir[]
  /** Session ids the user archived in Cockpit (provider logs have no such flag) */
  archived?: string[]
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

export function saveConfig(cfg: AppConfig): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}
