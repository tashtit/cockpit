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
} from './mcp-registry-core'
import type {
  McpConfig,
  McpServerInfo,
  Provider,
  RegistryAdd,
  RegistryPage,
  RegistryServer
} from '../shared/types'
import { getExtensions } from './extensions'
import { fetchBounded } from './fetch-bounded'
import { addMcpServer, globalMcpEntries } from './library'
import { withRecent } from './recent-map'
import { shellWord } from './shell-quote'

/*
 * Looking MCP servers up in the MCP Registry, and adding one.
 *
 * The MCP Registry is only ever asked on a click: a search runs when the person submits
 * one, an add reads the one version it installs, and nothing is fetched on arrival.
 * That is this module's rule, not all of Cockpit's — the home's updates list asks npm
 * and PyPI about pinned servers and the agent CLIs on a visit (`updates-digest.ts`),
 * cached — but nothing asks the registry unbidden. What an add writes is decided in main
 * from the registry's own entry (`registryConfig`, in `mcp-registry-core.ts`) — the
 * renderer names a server and hands over what was typed for its inputs, never a command.
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
 * Entries seen in a search, by `id@version` — what each row showed, so an add can
 * refuse an entry that would now write something else. A process-lifetime cache (it
 * mutates), bounded — the oldest go first. Never what an add installs from: that is
 * read afresh (`entryFor`).
 */
let seen: Readonly<Record<string, RegistryEntry>> = {}
const MAX_SEEN = 1000

function remember(entry: RegistryEntry): void {
  seen = withRecent(seen, { id: `${entry.id}@${entry.version}`, value: entry, cap: MAX_SEEN })
}

/** A JSON body, read without holding more than the cap; null when the registry has no such thing. */
async function readJson(url: string): Promise<unknown> {
  const body = await fetchBounded(url, { what: 'the MCP Registry', maxBytes: MAX_BODY_BYTES, timeoutMs: FETCH_TIMEOUT_MS })
  if (body === null) return null
  try {
    return JSON.parse(body)
  } catch {
    throw new Error('The MCP Registry answered with something that isn’t JSON.')
  }
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

/** Would these two entries write the same definition and ask for the same values? */
function samePlan(a: RegistryEntry, b: RegistryEntry): boolean {
  return JSON.stringify(registryPlan(a)) === JSON.stringify(registryPlan(b))
}

/**
 * The entry an add writes from, read afresh from the registry every time: a version
 * marked deleted or deprecated since a search showed it is no longer offered
 * (`parseRegistryEntry` skips it), and a page kept for the session would still install
 * it. One that would now write something other than what its row showed is refused too.
 */
async function entryFor(id: string, version: string): Promise<RegistryEntry> {
  const entry = parseRegistryEntry(await readJson(registryVersionUrl(id, version, registryBase())))
  if (!entry || entry.id !== id || entry.version !== version) {
    throw new Error(`The MCP Registry no longer offers ${id} ${version}.`)
  }
  const key = `${id}@${version}`
  const shown = Object.hasOwn(seen, key) ? seen[key] : undefined
  if (shown && !samePlan(shown, entry)) {
    throw new Error(
      `${registryTitle(entry)} changed in the MCP Registry since it was shown — search again to see what it runs now.`
    )
  }
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
