import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getPanel,
  keepPanelDifference,
  matchPanelEntry,
  removePanelEntry,
  restorePanelEntry,
  setMcpVersion,
  setPanelSwitch
} from '../src/main/library'
import { saveBaseline } from '../src/main/instructions'

/*
 * The library against real agent configs on disk: a throwaway HOME for the agents
 * and a throwaway userData for Cockpit's own config. Plugins and marketplaces are
 * left out on purpose — switching those runs the agent's CLI, which a unit test
 * has no business spawning.
 */

let home = ''
let userData = ''
const realHome = process.env.HOME
const realUserData = process.env.COCKPIT_USER_DATA
const roots: string[] = []

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-lib-'))
  roots.push(root)
  home = join(root, 'home')
  userData = join(root, 'user-data')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
  process.env.HOME = home
  process.env.COCKPIT_USER_DATA = userData
  writeFileSync(join(userData, 'cockpit-config.json'), JSON.stringify({ sources: [] }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  process.env.HOME = realHome
  if (realUserData === undefined) delete process.env.COCKPIT_USER_DATA
  else process.env.COCKPIT_USER_DATA = realUserData
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function write(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

const claudeJson = (): any => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))

function seedClaudeMcp(name: string, cfg: Record<string, unknown>): void {
  write(join(home, '.claude.json'), JSON.stringify({ mcpServers: { [name]: cfg } }, null, 2))
}

function seedSkill(agentDir: string, name: string, description: string): void {
  write(join(home, agentDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`)
}

const cell = (report: Awaited<ReturnType<typeof getPanel>>, name: string, agent: 'claude' | 'codex' | 'copilot') => {
  const row = report.rows.find((r) => r.name === name)
  if (!row) throw new Error(`no row for ${name}`)
  return row.cells[agent]
}

describe('first read of a scope', () => {
  it('adopts what the agents already have, switched on', () => {
    seedClaudeMcp('linear', { type: 'sse', url: 'https://mcp.linear.app/sse' })
    const report = getPanel(null)
    expect(cell(report, 'linear', 'claude').state).toBe('on')
    expect(cell(report, 'linear', 'codex').state).toBe('off')
  })

  // copying every skill folder on sight cost a full copy per skill on first read,
  // for a backup almost none of them would ever need
  it('does not copy a skill just for reading the scope', () => {
    seedSkill('.claude', 'review', 'review a diff')
    expect(cell(getPanel(null), 'review', 'claude').state).toBe('on')
    expect(existsSync(join(userData, 'library', 'global', 'skills', 'review'))).toBe(false)
  })

  it('takes the backup when the last agent copy is about to go', async () => {
    seedSkill('.claude', 'review', 'review a diff')
    getPanel(null)
    await setPanelSwitch({ repoRoot: null, kind: 'skill', name: 'review' }, 'claude', false)
    // Cockpit's store is per scope, so a repo's `review` can't overwrite the global one
    expect(existsSync(join(userData, 'library', 'global', 'skills', 'review', 'SKILL.md'))).toBe(true)
    // and it can be switched straight back on from that copy
    const back = await setPanelSwitch({ repoRoot: null, kind: 'skill', name: 'review' }, 'claude', true)
    expect(cell(back, 'review', 'claude').state).toBe('on')
    expect(readFileSync(join(home, '.claude', 'skills', 'review', 'SKILL.md'), 'utf8')).toContain(
      'review a diff'
    )
  })
})

describe('flipping a switch', () => {
  it('writes the entry into an agent that didn’t have it', async () => {
    seedClaudeMcp('linear', { type: 'sse', url: 'https://mcp.linear.app/sse' })
    getPanel(null)
    const report = await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'linear' }, 'copilot', true)
    expect(cell(report, 'linear', 'copilot').state).toBe('on')
    const copilot = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(copilot.mcpServers.linear.url).toBe('https://mcp.linear.app/sse')
  })

  it('takes it back out of the agent, and keeps the entry so it can go back', async () => {
    seedClaudeMcp('linear', { type: 'sse', url: 'https://mcp.linear.app/sse' })
    getPanel(null)
    const off = await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'linear' }, 'claude', false)
    expect(claudeJson().mcpServers.linear).toBeUndefined()
    // the row is still there — that is the difference between off and removed
    expect(cell(off, 'linear', 'claude').state).toBe('off')
    const on = await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'linear' }, 'claude', true)
    expect(cell(on, 'linear', 'claude').state).toBe('on')
    expect(claudeJson().mcpServers.linear.url).toBe('https://mcp.linear.app/sse')
  })

  // switching off takes the server out of the agent's config; what switching back on
  // writes used to be the compared fields alone, and the header is the sign-in
  it('gives an http server its headers back when it is switched off and on again', async () => {
    const api = { type: 'http', url: 'https://mcp.example.dev/mcp', headers: { Authorization: 'Bearer tok-123' } }
    seedClaudeMcp('api', api)
    getPanel(null)
    await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'api' }, 'claude', false)
    expect(claudeJson().mcpServers.api).toBeUndefined()
    const on = await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'api' }, 'claude', true)
    expect(claudeJson().mcpServers.api).toEqual(api)
    expect(cell(on, 'api', 'claude').state).toBe('on')
  })

  it('copies a skill folder into the agent it is switched on for', async () => {
    seedSkill('.claude', 'review', 'review a diff')
    getPanel(null)
    await setPanelSwitch({ repoRoot: null, kind: 'skill', name: 'review' }, 'codex', true)
    expect(readFileSync(join(home, '.codex', 'skills', 'review', 'SKILL.md'), 'utf8')).toContain(
      'review a diff'
    )
  })

  it('refuses a name that would escape the skills folder', async () => {
    seedSkill('.claude', 'review', 'x')
    getPanel(null)
    await expect(
      setPanelSwitch({ repoRoot: null, kind: 'skill', name: '../../.ssh' }, 'codex', true)
    ).rejects.toThrow(/invalid skill name/)
  })
})

describe('when the agents disagree with each other', () => {
  /** claude runs one thing, copilot another. */
  async function split(): Promise<void> {
    seedClaudeMcp('gh', { command: 'gh-mcp', args: ['--stdio'] })
    getPanel(null)
    await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'gh' }, 'copilot', true)
    write(
      join(home, '.copilot', 'mcp-config.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['-y', 'gh-mcp'] } } })
    )
  }

  it('keeps a difference on purpose, until a kept agent runs something else', async () => {
    await split()
    const target = { repoRoot: null, kind: 'mcp', name: 'gh' } as const
    const kept = await keepPanelDifference(target, true)
    const row = kept.rows.find((r) => r.name === 'gh')!
    // two agents, two answers: both were flagged, so both are kept as they are
    expect(row.drift).toEqual([])
    expect(row.disagree).toBe(false)
    expect([...row.kept].sort()).toEqual(['claude', 'copilot'])

    // copilot moves on: its kept fingerprint no longer matches, claude's still does
    write(
      join(home, '.copilot', 'mcp-config.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['-y', 'gh-mcp@2'] } } })
    )
    const again = getPanel(null)
    expect(cell(again, 'gh', 'copilot').state).toBe('changed')
    expect(cell(again, 'gh', 'claude').state).toBe('on')
    expect(again.rows.find((r) => r.name === 'gh')!.disagree).toBe(true)

    // and the other way back: forgetting the kept difference flags both again
    const forgot = await keepPanelDifference(target, false)
    expect(cell(forgot, 'gh', 'claude').state).toBe('changed')
    expect(cell(forgot, 'gh', 'copilot').state).toBe('changed')
  })

  it('forgets a kept difference only for the agent switched off, never on a switch on', async () => {
    await split()
    const target = { repoRoot: null, kind: 'mcp', name: 'gh' } as const
    await keepPanelDifference(target, true)
    await setPanelSwitch(target, 'claude', false)
    const back = await setPanelSwitch(target, 'claude', true)
    // switching claude back on writes Cockpit's copy, refreshed from copilot while
    // claude was off — so the two agree, and nothing is kept because nothing differs
    expect(cell(back, 'gh', 'claude').state).toBe('on')
    expect(back.rows.find((r) => r.name === 'gh')!.kept).toEqual([])
    // claude's kept difference went with its switch; copilot's survived both flips
    const cfg = JSON.parse(readFileSync(join(userData, 'cockpit-config.json'), 'utf8'))
    const entry = cfg.library.global.find((e: { name: string }) => e.name === 'gh')
    expect(Object.keys(entry.kept)).toEqual(['copilot'])

    // and it still means something: claude goes its own way again, copilot stays quiet
    seedClaudeMcp('gh', { command: 'gh-mcp', args: ['--stdio'] })
    const split2 = getPanel(null)
    expect(cell(split2, 'gh', 'copilot').state).toBe('on')
    expect(cell(split2, 'gh', 'claude').state).toBe('changed')
    expect(split2.rows.find((r) => r.name === 'gh')!.kept).toEqual(['copilot'])
  })

  it('forgets a kept difference once the agents are made to agree', async () => {
    await split()
    const target = { repoRoot: null, kind: 'mcp', name: 'gh' } as const
    await keepPanelDifference(target, true)
    const matched = await matchPanelEntry(target, 'claude')
    const row = matched.rows.find((r) => r.name === 'gh')!
    expect(row.kept).toEqual([])
    expect(cell(matched, 'gh', 'copilot').state).toBe('on')
    // nothing stale is left behind in the entry to resurface later
    const cfg = JSON.parse(readFileSync(join(userData, 'cockpit-config.json'), 'utf8'))
    const entry = cfg.library.global.find((e: { name: string }) => e.name === 'gh')
    expect(entry.kept).toBeUndefined()
  })

  it('flags both agents when two of them disagree and neither is the majority', async () => {
    await split()
    const report = getPanel(null)
    expect(cell(report, 'gh', 'claude').state).toBe('changed')
    expect(cell(report, 'gh', 'copilot').state).toBe('changed')
  })

  it('leaves the majority alone and flags only the odd one out', async () => {
    await split()
    await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'gh' }, 'codex', true)
    // codex was written from the kept copy, which follows claude — 2 against 1
    const report = getPanel(null)
    expect(cell(report, 'gh', 'claude').state).toBe('on')
    expect(cell(report, 'gh', 'codex').state).toBe('on')
    expect(cell(report, 'gh', 'copilot').state).toBe('changed')
  })

  it('copies the agent you pick to the others', async () => {
    await split()
    const report = await matchPanelEntry({ repoRoot: null, kind: 'mcp', name: 'gh' }, 'copilot')
    expect(claudeJson().mcpServers.gh.command).toBe('npx')
    expect(report.rows.find((r) => r.name === 'gh')?.disagree).toBe(false)
  })
})

describe('what each agent keeps of its own', () => {
  it('copies only the fields that differ when the agents are made to agree', async () => {
    seedClaudeMcp('gh', { command: 'gh-mcp', args: ['--stdio'] })
    const copilot = { command: 'gh-mcp', args: ['--legacy'], tools: ['issues'], cwd: '/srv' }
    write(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { gh: copilot } }))
    getPanel(null)
    await matchPanelEntry({ repoRoot: null, kind: 'mcp', name: 'gh' }, 'claude')
    const after = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(after.mcpServers.gh).toEqual({ ...copilot, args: ['--stdio'] })
  })

  it('puts a removed server back as each agent had it', async () => {
    const api = { type: 'http', url: 'https://mcp.example.dev/mcp', headers: { Authorization: 'Bearer tok-123' } }
    seedClaudeMcp('api', api)
    const codex = '[mcp_servers.api]\nurl = "https://mcp.example.dev/mcp"\nbearer_token_env_var = "API_TOKEN"\n'
    write(join(home, '.codex', 'config.toml'), codex)
    getPanel(null)
    const target = { repoRoot: null, kind: 'mcp' as const, name: 'api' }
    await removePanelEntry(target)
    expect(claudeJson().mcpServers.api).toBeUndefined()
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).not.toContain('api')
    await restorePanelEntry(target)
    expect(claudeJson().mcpServers.api).toEqual(api)
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(codex)
  })

  it('remembers each agent’s own definition in Cockpit’s copy', () => {
    const api = { type: 'http', url: 'https://mcp.example.dev/mcp', headers: { Authorization: 'Bearer tok-123' } }
    seedClaudeMcp('api', api)
    getPanel(null)
    const stored = JSON.parse(readFileSync(join(userData, 'cockpit-config.json'), 'utf8'))
    expect(stored.library.global.find((e: any) => e.name === 'api').raw).toEqual({ claude: api })
  })
})

describe('removing everywhere', () => {
  it('takes it out of every agent but keeps the entry', async () => {
    seedClaudeMcp('linear', { type: 'sse', url: 'https://mcp.linear.app/sse' })
    getPanel(null)
    await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'linear' }, 'copilot', true)
    const report = await removePanelEntry({ repoRoot: null, kind: 'mcp', name: 'linear' })
    expect(claudeJson().mcpServers.linear).toBeUndefined()
    const copilot = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(copilot.mcpServers.linear).toBeUndefined()
    // gone from the panel, but not gone: this is what the kept copy is for
    expect(report.rows.find((r) => r.name === 'linear')).toBeUndefined()
    expect(report.removed.map((r) => r.name)).toEqual(['linear'])
  })

  it('puts it back on the agents it was on', async () => {
    seedClaudeMcp('linear', { type: 'sse', url: 'https://mcp.linear.app/sse' })
    getPanel(null)
    await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'linear' }, 'copilot', true)
    await removePanelEntry({ repoRoot: null, kind: 'mcp', name: 'linear' })
    const report = await restorePanelEntry({ repoRoot: null, kind: 'mcp', name: 'linear' })
    expect(report.removed).toHaveLength(0)
    expect(cell(report, 'linear', 'claude').state).toBe('on')
    expect(cell(report, 'linear', 'copilot').state).toBe('on')
    expect(claudeJson().mcpServers.linear.url).toBe('https://mcp.linear.app/sse')
  })

  it('keeps its copy of a removed skill, so putting it back has something to write', async () => {
    seedSkill('.claude', 'review', 'review a diff')
    getPanel(null)
    await removePanelEntry({ repoRoot: null, kind: 'skill', name: 'review' })
    expect(existsSync(join(home, '.claude', 'skills', 'review'))).toBe(false)
    expect(existsSync(join(userData, 'library', 'global', 'skills', 'review'))).toBe(true)
    await restorePanelEntry({ repoRoot: null, kind: 'skill', name: 'review' })
    expect(readFileSync(join(home, '.claude', 'skills', 'review', 'SKILL.md'), 'utf8')).toContain(
      'review a diff'
    )
  })
})

describe('project scope', () => {
  it('reads a repo’s own Claude servers, and says the other two can’t have them', () => {
    const repo = join(home, 'dev', 'rocket')
    mkdirSync(repo, { recursive: true })
    write(
      join(home, '.claude.json'),
      JSON.stringify({ projects: { [repo]: { mcpServers: { local: { command: 'x' } } } } })
    )
    const report = getPanel(repo)
    expect(cell(report, 'local', 'claude').state).toBe('on')
    expect(cell(report, 'local', 'codex').state).toBe('na')
    expect(cell(report, 'local', 'codex').reason).toMatch(/Only Claude Code scopes/)
  })

  it('keeps a repo’s switches separate from the global ones', async () => {
    const repo = join(home, 'dev', 'rocket')
    mkdirSync(repo, { recursive: true })
    seedSkill('.claude', 'review', 'the global one')
    write(join(repo, '.claude', 'skills', 'review', 'SKILL.md'), '---\ndescription: the repo one\n---\n')
    getPanel(null)
    await setPanelSwitch({ repoRoot: repo, kind: 'skill', name: 'review' }, 'codex', true)
    // the repo copy went to .agents/skills; the global one is untouched
    expect(readFileSync(join(repo, '.agents', 'skills', 'review', 'SKILL.md'), 'utf8')).toContain(
      'the repo one'
    )
    expect(existsSync(join(home, '.codex', 'skills', 'review'))).toBe(false)
  })

  it('never offers plugins or marketplaces in a repo', () => {
    const repo = join(home, 'dev', 'rocket')
    mkdirSync(repo, { recursive: true })
    expect(getPanel(repo).globalOnly).toEqual(['plugin', 'marketplace'])
    expect(getPanel(repo).rows.some((r) => r.kind === 'plugin')).toBe(false)
  })
})

describe('the instructions row', () => {
  it('switches an agent’s file off by taking the shared block back out', async () => {
    saveBaseline(null, 'be careful')
    write(join(home, '.claude', 'CLAUDE.md'), 'my own notes\n\n<!-- cockpit:shared:start -->\nbe careful\n<!-- cockpit:shared:end -->\n')
    expect(cell(getPanel(null), 'Shared baseline', 'claude').state).toBe('on')
    await setPanelSwitch({ repoRoot: null, kind: 'instructions', name: 'Shared baseline' }, 'claude', false)
    const file = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')
    expect(file).not.toContain('be careful')
    // the agent's own content is never touched
    expect(file).toContain('my own notes')
  })
})

/*
 * Plugins are read here, never switched: reading a row only reads config files,
 * while flipping one would run the agent's own CLI.
 */
describe('a plugin an agent has no way to install', () => {
  function seedBundled(): void {
    write(
      join(home, '.codex', 'config.toml'),
      [
        '[marketplaces.openai-bundled]',
        'source_type = "local"',
        `source = "${join(home, '.codex', '.tmp', 'bundled', 'openai-bundled')}"`,
        '',
        '[marketplaces.tashtit]',
        'source = "https://github.com/tashtit/marketplace.git"',
        '',
        '[plugins."visualize@openai-bundled"]',
        'enabled = true',
        '',
        '[plugins."git-workflow@tashtit"]',
        'enabled = true',
        ''
      ].join('\n')
    )
  }

  it('says so on the chip instead of offering a switch that would fail', () => {
    seedBundled()
    const report = getPanel(null)
    expect(cell(report, 'visualize@openai-bundled', 'codex').state).toBe('on')
    for (const agent of ['claude', 'copilot'] as const) {
      const blocked = cell(report, 'visualize@openai-bundled', agent)
      expect(blocked.state).toBe('na')
      expect(blocked.reason).toContain('openai-bundled ships with Codex')
    }
  })

  it('leaves a marketplace with a real source switchable everywhere', () => {
    seedBundled()
    const report = getPanel(null)
    expect(cell(report, 'git-workflow@tashtit', 'claude').state).toBe('off')
    expect(cell(report, 'tashtit', 'claude').state).toBe('off')
    expect(cell(report, 'openai-bundled', 'claude').state).toBe('na')
  })
})

describe('pinning a server to a newer version', () => {
  const serve = (version: string): void => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version })
    }))
  }

  it('rewrites the pin in every agent that runs it', async () => {
    seedClaudeMcp('shots', { command: 'npx', args: ['-y', 'shots-mcp@0.0.78', '--headless'] })
    getPanel(null)
    await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'shots' }, 'copilot', true)
    serve('0.0.82')
    const report = await setMcpVersion({ repoRoot: null, kind: 'mcp', name: 'shots' }, '0.0.82')
    expect(claudeJson().mcpServers.shots.args).toEqual(['-y', 'shots-mcp@0.0.82', '--headless'])
    const copilot = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(copilot.mcpServers.shots.args).toEqual(['-y', 'shots-mcp@0.0.82', '--headless'])
    // the agents still agree, so the row is quiet
    expect(cell(report, 'shots', 'claude').state).toBe('on')
  })

  // “only the version moves” used to hold for the claude line alone: every other
  // agent was handed Cockpit's copy, losing whatever that copy doesn't carry
  it('moves only the version in each agent’s own definition', async () => {
    seedClaudeMcp('search', { command: 'npx', args: ['-y', 'search-mcp@1.2.0'], env: { API_KEY: 'sk-live-1' } })
    const codex = [
      '[mcp_servers.search]',
      'command = "npx"',
      'args = ["--yes", "search-mcp@1.2.0"]',
      'env = { "API_KEY" = "sk-live-1" }',
      'startup_timeout_sec = 30',
      'enabled_tools = ["query", "fetch"]',
      '',
      '[profiles.work]',
      'model = "o3"',
      ''
    ].join('\n')
    write(join(home, '.codex', 'config.toml'), codex)
    const copilot = {
      type: 'local',
      command: 'npx',
      args: ['-y', 'search-mcp@1.2.0'],
      env: { API_KEY: 'sk-live-1' },
      tools: ['query']
    }
    write(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { search: copilot } }))
    getPanel(null)
    serve('1.3.0')
    await setMcpVersion({ repoRoot: null, kind: 'mcp', name: 'search' }, '1.3.0')
    expect(claudeJson().mcpServers.search).toEqual({
      command: 'npx',
      args: ['-y', 'search-mcp@1.3.0'],
      env: { API_KEY: 'sk-live-1' }
    })
    // codex's own flag spelling, its inline env token, its timeout and tool filter
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      codex.replace('search-mcp@1.2.0', 'search-mcp@1.3.0')
    )
    // copilot's env, and its allowlist rather than every tool
    const after = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(after.mcpServers.search).toEqual({ ...copilot, args: ['-y', 'search-mcp@1.3.0'] })
  })

  it('leaves an agent that runs the package unpinned as it is, and says so', async () => {
    seedClaudeMcp('shots', { command: 'npx', args: ['-y', 'shots-mcp@0.0.78'] })
    const floating = { command: 'npx', args: ['-y', 'shots-mcp'], tools: ['*'] }
    write(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { shots: floating } }))
    getPanel(null)
    serve('0.0.82')
    await expect(
      setMcpVersion({ repoRoot: null, kind: 'mcp', name: 'shots' }, '0.0.82')
    ).rejects.toThrow(/not everywhere — copilot: runs npm · shots-mcp latest — left as it is/)
    expect(claudeJson().mcpServers.shots.args).toEqual(['-y', 'shots-mcp@0.0.82'])
    const after = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(after.mcpServers.shots).toEqual(floating)
  })

  it('refuses a version the registry didn’t offer', async () => {
    seedClaudeMcp('other', { command: 'npx', args: ['-y', 'other-mcp@1.0.0'] })
    getPanel(null)
    serve('1.1.0')
    await expect(
      setMcpVersion({ repoRoot: null, kind: 'mcp', name: 'other' }, '9.9.9')
    ).rejects.toThrow(/isn’t what npm offers/)
    expect(claudeJson().mcpServers.other.args).toEqual(['-y', 'other-mcp@1.0.0'])
  })

  it('refuses a server that pins nothing at all', async () => {
    seedClaudeMcp('remote', { type: 'http', url: 'https://example.dev/mcp' })
    getPanel(null)
    await expect(
      setMcpVersion({ repoRoot: null, kind: 'mcp', name: 'remote' }, '1.0.0')
    ).rejects.toThrow(/doesn’t pin a package version/)
  })
})
