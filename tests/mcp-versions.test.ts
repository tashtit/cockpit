import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpVersions } from '../src/main/mcp-versions'

/*
 * The registry half: what Cockpit asks, and what it makes of the answer. `fetch` is
 * replaced with a recorder rather than mocked through a framework — the point of
 * these tests is the URL that goes out and the verdict that comes back.
 */

type Answer = { status?: number; body?: unknown; fail?: Error }

function serve(answers: Record<string, Answer>): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(String(url))
    const answer = answers[String(url)] ?? { status: 404 }
    if (answer.fail) throw answer.fail
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: async () => answer.body
    }
  })
  return asked
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const npx = (spec: string): { command: string; args: string[] } => ({
  command: 'npx',
  args: ['-y', spec]
})

describe('asking a registry about a pinned server', () => {
  it('escapes a scope the way the npm registry spells it, and reports the newer release', async () => {
    const asked = serve({
      'https://registry.npmjs.org/@playwright%2Fmcp/latest': { body: { version: '0.0.82' } }
    })
    const [found] = await mcpVersions([{ name: 'playwright', config: npx('@playwright/mcp@0.0.78') }])
    expect(asked).toEqual(['https://registry.npmjs.org/@playwright%2Fmcp/latest'])
    expect(found).toMatchObject({
      name: 'playwright',
      registry: 'npm',
      pkg: '@playwright/mcp',
      current: '0.0.78',
      latest: '0.0.82',
      status: 'update'
    })
  })

  it('says up to date when the pin already is', async () => {
    serve({ 'https://registry.npmjs.org/a-mcp/latest': { body: { version: '1.0.0' } } })
    const [found] = await mcpVersions([{ name: 'a', config: npx('a-mcp@1.0.0') }])
    expect(found.status).toBe('current')
  })

  it('never suggests a downgrade when the registry is behind the pin', async () => {
    serve({ 'https://registry.npmjs.org/a-mcp/latest': { body: { version: '1.0.0' } } })
    const [found] = await mcpVersions([{ name: 'a', config: npx('a-mcp@2.0.0') }])
    expect(found.status).toBe('current')
  })

  it('reads PyPI’s own shape', async () => {
    serve({ 'https://pypi.org/pypi/analytics-mcp/json': { body: { info: { version: '1.5.0' } } } })
    const [found] = await mcpVersions([
      { name: 'analytics', config: { command: 'pipx', args: ['run', 'analytics-mcp==1.4.0'] } }
    ])
    expect(found).toMatchObject({ registry: 'pypi', latest: '1.5.0', status: 'update' })
  })

  it('asks about nothing that has no version to compare', async () => {
    const asked = serve({})
    const found = await mcpVersions([
      { name: 'floating', config: npx('a-mcp') },
      { name: 'remote', config: { url: 'https://example.dev/mcp' } },
      { name: 'binary', config: { command: 'gh-mcp' } }
    ])
    expect(found).toEqual([])
    expect(asked).toEqual([])
  })

  it('fails soft, and says what went wrong', async () => {
    serve({ 'https://registry.npmjs.org/gone-mcp/latest': { status: 404 } })
    const [missing] = await mcpVersions([{ name: 'gone', config: npx('gone-mcp@1.0.0') }])
    expect(missing).toMatchObject({ status: 'unknown', detail: 'no such package' })

    serve({
      'https://registry.npmjs.org/offline-mcp/latest': { fail: new Error('getaddrinfo ENOTFOUND') }
    })
    const [offline] = await mcpVersions([{ name: 'offline', config: npx('offline-mcp@1.0.0') }])
    expect(offline).toMatchObject({ status: 'unknown' })
    expect(offline.detail).toContain('ENOTFOUND')
  })

  it('never puts something that isn’t a package name in a URL', async () => {
    const asked = serve({})
    const [found] = await mcpVersions([
      { name: 'odd', config: npx('../../etc/passwd@1.0.0') }
    ])
    expect(asked).toEqual([])
    expect(found).toMatchObject({ status: 'unknown' })
    expect(found.detail).toMatch(/package name/)
  })

  it('asks a package once — the answer is cached for the session', async () => {
    const asked = serve({ 'https://registry.npmjs.org/cached-mcp/latest': { body: { version: '3.0.0' } } })
    await mcpVersions([{ name: 'one', config: npx('cached-mcp@1.0.0') }])
    await mcpVersions([{ name: 'two', config: npx('cached-mcp@2.0.0') }])
    expect(asked).toHaveLength(1)
  })
})
