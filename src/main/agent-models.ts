/**
 * The models each agent's picker offers under one config home: the built-ins
 * (`shared/agent-models.ts`), then what the home itself shows — Codex's model catalog and
 * configured model, the models Copilot's recent logs record. Every read is bounded and
 * fails soft; the parsing is `agent-models-core.ts`.
 */
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentModel, Provider } from '../shared/types'
import { BUILTIN_MODELS, mergeModels } from '../shared/agent-models'
import { throttledBy } from './cache'
import { codexCatalog, codexConfiguredModel, copilotModelsInLog } from './agent-models-core'
import { mapLimit } from './map-limit'
import { defaultConfigHome } from './paths'
import { readHeadBytesAsync } from './parsers/util'

/** Copilot logs read for models: the newest few, the head of each — bounded like every scan. */
const COPILOT_LOGS = 60
const COPILOT_LOG_BYTES = 256 * 1024
/**
 * Stats in flight at once over session-state, which holds thousands of sessions: enough
 * to be quick, few enough that the rest of main's file work isn't queued behind them.
 */
const STAT_BATCH = 64
const CACHE_MS = 10 * 60_000

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
  const stats = await mapLimit(
    names,
    async (d) => {
      const path = join(root, d, 'events.jsonl')
      try {
        return { path, mtime: (await stat(path)).mtimeMs }
      } catch {
        return null
      }
    },
    STAT_BATCH
  )
  const logs = stats.filter((log) => log !== null)
  const seen = new Set<string>()
  for (const log of logs.sort((a, b) => b.mtime - a.mtime).slice(0, COPILOT_LOGS)) {
    const head = await readHeadBytesAsync(log.path, COPILOT_LOG_BYTES)
    for (const id of copilotModelsInLog(head?.bytes.toString('utf8') ?? '')) seen.add(id)
  }
  return [...seen].sort().map((id) => ({ id, label: id }))
}

/**
 * Every model the picker offers for one agent under one config home: the built-ins the
 * CLI documents, then what that home shows — Codex's own catalog, the models Copilot has
 * served. Claude keeps no catalog, so its built-ins are the list. Cached for ten minutes.
 */
export function listAgentModels(provider: Provider, configDir?: string): Promise<AgentModel[]> {
  const home = configDir ?? defaultConfigHome(provider)
  return modelsByHome({ provider, home })
}

type Home = { readonly provider: Provider; readonly home: string }

/** The answer in flight or found, so a burst of pickers opening shares one scan. */
const modelsByHome = throttledBy(
  CACHE_MS,
  async ({ provider, home }: Home): Promise<AgentModel[]> => {
    // every read here fails soft, so what is cached never rejects
    const found =
      provider === 'codex' ? codexModels(home) : provider === 'copilot' ? await copilotModels(home) : []
    return mergeModels(BUILTIN_MODELS[provider], found)
  },
  { keyOf: ({ provider, home }) => `${provider}|${home}` }
)
