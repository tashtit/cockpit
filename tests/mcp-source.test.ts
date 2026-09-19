import { describe, expect, it } from 'vitest'
import {
  describeMcp,
  isExactVersion,
  isNewer,
  mcpLabel,
  registryOf,
  splitSpec,
  withVersion
} from '../src/shared/mcp-source'
import { canReach, isAddableSource, marketReach } from '../src/shared/library'
import type { MarketplaceInfo } from '../src/shared/types'

/*
 * The definitions here are the ones that are actually in the wild: a scoped npm
 * package pinned to a version, a floating one, a pipx runner, a remote URL, a
 * plain binary. What the panel says about a server is read off exactly this.
 */

describe('what an MCP definition is', () => {
  it('reads a pinned npm package out of an npx line', () => {
    const d = describeMcp({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.78'] })
    expect(d).toMatchObject({ kind: 'npm', what: '@playwright/mcp', version: '0.0.78' })
    expect(registryOf(d)).toBe('npm')
  })

  it('keeps the flags after the package out of the package name', () => {
    const d = describeMcp({
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@0.21.0', '--auto-connect', '--no-usage-statistics']
    })
    expect(d).toMatchObject({ what: 'chrome-devtools-mcp', version: '0.21.0' })
  })

  it('calls an unpinned package floating — there is nothing to suggest', () => {
    const d = describeMcp({ command: 'npx', args: ['-y', 'some-mcp'] })
    expect(d).toMatchObject({ kind: 'npm', what: 'some-mcp', floating: true })
    expect(d.version).toBeUndefined()
  })

  it('treats a range or a dist-tag as floating, and says what was asked for', () => {
    expect(describeMcp({ command: 'npx', args: ['pkg@latest'] })).toMatchObject({
      floating: true,
      range: 'latest'
    })
    expect(describeMcp({ command: 'npx', args: ['pkg@^1.2.0'] })).toMatchObject({
      floating: true,
      range: '^1.2.0'
    })
  })

  it('follows the runners that spell exec their own way', () => {
    expect(describeMcp({ command: 'pnpm', args: ['dlx', 'a-mcp@1.0.0'] })).toMatchObject({
      kind: 'npm',
      what: 'a-mcp',
      runner: 'pnpm dlx'
    })
    expect(describeMcp({ command: 'uv', args: ['tool', 'run', 'b-mcp'] })).toMatchObject({
      kind: 'pypi',
      what: 'b-mcp'
    })
    expect(describeMcp({ command: 'pipx', args: ['run', 'analytics-mcp'] })).toMatchObject({
      kind: 'pypi',
      what: 'analytics-mcp',
      floating: true
    })
  })

  it('reads pip’s own pin spelling', () => {
    expect(describeMcp({ command: 'pipx', args: ['run', 'analytics-mcp==1.4.2'] })).toMatchObject({
      kind: 'pypi',
      what: 'analytics-mcp',
      version: '1.4.2'
    })
  })

  it('takes the package from the flag that names it', () => {
    expect(describeMcp({ command: 'uvx', args: ['--from', 'a-pkg@1.0.0', 'a-cmd'] })).toMatchObject({
      what: 'a-pkg',
      version: '1.0.0'
    })
    expect(describeMcp({ command: 'npx', args: ['-p', 'b-pkg', 'b-cmd'] })).toMatchObject({
      what: 'b-pkg'
    })
  })

  it('reads a runner configured by absolute path', () => {
    expect(describeMcp({ command: '/opt/homebrew/bin/npx', args: ['x-mcp@2.0.0'] })).toMatchObject({
      kind: 'npm',
      what: 'x-mcp',
      version: '2.0.0'
    })
  })

  it('names a remote server by its host and how it is reached', () => {
    expect(describeMcp({ url: 'https://app.example.dev/mcp/', type: 'http' })).toEqual({
      kind: 'remote',
      what: 'app.example.dev',
      transport: 'http'
    })
    expect(describeMcp({ url: 'https://x.example/sse', type: 'sse' })).toMatchObject({
      transport: 'sse'
    })
  })

  it('leaves anything it can’t read confidently as the command itself', () => {
    expect(describeMcp({ command: 'gh-mcp', args: ['--stdio'] })).toEqual({
      kind: 'binary',
      what: 'gh-mcp'
    })
    expect(describeMcp({})).toEqual({ kind: 'unknown', what: '' })
  })

  it('reads a container image only when nothing before it could be a flag value', () => {
    expect(describeMcp({ command: 'docker', args: ['run', '-i', '--rm', 'org/img:1.2'] })).toEqual({
      kind: 'container',
      what: 'org/img:1.2',
      runner: 'docker'
    })
    // `-e` swallows the next word: reading it as the image would be confidently wrong
    expect(describeMcp({ command: 'docker', args: ['run', '-e', 'KEY', 'org/img'] })).toEqual({
      kind: 'container',
      what: 'docker',
      runner: 'docker'
    })
  })
})

describe('the line the row shows', () => {
  it('says where it comes from, what it is, and which version', () => {
    expect(mcpLabel({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.78'] })).toBe(
      'npm · @playwright/mcp 0.0.78'
    )
    expect(mcpLabel({ command: 'pipx', args: ['run', 'analytics-mcp'] })).toBe(
      'PyPI · analytics-mcp latest'
    )
    expect(mcpLabel({ url: 'https://app.example.dev/mcp/', type: 'http' })).toBe(
      'http · app.example.dev'
    )
    expect(mcpLabel({ command: 'gh-mcp', args: ['--stdio'] })).toBe('local · gh-mcp')
    // a runtime is named by what it runs, not by itself
    expect(mcpLabel({ command: 'node', args: ['scripts/db-mcp.js'] })).toBe(
      'local · node scripts/db-mcp.js'
    )
    expect(mcpLabel({})).toContain('no command')
  })
})

describe('versions', () => {
  it('knows an exact release from a range or a tag', () => {
    expect(isExactVersion('0.0.78')).toBe(true)
    expect(isExactVersion('1.2.3-rc.1')).toBe(true)
    expect(isExactVersion('^1.2.3')).toBe(false)
    expect(isExactVersion('latest')).toBe(false)
  })

  it('compares releases number by number', () => {
    expect(isNewer('0.0.82', '0.0.78')).toBe(true)
    expect(isNewer('0.1.0', '0.0.99')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.0.9', '0.0.10')).toBe(false)
    expect(isNewer('1.2', '1.1.9')).toBe(true)
  })

  it('treats a pre-release as older than the release it leads to', () => {
    expect(isNewer('1.2.3', '1.2.3-rc.1')).toBe(true)
    expect(isNewer('1.2.3-rc.1', '1.2.3')).toBe(false)
  })

  it('never calls an unparseable version newer', () => {
    expect(isNewer('latest', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', 'nightly')).toBe(false)
  })

  it('splits a spec without mistaking a scope for a separator', () => {
    expect(splitSpec('@playwright/mcp@0.0.78')).toMatchObject({
      name: '@playwright/mcp',
      version: '0.0.78'
    })
    expect(splitSpec('@playwright/mcp').version).toBeUndefined()
    expect(splitSpec('pkg==1.0').version).toBe('1.0')
  })
})

describe('pinning a new version', () => {
  it('rewrites the spec and nothing else', () => {
    const config = {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.78', '--headless'],
      env: { TOKEN: 'x' }
    }
    expect(withVersion(config, '0.0.82')).toEqual({
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.82', '--headless'],
      env: { TOKEN: 'x' }
    })
  })

  it('keeps the spelling the definition already used', () => {
    expect(withVersion({ command: 'pipx', args: ['run', 'a-mcp==1.0.0'] }, '2.0.0').args).toEqual([
      'run',
      'a-mcp==2.0.0'
    ])
  })

  it('refuses to pin a server that deliberately pins nothing', () => {
    expect(() => withVersion({ command: 'npx', args: ['-y', 'a-mcp'] }, '2.0.0')).toThrow(
      /pins no version/
    )
  })

  it('refuses anything that isn’t a version, or isn’t a package', () => {
    expect(() => withVersion({ command: 'npx', args: ['a@1.0.0'] }, 'latest')).toThrow()
    expect(() => withVersion({ command: 'gh-mcp' }, '1.0.0')).toThrow(/not launched from a package/)
  })
})

describe('what a marketplace can reach', () => {
  const markets: MarketplaceInfo[] = [
    { name: 'tashtit', agent: 'claude', source: 'https://github.com/tashtit/marketplace.git' },
    { name: 'tashtit', agent: 'codex', source: 'https://github.com/tashtit/marketplace.git' },
    { name: 'official', agent: 'claude', source: 'anthropics/claude-plugins-official' },
    { name: 'bundled', agent: 'codex', source: '/Users/me/.codex/.tmp/bundled/bundled' },
    { name: 'copilot-side', agent: 'copilot' }
  ]

  it('calls a git remote or a GitHub shorthand addable, and a path not', () => {
    expect(isAddableSource('https://github.com/a/b.git')).toBe(true)
    expect(isAddableSource('git@github.com:a/b.git')).toBe(true)
    expect(isAddableSource('anthropics/claude-plugins-official')).toBe(true)
    expect(isAddableSource('/Users/me/.codex/.tmp/bundled/bundled')).toBe(false)
    expect(isAddableSource(undefined)).toBe(false)
  })

  it('lets every agent reach a marketplace with a real source', () => {
    const reach = marketReach('tashtit', markets)
    expect(reach.has).toEqual(['claude', 'codex'])
    expect(canReach(reach, 'copilot')).toBe(true)
  })

  it('keeps a marketplace that ships inside one agent to that agent', () => {
    const reach = marketReach('bundled', markets)
    expect(reach.has).toEqual(['codex'])
    expect(canReach(reach, 'codex')).toBe(true)
    expect(canReach(reach, 'claude')).toBe(false)
  })

  it('reaches nobody new when no agent records where it came from', () => {
    const reach = marketReach('copilot-side', markets)
    expect(canReach(reach, 'copilot')).toBe(true)
    expect(canReach(reach, 'claude')).toBe(false)
    expect(canReach(marketReach(undefined, markets), 'claude')).toBe(false)
  })
})
