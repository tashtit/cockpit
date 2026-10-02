/**
 * The models each agent's picker offers under one account: the built-ins
 * (`shared/agent-models.ts`), then what the account itself shows — Codex's model catalog
 * and configured model, the models Copilot's own server says the signed-in login may
 * pick (else, when it can't say, the models Copilot's recent logs record). Every read is
 * bounded and fails soft; the parsing is `agent-models-core.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentAccount, AgentModel, Provider } from '../shared/types'
import { BUILTIN_MODELS, mergeModels } from '../shared/agent-models'
import { CONFIG_HOME_VAR } from '../shared/providers'
import { throttledBy } from './cache'
import {
  codexCatalog,
  codexConfiguredModel,
  copilotAccountModels,
  CopilotFrames,
  copilotFrame,
  copilotModelsInLog,
  copilotSelection
} from './agent-models-core'
import { agentProbeDir } from './config'
import { cliEnv, loginPathReady } from './env'
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
/**
 * How long Copilot's server has to list an account's models — it starts in under a
 * second and asks GitHub once; past this the picker falls back to the logs.
 */
const COPILOT_SERVER_MS = 15_000
/** How long the server has to leave once its stdin closes (it leaves at once) */
const COPILOT_EXIT_MS = 2_000

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
 * Ask Copilot which models one of its logins may pick. GitHub decides — the plan, an
 * organization's policy — so nothing on disk says, and the logs only show what has run.
 * Copilot's server mode (`copilot --headless --stdio`, what its SDK drives) asks GitHub
 * as that login: `account.getAllUsers` names each signed-in login's selection, and
 * `models.list` takes one, so listing never switches who Copilot runs as. It opens no
 * session and runs no model. Without a login, the one Copilot runs as now.
 *
 * Null when it can't say — a CLI without the server, no network, a login it doesn't
 * know — and the caller falls back to the logs. It starts in Cockpit's own empty folder
 * (`agentProbeDir`), never home. Closing stdin ends the server (it leaves on EOF, so one
 * Cockpit quits under goes with it); SIGTERM backs that up.
 */
async function copilotServerModels(home: string, login: string | undefined): Promise<AgentModel[] | null> {
  await loginPathReady()
  let child: ChildProcess
  try {
    const cwd = agentProbeDir()
    mkdirSync(cwd, { recursive: true })
    child = spawn('copilot', ['--headless', '--stdio', '--no-auto-update'], {
      cwd,
      env: { ...cliEnv(), [CONFIG_HOME_VAR.copilot]: home },
      stdio: ['pipe', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
  const pending = new Map<number, (reply: Record<string, unknown> | null) => void>()
  let gone = false
  const settleAll = (): void => {
    gone = true
    for (const [, answer] of pending) answer(null)
    pending.clear()
  }
  const frames = new CopilotFrames()
  child.stdout!.on('data', (chunk: Buffer) => {
    let replies: unknown[]
    try {
      replies = frames.push(chunk)
    } catch {
      settleAll() // not the protocol: nothing later in the stream makes it right
      return
    }
    for (const r of replies) {
      const reply = r as Record<string, unknown> | null
      const answer = typeof reply?.id === 'number' ? pending.get(reply.id) : undefined
      if (!answer || !reply) continue
      pending.delete(reply.id as number)
      answer(reply)
    }
  })
  // an exit, or a write to a server that left at once (EPIPE) — unheard, main's error dialog
  child.on('error', settleAll)
  child.on('close', settleAll)
  child.stdin!.on('error', () => {})
  let nextId = 1
  /** The result of `method`, or null for an error reply or a server that has gone. */
  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      if (gone) return resolve(null)
      const id = nextId++
      pending.set(id, (reply) => resolve(reply && !reply.error ? reply.result : null))
      child.stdin!.write(copilotFrame({ jsonrpc: '2.0', id, method, params }))
    })
  const ask = async (): Promise<AgentModel[] | null> => {
    // the SDK's handshake; a server from before it answers the rest all the same
    await call('connect', {})
    const selectionId = login ? copilotSelection(await call('account.getAllUsers', {}), login) : null
    if (login && !selectionId) return null
    return copilotAccountModels(await call('models.list', selectionId ? { selectionId } : {}))
  }
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), COPILOT_SERVER_MS)
  })
  try {
    return await Promise.race([ask(), late])
  } finally {
    clearTimeout(timer)
    settleAll()
    child.stdin!.end()
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }, COPILOT_EXIT_MS).unref()
  }
}

/**
 * The models Copilot's logs show it serving, the newest few — the fallback when its
 * server can't say what an account may pick. Asynchronous throughout: a picker opening
 * walks every Copilot session there is, and done synchronously that held main's event
 * loop — and every IPC call — for it.
 */
async function copilotLoggedModels(home: string): Promise<AgentModel[]> {
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
 * Every model the picker offers for one agent under one account: the built-ins the CLI
 * documents, then what that account shows — Codex's own catalog, the models Copilot says
 * the login may pick (`copilotUser`; without one, whoever Copilot runs as now). Claude
 * keeps no catalog, so its built-ins are the list. Cached for ten minutes.
 */
export function listAgentModels(provider: Provider, account: AgentAccount = {}): Promise<AgentModel[]> {
  const home = account.configDir ?? defaultConfigHome(provider)
  return modelsByAccount({ provider, home, login: provider === 'copilot' ? account.copilotUser : undefined })
}

type Account = { readonly provider: Provider; readonly home: string; readonly login: string | undefined }

/** The answer in flight or found, so a burst of pickers opening shares one listing. */
const modelsByAccount = throttledBy(
  CACHE_MS,
  async ({ provider, home, login }: Account): Promise<AgentModel[]> => {
    // every read here fails soft, so what is cached never rejects
    const found =
      provider === 'codex'
        ? codexModels(home)
        : provider === 'copilot'
          ? ((await copilotServerModels(home, login)) ?? (await copilotLoggedModels(home)))
          : []
    return mergeModels(BUILTIN_MODELS[provider], found)
  },
  { keyOf: ({ provider, home, login }) => `${provider}|${home}|${login ?? ''}` }
)
