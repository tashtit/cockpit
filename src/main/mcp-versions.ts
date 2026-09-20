import { describeMcp, isNewer, registryOf, type Registry } from '../shared/mcp-source'
import type { McpConfig, McpVersion } from '../shared/types'

/*
 * "Is there a newer one?" — asked of the registry a pinned MCP server installs from.
 *
 * Only a server pinned to an exact version is asked about: an unpinned `npx pkg`
 * already fetches the newest release at every launch, so there is nothing to
 * suggest, and a remote server has no version at all.
 *
 * On demand and cached, never polled — the panel asks once when its MCP section is
 * opened. Every failure is soft and named: a registry that can't be reached leaves
 * the row saying what it is pinned to, which is the truth Cockpit already had.
 */

const TTL_MS = 6 * 60 * 60 * 1000
const TIMEOUT_MS = 6000
/** Registry requests in flight at once — a panel with thirty pinned servers is polite. */
const MAX_PARALLEL = 6

/** A package name is put in a URL, and it comes out of a hand-edited config file. */
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/

/** Answers keyed `<registry>:<package>`; a process-lifetime cache, so it mutates. */
const cache = new Map<string, { readonly version: string; readonly at: number }>()

/**
 * Asks in flight, keyed the same way. The cache is only written once an answer is
 * back, so without this two rows pinning the same package — and two panels opened in
 * quick succession — each miss the cache and fetch it again. Deliberately not a cache
 * of failures: a registry that was unreachable a second ago is worth asking again.
 */
const inFlight = new Map<string, Promise<string>>()

function nameOk(registry: Registry, pkg: string): boolean {
  return registry === 'npm' ? NPM_NAME.test(pkg) : PYPI_NAME.test(pkg)
}

/**
 * The URL, from a name `nameOk` has already limited to the registry's own
 * charset — which is what makes escaping a closed question. The slash in a scope
 * is the only character npm needs escaped, and it is escaped everywhere it
 * appears rather than once: a partial encoding is how a name gets to mean
 * something else.
 */
function registryUrl(registry: Registry, pkg: string): string {
  if (!nameOk(registry, pkg)) throw new Error(`${pkg} isn’t a package name`)
  // the npm registry spells a scope's slash escaped and its @ bare
  return registry === 'npm'
    ? `https://registry.npmjs.org/${pkg.replaceAll('/', '%2F')}/latest`
    : `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`
}

async function fetchLatest(registry: Registry, pkg: string): Promise<string> {
  const res = await fetch(registryUrl(registry, pkg), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(res.status === 404 ? 'no such package' : `HTTP ${res.status}`)
  const body = (await res.json()) as { version?: unknown; info?: { version?: unknown } }
  const version = registry === 'npm' ? body?.version : body?.info?.version
  if (typeof version !== 'string' || version === '') throw new Error('no version in the answer')
  return version
}

/** The registry's newest release, from the cache when it was asked recently. */
function latestVersion(registry: Registry, pkg: string): Promise<string> {
  const key = `${registry}:${pkg}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.version)
  const pending = inFlight.get(key)
  if (pending) return pending
  const ask = fetchLatest(registry, pkg)
    .then((version) => {
      cache.set(key, { version, at: Date.now() })
      return version
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, ask)
  return ask
}

/**
 * Run `work` over `items`, at most `limit` at a time, keeping the input's order in
 * the output. Rejections are the caller's to handle — here every unit already
 * resolves to a verdict, failure included.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  limit = MAX_PARALLEL
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function failed(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? 'timed out' : err.message
  return String(err)
}

/**
 * One answer per server that pins a package. Servers that pin nothing are left out
 * rather than reported as "unknown": there is no question to answer for them.
 */
export async function mcpVersions(
  servers: ReadonlyArray<{ readonly name: string; readonly config: McpConfig }>
): Promise<readonly McpVersion[]> {
  const asked = servers
    .map((server) => ({ server, described: describeMcp(server.config) }))
    .filter(({ described }) => registryOf(described) !== null && described.version !== undefined)
  return mapLimit(asked, async ({ server, described }): Promise<McpVersion> => {
    const registry = registryOf(described)!
    const base = {
      name: server.name,
      registry,
      pkg: described.what,
      current: described.version!
    }
    try {
      const latest = await latestVersion(registry, described.what)
      return {
        ...base,
        latest,
        status: isNewer(latest, base.current) ? 'update' : 'current'
      }
    } catch (err) {
      return { ...base, status: 'unknown', detail: failed(err) }
    }
  })
}
