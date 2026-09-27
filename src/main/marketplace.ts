import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PROVIDERS, RECOMMENDED_MARKETPLACE, isAddableSource } from '../shared/library'
import { CATALOG_PATHS, catalogUrls, githubRepoOf, parseCatalog } from '../shared/marketplace'
import type { MarketplaceCatalog, Provider } from '../shared/types'
import { getExtensions } from './extensions'
import { parseJsonc } from './parsers/util'

/*
 * Looking a marketplace up: what it offers, and where that answer came from.
 *
 * Two questions, deliberately answered differently. "What do the marketplaces on this
 * machine hold?" is read from the clone the agent already made — no network, every
 * time. "What is in that one over there?" is a fetch, and only ever on the person's
 * own click (`lookupCatalog`): browsing must not quietly call out to the internet, and
 * the tour, the e2e tier and an offline machine all see the local answer unchanged.
 *
 * Failure is soft and named. A marketplace whose catalogue can't be read still lists,
 * with the reason on the row, because "you have this marketplace" is true either way.
 */

/** A catalogue is JSON a person wrote; the head of it is the whole file in practice. */
const MAX_CATALOG_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 8000
/** Fetched catalogues are cached for the session's afternoon, never polled. */
const REMOTE_TTL_MS = 6 * 60 * 60 * 1000

/** A marketplace name becomes a path segment — dots-only would escape the plugins dir. */
const NAME_RE = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/

/** A catalogue as `parseCatalog` hands it back: the marketplace's name and its plugins. */
type Catalog = NonNullable<ReturnType<typeof parseCatalog>>

/** Fetched catalogues by `owner/repo`; a process-lifetime cache, so it mutates. */
const remoteCache = new Map<string, { readonly at: number; readonly catalog: Catalog }>()

/**
 * Where an agent keeps the marketplaces it cloned. Claude Code is the one that has
 * moved (`repos/` before `marketplaces/`), and both spellings are still on disk on a
 * machine that has been through the change. Codex keeps its snapshots under `.tmp/`.
 */
function cloneDirs(name: string): string[] {
  const home = homedir()
  return [
    join(home, '.claude', 'plugins', 'marketplaces', name),
    join(home, '.claude', 'plugins', 'repos', name),
    join(home, '.codex', '.tmp', 'marketplaces', name),
    join(home, '.codex', 'plugins', 'marketplaces', name),
    join(home, '.copilot', 'plugins', 'marketplaces', name)
  ]
}

function readBounded(path: string): string | null {
  try {
    if (statSync(path).size > MAX_CATALOG_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The catalogue in a clone on this machine, or null when there is none to read. */
function localCatalog(name: string): Catalog | null {
  if (!NAME_RE.test(name)) return null
  for (const dir of cloneDirs(name)) {
    for (const path of CATALOG_PATHS) {
      const raw = readBounded(join(dir, path))
      if (raw === null) continue
      const parsed = parseCatalog(parseJsonc(raw), name)
      if (parsed) return parsed
    }
  }
  return null
}

/** Each marketplace this machine knows, with the agents that have it and its source. */
function knownMarketplaces(): Array<{ name: string; agents: Provider[]; source?: string }> {
  const inv = getExtensions()
  const out = new Map<string, { name: string; agents: Provider[]; source?: string }>()
  for (const market of inv.marketplaces) {
    const found = out.get(market.name) ?? { name: market.name, agents: [] }
    if (!found.agents.includes(market.agent)) found.agents.push(market.agent)
    if (found.source === undefined && isAddableSource(market.source)) found.source = market.source
    out.set(market.name, found)
  }
  // the one Cockpit recommends is always browsable, whether or not any agent has it
  const { name, source } = RECOMMENDED_MARKETPLACE
  const rec = out.get(name)
  out.set(name, rec ? { ...rec, source: rec.source ?? source } : { name, agents: [], source })
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every marketplace on this machine and what it offers, read from disk alone.
 *
 * A marketplace with no clone here — one only another agent installed from, or the
 * recommended one nobody has added — lists with `problem` set and no plugins, and the
 * browse view offers to look it up.
 */
export function listCatalogs(): MarketplaceCatalog[] {
  return knownMarketplaces().map((market) => {
    const local = localCatalog(market.name)
    const recommended = market.name === RECOMMENDED_MARKETPLACE.name
    return {
      name: market.name,
      ...(market.source ? { source: market.source } : {}),
      agents: PROVIDERS.filter((p) => market.agents.includes(p)),
      plugins: local?.plugins ?? [],
      ...(local ? { origin: 'local' as const } : {}),
      ...(local
        ? {}
        : {
            problem: githubRepoOf(market.source)
              ? 'no catalogue on this machine yet'
              : 'no catalogue on this machine, and no repository to read one from'
          }),
      ...(recommended ? { recommended: true as const } : {})
    }
  })
}

/** What each marketplace's own clone says its plugins are at — for the update check. */
export function localCatalogVersions(): Map<string, string> {
  const out = new Map<string, string>()
  for (const market of knownMarketplaces()) {
    for (const plugin of localCatalog(market.name)?.plugins ?? []) {
      if (plugin.version) out.set(plugin.id, plugin.version)
    }
  }
  return out
}

async function fetchCatalog(repo: string): Promise<Catalog> {
  const hit = remoteCache.get(repo)
  if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.catalog
  let last = 'no catalogue file in that repository'
  for (const url of catalogUrls(repo)) {
    let res: Response | null = null
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
    } catch (err) {
      last = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : String(err)
    }
    if (res === null) continue
    if (!res.ok) {
      if (res.status !== 404) last = `HTTP ${res.status}`
      continue
    }
    const body = (await res.text()).slice(0, MAX_CATALOG_BYTES)
    const parsed = parseCatalog(parseJsonc(body), repo.split('/')[1] ?? repo)
    if (parsed) {
      remoteCache.set(repo, { at: Date.now(), catalog: parsed })
      return parsed
    }
    last = 'that file is not a marketplace catalogue'
  }
  throw new Error(last)
}

/**
 * Look one up: a `owner/repo` or git URL the person typed, or a marketplace already
 * known whose clone isn't here. Reaches the network, which is why nothing calls it
 * except a click — and why only GitHub is read, from the one path a catalogue lives at.
 */
export async function lookupCatalog(source: string): Promise<MarketplaceCatalog> {
  const repo = githubRepoOf(source)
  if (!repo) {
    throw new Error(
      `Cockpit can look up a GitHub marketplace — "${source.slice(0, 80)}" isn’t owner/repo or a github.com URL.`
    )
  }
  const known = knownMarketplaces()
  const catalog = await fetchCatalog(repo)
  // the name the agents already know it by wins: it is the half of every plugin id
  const here = known.find((m) => githubRepoOf(m.source) === repo)
  const name = here?.name ?? catalog.name
  const plugins = catalog.plugins.map((p) => ({ ...p, id: `${p.name}@${name}` }))
  return {
    name,
    source: here?.source ?? `https://github.com/${repo}.git`,
    agents: PROVIDERS.filter((p) => here?.agents.includes(p)),
    plugins,
    origin: 'remote',
    ...(name === RECOMMENDED_MARKETPLACE.name ? { recommended: true as const } : {})
  }
}
