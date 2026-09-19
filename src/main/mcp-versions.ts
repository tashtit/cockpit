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

/** A package name is put in a URL, and it comes out of a hand-edited config file. */
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/

/** Answers keyed `<registry>:<package>`; a process-lifetime cache, so it mutates. */
const cache = new Map<string, { readonly version: string; readonly at: number }>()

function registryUrl(registry: Registry, pkg: string): string {
  // the npm registry spells a scope's slash escaped and its @ bare
  return registry === 'npm'
    ? `https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`
    : `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`
}

function nameOk(registry: Registry, pkg: string): boolean {
  return registry === 'npm' ? NPM_NAME.test(pkg) : PYPI_NAME.test(pkg)
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
async function latestVersion(registry: Registry, pkg: string): Promise<string> {
  const key = `${registry}:${pkg}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.version
  const version = await fetchLatest(registry, pkg)
  cache.set(key, { version, at: Date.now() })
  return version
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
  const out = await Promise.all(
    asked.map(async ({ server, described }): Promise<McpVersion> => {
      const registry = registryOf(described)!
      const base = {
        name: server.name,
        registry,
        pkg: described.what,
        current: described.version!
      }
      if (!nameOk(registry, described.what)) {
        return { ...base, status: 'unknown', detail: `${described.what} isn’t a package name` }
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
  )
  return out
}
