import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { UpdateState, UpdateSuggestion } from '../src/shared/types'
import { digestHeadline, sortSuggestions, SUGGESTION_TAG } from '../src/shared/updates-digest'
import {
  agentDrift,
  appUpdate,
  forgetUpdatesDigest,
  pluginUpdates,
  updatesDigest
} from '../src/main/updates-digest'

/*
 * The home's "is anything out of date?" strip. The fold is pure and is tested as
 * such; the sources that read disk are tested against a throwaway HOME, one at a
 * time. `updatesDigest` — the assembly and its cache — runs against an empty HOME with
 * no agent CLI on PATH but the stubs a test puts there.
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
            },
            // Copilot had gcloud (its own definition was read from it), and no longer does
            {
              kind: 'mcp',
              name: 'gcloud',
              enabled: { claude: true, copilot: true },
              config: { command: 'npx', args: ['-y', '@google-cloud/gcloud-mcp@0.5.3'] },
              raw: { copilot: { command: 'npx', args: ['-y', '@google-cloud/gcloud-mcp@0.5.3'] } }
            }
          ]
        }
      })
    )
    write(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          linear: { type: 'sse', url: 'https://mcp.linear.app/sse' },
          gcloud: { command: 'npx', args: ['-y', '@google-cloud/gcloud-mcp@0.5.3'] }
        }
      })
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
    // Cockpit never saw Codex hold it: it was never written there
    expect(row?.detail).toBe('MCP servers — switched on, but not written yet')
  })

  it('says an agent that had something lost it outside Cockpit', () => {
    const row = agentDrift().items.find((i) => i.name === 'gcloud')
    expect(row?.agents).toEqual(['copilot'])
    expect(row?.detail).toBe('MCP servers — removed outside Cockpit')
  })
})

describe('gathering it all, on demand', () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, ud: process.env.COCKPIT_USER_DATA, latest: process.env.COCKPIT_CLI_LATEST }
  const roots: string[] = []
  let home = ''
  let bin = ''
  const app = { state: { status: 'available', version: '2.0.0' } as UpdateState, version: '1.0.0' }

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-gather-'))
    roots.push(root)
    home = join(root, 'home')
    bin = join(root, 'bin')
    mkdirSync(home, { recursive: true })
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(root, 'ud'), { recursive: true })
    writeFileSync(join(root, 'ud', 'cockpit-config.json'), JSON.stringify({ sources: [] }))
    process.env.HOME = home
    process.env.COCKPIT_USER_DATA = join(root, 'ud')
    // no agent CLI but a test's stubs, and no registry asked for the newest release
    process.env.PATH = `${bin}:/usr/bin:/bin`
    process.env.COCKPIT_CLI_LATEST = JSON.stringify({ claude: '1.0.0', codex: '1.0.0', copilot: '1.0.0' })
    // every spawn also searches the install dirs (`cliPath`), so a CLI this Mac installed
    // with Homebrew is found anyway — and its channel's newest release is asked of brew,
    // which the pin above doesn't reach. A brew that knows nothing keeps that question
    // off the machine the tests happen to run on
    writeFileSync(join(bin, 'brew'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(bin, 'brew'), 0o755)
    forgetUpdatesDigest()
  })

  afterEach(() => {
    for (const [key, value] of [['HOME', saved.HOME], ['PATH', saved.PATH], ['COCKPIT_USER_DATA', saved.ud], ['COCKPIT_CLI_LATEST', saved.latest]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it('asks once, and hands the same answer back until something changes', async () => {
    const first = await updatesDigest({ app })
    expect(first.items.map((i) => i.kind)).toEqual(['app'])
    expect(first.problems).toEqual([])
    expect(await updatesDigest({ app })).toBe(first)
  })

  it('shares one gathering between callers that ask at once', async () => {
    const [a, b] = await Promise.all([updatesDigest({ app }), updatesDigest({ app })])
    expect(a).toBe(b)
  })

  it('asks afresh when told to, and after a write says the answer is stale', async () => {
    const first = await updatesDigest({ app })
    const forced = await updatesDigest({ app, force: true })
    expect(forced).not.toBe(first)
    forgetUpdatesDigest()
    expect(await updatesDigest({ app })).not.toBe(forced)
  })

  // a gathering under way when a write settles saw the machine before the write: it
  // answers whoever asked it, but the next ask must not be handed it for 15 minutes
  it('keeps nothing a gathering found when a write lands during it', async () => {
    const during = updatesDigest({ app })
    forgetUpdatesDigest()
    const stale = await during
    expect(await updatesDigest({ app })).not.toBe(stale)
  })

  it('lets a forced gathering win over a plain one already under way', async () => {
    const plain = updatesDigest({ app })
    const forced = updatesDigest({ app, force: true })
    // a visit while Check again is gathering shares that gathering
    const rider = updatesDigest({ app })
    const [, fresh, rode] = await Promise.all([plain, forced, rider])
    expect(rode).toBe(fresh)
    expect(await updatesDigest({ app })).toBe(fresh)
  })

  // the update itself runs in Terminal, which settles nothing in Cockpit: a kept
  // answer checks its CLI rows against the CLIs before it is handed out again
  it('drops a CLI row once that CLI is up to date, without gathering the rest again', async () => {
    const version = join(home, 'claude-version')
    writeFileSync(version, '0.9.0\n')
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat '${version}'\n`)
    chmodSync(join(bin, 'claude'), 0o755)
    const first = await updatesDigest({ app })
    expect(first.items.map((i) => i.id)).toEqual(['app:cockpit', 'cli:claude'])
    writeFileSync(version, '1.0.0\n')
    const after = await updatesDigest({ app })
    expect(after.items.map((i) => i.id)).toEqual(['app:cockpit'])
    // the same gathering, its CLI rows brought up to date
    expect(after.at).toBe(first.at)
  })

  // a marketplace's clone is what the plugin rows read, and a third-party one never
  // refreshes itself — so the person's Check again pulls them first, and only then
  it('pulls the agents’ marketplaces only on Check again, and names one that could not be', async () => {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    writeFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ acme: { source: 'acme/plugins' } }))
    const log = join(home, 'claude-calls.log')
    writeFileSync(
      join(bin, 'claude'),
      ['#!/bin/sh', `echo "$@" >> '${log}'`, '[ "$1 $2" = "plugin marketplace" ] && { echo "offline" >&2; exit 1; }', 'exit 0'].join('\n')
    )
    chmodSync(join(bin, 'claude'), 0o755)
    await updatesDigest({ app })
    const pulls = (): string[] =>
      existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('plugin marketplace')) : []
    expect(pulls()).toEqual([])
    const forced = await updatesDigest({ app, force: true })
    expect(pulls()).toEqual(['plugin marketplace update'])
    expect(forced.problems).toEqual([expect.stringMatching(/^couldn’t refresh claude’s marketplaces — .*offline/)])
  })
})
