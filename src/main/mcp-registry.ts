import type { PanelReport } from '../shared/library'
import {
  MCP_REGISTRY,
  parseRegistryEntry,
  parseRegistryPage,
  registryConfig,
  registryLocalNames,
  registryPlan,
  registrySearchUrl,
  registryTitle,
  registryVersionUrl,
  runsSame,
  type RegistryEntry
} from '../shared/mcp-registry'
import type {
  McpConfig,
  McpServerInfo,
  Provider,
  RegistryAdd,
  RegistryPage,
  RegistryServer
} from '../shared/types'
import { getExtensions } from './extensions'
import { addMcpServer, globalMcpEntries } from './library'
import { withRecent } from './recent-map'
import { shellWord } from './shell-quote'

/*
 * Looking MCP servers up in the MCP Registry, and adding one.
 *
 * The network is a click here as everywhere in Cockpit: a search runs when the person
 * submits one, and nothing is fetched on arrival. What an add writes is decided in main
 * from the registry's own entry (`registryConfig`) — the renderer names a server and
 * hands over what was typed for its inputs, never a command.
 */

/**
 * Where the registry is. The hermetic seam, like COCKPIT_CLI_LATEST: the ui-tour serves
 * a canned registry on a loopback port so its shots never reach the network. Only a
 * loopback address is taken — nothing can point Cockpit's adds at another host.
 */
function registryBase(): string {
  const local = process.env['COCKPIT_MCP_REGISTRY']
  return local && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(local) ? local : MCP_REGISTRY
}

/** The registry is sometimes slow to answer a search; a page is small. */
const FETCH_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * Entries seen in a search, by `id@version`, so an add uses exactly what was shown.
 * A process-lifetime cache (it mutates), bounded — the oldest go first.
 */
let seen: Readonly<Record<string, RegistryEntry>> = {}
const MAX_SEEN = 1000

function remember(entry: RegistryEntry): void {
  seen = withRecent(seen, { id: `${entry.id}@${entry.version}`, value: entry, cap: MAX_SEEN })
}

/** Read a JSON body without holding more than the cap, however much is sent. */
async function readJson(url: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    throw new Error(timedOut ? 'The MCP Registry didn’t answer in time — try again.' : 'Couldn’t reach the MCP Registry.')
  }
  if (!res.ok) throw new Error(`The MCP Registry answered HTTP ${res.status}.`)
  const reader = res.body?.getReader()
  if (!reader) return JSON.parse(await res.text())
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new Error('The MCP Registry sent more than a page.')
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

type Known = ReadonlyArray<{ readonly name: string; readonly config?: McpConfig }>

/**
 * One entry as it would land here: whether it can be added, under which name, and
 * which agents already run it. A server this machine already has — under any name, as
 * long as it runs the same package or url — is that server, not a second one.
 */
export function describeForHere(entry: RegistryEntry, known: Known, inventory: readonly McpServerInfo[]): RegistryServer {
  const plan = registryPlan(entry)
  const names = registryLocalNames(entry.id)
  const head = {
    id: entry.id,
    version: entry.version,
    title: registryTitle(entry),
    description: entry.description,
    ...(entry.repository ? { repository: entry.repository } : {}),
    ...(entry.website ? { website: entry.website } : {})
  }
  if ('refusal' in plan) {
    return { ...head, name: names[0] ?? entry.id, inputs: [], refusal: plan.refusal, agents: [], unsupported: {} }
  }
  const agentsOf = (name: string): Provider[] => inventory.find((s) => s.name === name)?.agents ?? []
  const same =
    inventory.find((s) => runsSame(s.config, plan.kind, plan.what))?.name ??
    known.find((e) => e.config && runsSame(e.config, plan.kind, plan.what))?.name
  const taken = new Set([...known.map((e) => e.name), ...inventory.map((s) => s.name)])
  const name = same ?? names.find((n) => !taken.has(n))
  // what an add writes, from the plan `registryConfig` builds on — shown before it is
  // written. A server already here is added with its own definition instead
  const written = same
    ? {}
    : {
        ...(plan.release ? { release: plan.release } : {}),
        ...(plan.base.command
          ? { commandLine: [plan.base.command, ...(plan.base.args ?? [])].map(shellWord).join(' ') }
          : {}),
        ...(plan.base.env && Object.keys(plan.base.env).length > 0 ? { fixedEnv: plan.base.env } : {})
      }
  const base = { ...head, kind: plan.kind, what: plan.what, unsupported: plan.unsupported, ...written }
  if (name === undefined) {
    return {
      ...base,
      name: names[0] ?? entry.id,
      inputs: [],
      refusal: `a different server named ${names[0]} is already set up here`,
      agents: []
    }
  }
  // one already here brings its own env: nothing to ask for again
  return { ...base, name, inputs: same ? [] : plan.inputs, agents: same ? agentsOf(same) : [] }
}

/** Search the registry. Only ever on the person's submit. */
export async function searchRegistry(query: string, cursor?: string): Promise<RegistryPage> {
  const q = query.trim().slice(0, 100)
  if (q === '') throw new Error('Type what to look for.')
  const page = parseRegistryPage(await readJson(registrySearchUrl(q, cursor?.slice(0, 300), registryBase())))
  const known = globalMcpEntries()
  const inventory = getExtensions().mcp
  for (const entry of page.entries) remember(entry)
  return {
    servers: page.entries.map((entry) => describeForHere(entry, known, inventory)),
    ...(page.next ? { next: page.next } : {})
  }
}

async function entryFor(id: string, version: string): Promise<RegistryEntry> {
  const hit = Object.hasOwn(seen, `${id}@${version}`) ? seen[`${id}@${version}`] : undefined
  if (hit) return hit
  const entry = parseRegistryEntry(await readJson(registryVersionUrl(id, version, registryBase())))
  if (!entry || entry.id !== id || entry.version !== version) {
    throw new Error(`The MCP Registry no longer offers ${id} ${version}.`)
  }
  remember(entry)
  return entry
}

/**
 * Add one registry server to one agent. Everything is decided again here, from the
 * registry's entry and this machine's config as they are now — the renderer's copy of
 * the row may be minutes old.
 */
export async function addFromRegistry(req: RegistryAdd): Promise<PanelReport> {
  const entry = await entryFor(req.id, req.version)
  const here = describeForHere(entry, globalMcpEntries(), getExtensions().mcp)
  if (here.refusal) throw new Error(`Cockpit can’t add ${here.title}: ${here.refusal}.`)
  const unsupported = here.unsupported[req.agent]
  if (unsupported) throw new Error(`${unsupported}.`)
  // a server Cockpit already knows is switched on with the definition it has
  const known = globalMcpEntries().some((e) => e.name === here.name)
  return known
    ? addMcpServer(here.name, req.agent)
    : addMcpServer(here.name, req.agent, registryConfig(entry, req.values))
}
