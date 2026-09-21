import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentModel, Provider } from '../shared/types'
import { BUILTIN_MODELS, mergeModels } from '../shared/agent-models'
import { codexCatalog, codexConfiguredModel, copilotModelsInLog } from './agent-models-core'

/** Copilot logs read for models: the newest few, the head of each — bounded like every scan. */
const COPILOT_LOGS = 60
const COPILOT_LOG_BYTES = 256 * 1024
const CACHE_MS = 10 * 60_000

const cache = new Map<string, { at: number; models: AgentModel[] }>()

function readHead(path: string, bytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function codexModels(home: string): AgentModel[] {
  let catalog: AgentModel[] = []
  try {
    catalog = codexCatalog(readFileSync(join(home, 'models_cache.json'), 'utf8'))
  } catch {
    /* no cache yet — codex writes it on its first run */
  }
  let configured: string | null = null
  try {
    configured = codexConfiguredModel(readFileSync(join(home, 'config.toml'), 'utf8'))
  } catch {
    /* no config */
  }
  return configured ? mergeModels(catalog, [{ id: configured, label: configured }]) : catalog
}

function copilotModels(home: string): AgentModel[] {
  const root = join(home, 'session-state')
  let dirs: Array<{ path: string; mtime: number }> = []
  try {
    dirs = readdirSync(root)
      .map((d) => {
        const path = join(root, d, 'events.jsonl')
        try {
          return { path, mtime: statSync(path).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((d): d is { path: string; mtime: number } => d !== null)
  } catch {
    return []
  }
  const seen = new Set<string>()
  for (const d of dirs.sort((a, b) => b.mtime - a.mtime).slice(0, COPILOT_LOGS)) {
    for (const id of copilotModelsInLog(readHead(d.path, COPILOT_LOG_BYTES))) seen.add(id)
  }
  return [...seen].sort().map((id) => ({ id, label: id }))
}

/**
 * Every model the picker offers for one agent under one config home: the built-ins the
 * CLI documents, then what that home shows — Codex's own catalog, the models Copilot has
 * served. Claude keeps no catalog, so its built-ins are the list. Cached for ten minutes.
 */
export function listAgentModels(provider: Provider, configDir?: string): AgentModel[] {
  const home =
    configDir ?? join(homedir(), provider === 'claude' ? '.claude' : provider === 'codex' ? '.codex' : '.copilot')
  const key = `${provider}|${home}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models
  const found =
    provider === 'codex' ? codexModels(home) : provider === 'copilot' ? copilotModels(home) : []
  const models = mergeModels(BUILTIN_MODELS[provider], found)
  cache.set(key, { at: Date.now(), models })
  return models
}
