import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UpdateState, UpdateSuggestion } from '../src/shared/types'
import { digestHeadline, sortSuggestions, SUGGESTION_TAG } from '../src/shared/updates-digest'
import { agentDrift, appUpdate, pluginUpdates } from '../src/main/updates-digest'

/*
 * The home's "is anything out of date?" strip. The fold is pure and is tested as
 * such; the sources that read disk are tested against a throwaway HOME, one at a
 * time. `updatesDigest` itself is not tested here: it is the assembly, and asking it
 * anything spawns three agent CLIs.
 */

const item = (over: Partial<UpdateSuggestion> & Pick<UpdateSuggestion, 'kind' | 'name'>): UpdateSuggestion => ({
  id: `${over.kind}:${over.name}`,
  agents: [],
  detail: '',
  ...over
})

describe('what the strip says in one line', () => {
  it('says nothing at all when nothing is out of date', () => {
    expect(digestHeadline([])).toBeNull()
  })

  it('counts updates and disagreements apart — one total would hide both', () => {
    expect(digestHeadline([item({ kind: 'cli', name: 'Codex' })])).toBe('1 update')
    expect(
      digestHeadline([
        item({ kind: 'cli', name: 'Codex' }),
        item({ kind: 'mcp', name: 'linear' }),
        item({ kind: 'drift', name: 'github' })
      ])
    ).toBe('2 updates · 1 agent difference')
    expect(
      digestHeadline([item({ kind: 'drift', name: 'a' }), item({ kind: 'drift', name: 'b' })])
    ).toBe('2 agent differences')
  })

  it('reads in a fixed order: the app, the agents’ tools, then what disagrees', () => {
    const shuffled = [
      item({ kind: 'drift', name: 'github' }),
      item({ kind: 'plugin', name: 'review@acme' }),
      item({ kind: 'app', name: 'Cockpit' }),
      item({ kind: 'mcp', name: 'linear' }),
      item({ kind: 'cli', name: 'Codex' })
    ]
    expect(sortSuggestions(shuffled).map((i) => i.kind)).toEqual([
      'app',
      'cli',
      'mcp',
      'plugin',
      'drift'
    ])
  })

  it('has a word for every kind of row', () => {
    expect(Object.values(SUGGESTION_TAG).every((tag) => tag.length > 0)).toBe(true)
  })
})

describe('the app’s own update', () => {
  const state = (over: Partial<UpdateState>): { state: UpdateState; version: string } => ({
    version: '1.2.0',
    state: { status: 'available', version: '1.3.0', ...over }
  })

  it('is a row while there is something on offer', () => {
    const [row] = appUpdate(state({})).items
    expect(row.name).toBe('Cockpit')
    expect(row.current).toBe('1.2.0')
    expect(row.latest).toBe('1.3.0')
    expect(appUpdate(state({ status: 'ready' })).items[0].detail).toBe(
      'downloaded and ready to install'
    )
  })

  it('is no row when there is nothing to install', () => {
    expect(appUpdate(undefined).items).toEqual([])
    expect(appUpdate(state({ status: 'up-to-date' })).items).toEqual([])
    // an unsupported build (a dev run) never reaches the feed at all
    expect(appUpdate(state({ status: 'unsupported', version: undefined })).items).toEqual([])
  })
})

describe('against a machine’s own agent config', () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-digest-'))
  const home = join(root, 'home')
  const userData = join(root, 'user-data')
  const realHome = process.env.HOME
  const realUserData = process.env.COCKPIT_USER_DATA

  const write = (file: string, text: string): void => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }

  beforeAll(() => {
    process.env.HOME = home
    process.env.COCKPIT_USER_DATA = userData
    mkdirSync(userData, { recursive: true })
    // Cockpit's own config: linear is switched on for codex, which hasn't got it
    write(
      join(userData, 'cockpit-config.json'),
      JSON.stringify({
        sources: [],
        library: {
          global: [
            {
              kind: 'mcp',
              name: 'linear',
              enabled: { claude: true, codex: true },
              config: { type: 'sse', url: 'https://mcp.linear.app/sse' }
            }
          ]
        }
      })
    )
    write(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { linear: { type: 'sse', url: 'https://mcp.linear.app/sse' } } })
    )
    write(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'review@acme-market': [{ version: '1.0.0' }],
          'deploy@acme-market': [{ version: '3.0.0' }],
          'lint@acme-market': [{ version: '0.5.0' }]
        }
      })
    )
    // lint is in all three agents: Copilot is current, Codex (its version is the
    // directory the install went into) is further behind than Claude Code
    write(
      join(home, '.copilot', 'installed-plugins', 'acme-market', 'lint', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'lint', version: '1.0.0' })
    )
    write(join(home, '.codex', 'config.toml'), '[plugins."lint@acme-market"]\nenabled = true\n')
    mkdirSync(join(home, '.codex', 'plugins', 'cache', 'acme-market', 'lint', '0.4.0'), { recursive: true })
    write(
      join(home, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ 'acme-market': { source: 'acme/agent-plugins' } })
    )
    write(
      join(home, '.claude', 'plugins', 'marketplaces', 'acme-market', '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'acme-market',
        plugins: [
          { name: 'review', version: '1.4.0' },
          { name: 'lint', version: '1.0.0' },
          // the machine is ahead of the catalogue — not an update, and never a downgrade
          { name: 'deploy', version: '2.9.0' }
        ]
      })
    )
  })

  afterAll(() => {
    process.env.HOME = realHome
    if (realUserData === undefined) delete process.env.COCKPIT_USER_DATA
    else process.env.COCKPIT_USER_DATA = realUserData
    rmSync(root, { recursive: true, force: true })
  })

  it('offers the newer plugin its own marketplace clone lists', () => {
    const { items } = pluginUpdates()
    expect(items.map((i) => [i.name, i.current, i.latest])).toEqual([
      ['review@acme-market', '1.0.0', '1.4.0'],
      ['lint@acme-market', '0.4.0', '1.0.0']
    ])
    const review = items[0]
    expect(review.agents).toEqual(['claude'])
    expect(review.behind).toEqual(['claude'])
    expect(review.detail).toBe('acme-market has 1.4.0')
  })

  // the update brings every agent that has it to one version, so the row names them all
  // — and which of them it is news for, from the oldest version among those
  it('names every agent that has a plugin, and which of them are behind', () => {
    const lint = pluginUpdates().items.find((i) => i.name === 'lint@acme-market')
    expect(lint?.agents).toEqual(['claude', 'codex', 'copilot'])
    expect(lint?.behind).toEqual(['claude', 'codex'])
    expect(lint?.current).toBe('0.4.0')
    expect(lint?.detail).toBe('acme-market has 1.0.0 · behind in Claude Code and Codex')
  })

  it('names what the agents disagree on, and which agent is out of step', () => {
    const { items } = agentDrift()
    const row = items.find((i) => i.name === 'linear')
    expect(row?.kind).toBe('drift')
    expect(row?.agents).toEqual(['codex'])
    // never applied, or taken out of Codex on purpose: the row says only what is true
    expect(row?.detail).toBe('MCP servers — switched on, but missing from its config')
  })
})
