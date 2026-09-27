import { describeMcp, isNewer, registryOf, type Registry } from '../shared/mcp-source'
import type { McpConfig, McpVersion } from '../shared/types'
import { mapLimit } from './map-limit'
import { throttledBy } from './cache'

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

type Package = { readonly registry: Registry; readonly pkg: string }

/**
 * The registry's newest release, from the cache when it was asked recently. Asks in
 * flight are shared, so two rows pinning the same package — and two panels opened in
 * quick succession — fetch it once. Deliberately not a cache of failures: a registry
 * that was unreachable a second ago is worth asking again.
 */
const latestVersions = throttledBy(TTL_MS, ({ registry, pkg }: Package) => fetchLatest(registry, pkg), {
  keyOf: ({ registry, pkg }) => `${registry}:${pkg}`
})

function latestVersion(registry: Registry, pkg: string): Promise<string> {
  return latestVersions({ registry, pkg })
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
  }, MAX_PARALLEL)
}
