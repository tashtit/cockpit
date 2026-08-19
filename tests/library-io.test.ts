import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getPanel,
  matchPanelEntry,
  removePanelEntry,
  restorePanelEntry,
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

  it('takes its own copy of an adopted skill, so it isn’t reported as different', () => {
    seedSkill('.claude', 'review', 'review a diff')
    const report = getPanel(null)
    expect(cell(report, 'review', 'claude').state).toBe('on')
    // Cockpit's own store is per scope, so a repo's `review` can't overwrite the global one
    expect(existsSync(join(userData, 'library', 'global', 'skills', 'review', 'SKILL.md'))).toBe(true)
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
    expect(cell(report, 'local', 'codex').reason).toMatch(/globally only/)
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
