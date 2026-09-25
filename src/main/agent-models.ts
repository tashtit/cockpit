import { readFileSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentModel, Provider } from '../shared/types'
import { BUILTIN_MODELS, mergeModels } from '../shared/agent-models'
import { codexCatalog, codexConfiguredModel, copilotModelsInLog } from './agent-models-core'

/** Copilot logs read for models: the newest few, the head of each — bounded like every scan. */
const COPILOT_LOGS = 60
const COPILOT_LOG_BYTES = 256 * 1024
/**
 * Stats in flight at once over session-state, which holds thousands of sessions: enough
 * to be quick, few enough that the rest of main's file work isn't queued behind them.
 */
const STAT_BATCH = 64
const CACHE_MS = 10 * 60_000

/** The answer in flight or found, so a burst of pickers opening shares one scan. */
const cache = new Map<string, { readonly at: number; readonly models: Promise<AgentModel[]> }>()

async function readHead(path: string, bytes: number): Promise<string> {
  try {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await fh.read(buf, 0, bytes, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
  } catch {
    return ''
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

/**
 * Asynchronous throughout: a picker opening walks every Copilot session there is, and
 * done synchronously that held main's event loop — and every IPC call — for it.
 */
async function copilotModels(home: string): Promise<AgentModel[]> {
  const root = join(home, 'session-state')
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const logs: Array<{ readonly path: string; readonly mtime: number }> = []
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const batch = await Promise.all(
      names.slice(i, i + STAT_BATCH).map(async (d) => {
        const path = join(root, d, 'events.jsonl')
        try {
          return { path, mtime: (await stat(path)).mtimeMs }
        } catch {
          return null
        }
      })
    )
    for (const log of batch) if (log) logs.push(log)
  }
  const seen = new Set<string>()
  for (const log of logs.sort((a, b) => b.mtime - a.mtime).slice(0, COPILOT_LOGS)) {
    for (const id of copilotModelsInLog(await readHead(log.path, COPILOT_LOG_BYTES))) seen.add(id)
  }
  return [...seen].sort().map((id) => ({ id, label: id }))
}

/**
 * Every model the picker offers for one agent under one config home: the built-ins the
 * CLI documents, then what that home shows — Codex's own catalog, the models Copilot has
 * served. Claude keeps no catalog, so its built-ins are the list. Cached for ten minutes.
 */
export function listAgentModels(provider: Provider, configDir?: string): Promise<AgentModel[]> {
  const home =
    configDir ?? join(homedir(), provider === 'claude' ? '.claude' : provider === 'codex' ? '.codex' : '.copilot')
  const key = `${provider}|${home}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models
  const found =
    provider === 'codex'
      ? Promise.resolve(codexModels(home))
      : provider === 'copilot'
        ? copilotModels(home)
        : Promise.resolve([])
  // every read above fails soft, so what is cached here never rejects
  const models = found.then((f) => mergeModels(BUILTIN_MODELS[provider], f))
  cache.set(key, { at: Date.now(), models })
  return models
}
