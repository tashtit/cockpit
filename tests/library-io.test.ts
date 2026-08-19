import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixPanelDrift, forgetPanelEntry, getPanel, setPanelSwitch } from '../src/main/library'
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

describe('when an agent disagrees with its switch', () => {
  it('reports an agent that was changed behind Cockpit’s back', () => {
    seedClaudeMcp('gh', { command: 'gh-mcp', args: ['--stdio'] })
    getPanel(null)
    // someone edits ~/.claude.json by hand
    seedClaudeMcp('gh', { command: 'npx', args: ['-y', 'gh-mcp'] })
    expect(cell(getPanel(null), 'gh', 'claude').state).toBe('changed')
  })

  it('writes Cockpit’s version back over the agent’s', async () => {
    seedClaudeMcp('gh', { command: 'gh-mcp', args: ['--stdio'] })
    getPanel(null)
    seedClaudeMcp('gh', { command: 'npx', args: ['-y', 'gh-mcp'] })
    const report = await fixPanelDrift({ repoRoot: null, kind: 'mcp', name: 'gh' }, 'claude', 'apply')
    expect(claudeJson().mcpServers.gh.command).toBe('gh-mcp')
    expect(cell(report, 'gh', 'claude').state).toBe('on')
  })

  it('takes the agent’s version into Cockpit instead, when that’s the one you want', async () => {
    seedClaudeMcp('gh', { command: 'gh-mcp', args: ['--stdio'] })
    getPanel(null)
    seedClaudeMcp('gh', { command: 'npx', args: ['-y', 'gh-mcp'] })
    const report = await fixPanelDrift({ repoRoot: null, kind: 'mcp', name: 'gh' }, 'claude', 'adopt')
    expect(cell(report, 'gh', 'claude').state).toBe('on')
    // Cockpit's definition is now the agent's, so every other agent gets that one
    const row = report.rows.find((r) => r.name === 'gh')
    expect(row?.cockpit.fields.command).toBe('npx')
  })
})

describe('removing for good', () => {
  it('takes it out of every agent and stops tracking it', async () => {
    seedClaudeMcp('linear', { type: 'sse', url: 'https://mcp.linear.app/sse' })
    getPanel(null)
    await setPanelSwitch({ repoRoot: null, kind: 'mcp', name: 'linear' }, 'copilot', true)
    const report = await forgetPanelEntry({ repoRoot: null, kind: 'mcp', name: 'linear' })
    expect(report.rows.find((r) => r.name === 'linear')).toBeUndefined()
    expect(claudeJson().mcpServers.linear).toBeUndefined()
    const copilot = JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))
    expect(copilot.mcpServers.linear).toBeUndefined()
  })

  it('drops Cockpit’s own copy of a skill too, so it isn’t re-adopted', async () => {
    seedSkill('.claude', 'review', 'review a diff')
    getPanel(null)
    await forgetPanelEntry({ repoRoot: null, kind: 'skill', name: 'review' })
    expect(existsSync(join(home, '.claude', 'skills', 'review'))).toBe(false)
    expect(existsSync(join(userData, 'library', 'global', 'skills', 'review'))).toBe(false)
    expect(getPanel(null).rows).toHaveLength(0)
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
