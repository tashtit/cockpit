import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A canned MCP Registry for the tour: Agents › Browse › MCP servers searches it on a
 * loopback port (`COCKPIT_MCP_REGISTRY`), so the shots never reach the network. One of
 * each kind the view has to draw — a package that needs a token, a remote server, a
 * PyPI package, and one Cockpit refuses (a container image). Invented, like the world.
 */

const served = (server: Record<string, unknown>): Record<string, unknown> => ({
  server: { $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', ...server },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } }
})

export const REGISTRY_PAGE = {
  servers: [
    served({
      name: 'io.github.acme/search-mcp',
      title: 'Acme Search',
      description: 'Full-text search over the acme docs index, with filters for product and version.',
      version: '1.4.0',
      repository: { url: 'https://github.com/acme/search-mcp', source: 'github' },
      packages: [
        {
          registryType: 'npm',
          identifier: '@acme/search-mcp',
          version: '1.4.0',
          transport: { type: 'stdio' },
          environmentVariables: [
            { name: 'ACME_TOKEN', description: 'An API token from acme.dev/settings/tokens', isRequired: true, isSecret: true },
            { name: 'ACME_REGION', description: 'Which index to search', default: 'eu' }
          ]
        }
      ]
    }),
    served({
      name: 'dev.acme/status',
      title: 'Acme Status',
      description: 'Incidents and uptime for every acme service, read-only.',
      version: '2.0.1',
      websiteUrl: 'https://status.acme.dev',
      remotes: [{ type: 'streamable-http', url: 'https://mcp.status.acme.dev/mcp' }]
    }),
    served({
      name: 'io.github.octo-dev/tickets',
      description: 'Files and triages tickets in the acme tracker.',
      version: '0.3.2',
      repository: { url: 'https://github.com/octo-dev/tickets', source: 'github' },
      packages: [{ registryType: 'pypi', identifier: 'acme-tickets', version: '0.3.2', runtimeHint: 'uvx', transport: { type: 'stdio' } }]
    }),
    served({
      name: 'io.github.acme/vault-mcp',
      title: 'Acme Vault',
      description: 'Secrets from the acme vault, scoped per project.',
      version: '0.9.0',
      packages: [{ registryType: 'oci', identifier: 'docker.io/acme/vault-mcp', version: '0.9.0', transport: { type: 'stdio' } }]
    })
  ],
  metadata: { count: 4 }
}

/** Serve the page for any search, and each entry by its exact version. */
export async function startRegistry(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')
    const one = path.match(/^\/v0\/servers\/(.+)\/versions\/([^/]+)$/)
    const body = one
      ? REGISTRY_PAGE.servers.find((e) => {
          const s = e['server'] as Record<string, unknown>
          return s['name'] === one[1] && s['version'] === one[2]
        })
      : path === '/v0/servers'
        ? REGISTRY_PAGE
        : undefined
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body ?? { error: 'not found' }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}
