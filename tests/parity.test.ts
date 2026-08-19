import { describe, it, expect } from 'vitest'
import { buildParity, syncTargets } from '../src/shared/parity'
import type { ExtensionsInventory, InstructionsState, McpConfig } from '../src/shared/types'

const EMPTY: ExtensionsInventory = { mcp: [], skills: [], plugins: [], marketplaces: [] }

function mcpServer(
  name: string,
  byAgent: Partial<Record<'claude' | 'codex' | 'copilot', McpConfig>>
): ExtensionsInventory['mcp'][number] {
  const presences = Object.entries(byAgent).map(([agent, config]) => ({
    agent: agent as 'claude' | 'codex' | 'copilot',
    scope: 'user' as const,
    config
  }))
  return {
    name,
    config: presences[0].config,
    agents: presences.map((p) => p.agent),
    presences
  }
}

const row = (inv: ExtensionsInventory, name: string): ReturnType<typeof buildParity>['rows'][number] => {
  const found = buildParity(inv).rows.find((r) => r.name === name)
  if (!found) throw new Error(`no row for ${name}`)
  return found
}

describe('buildParity — MCP servers', () => {
  it('marks the agents that are missing a server', () => {
    const inv = { ...EMPTY, mcp: [mcpServer('linear', { claude: { url: 'https://linear/sse' } })] }
    const r = row(inv, 'linear')
    expect(r.cells.claude.state).toBe('present')
    expect(r.cells.codex.state).toBe('missing')
    expect(r.cells.copilot.state).toBe('missing')
    expect(r.incomplete).toBe(true)
    expect(r.diverged).toBe(false)
    expect(syncTargets(r)).toEqual(['codex', 'copilot'])
  })

  // the merged inventory used to hide this entirely — it kept one config per name
  it('flags two agents that configure the same name differently', () => {
    const inv = {
      ...EMPTY,
      mcp: [
        mcpServer('gh', {
          claude: { command: 'gh-mcp', args: ['--stdio'] },
          codex: { command: 'gh-mcp', args: ['--stdio'] },
          copilot: { command: 'npx', args: ['-y', 'gh-mcp'] }
        })
      ]
    }
    const r = row(inv, 'gh')
    // two agents agree, so they are the reference and the odd one out is the diff
    expect(r.reference).toBe('claude')
    expect(r.cells.codex.state).toBe('present')
    expect(r.cells.copilot.state).toBe('differs')
    expect(r.diverged).toBe(true)
    expect(r.incomplete).toBe(false)
    expect(r.fields).toContain('args')
  })

  it('compares env var names but never their values', () => {
    const inv = {
      ...EMPTY,
      mcp: [
        mcpServer('an', {
          claude: { command: 'x', env: { TOKEN: 'secret-a' } },
          codex: { command: 'x', env: { TOKEN: 'secret-b' } }
        })
      ]
    }
    const r = row(inv, 'an')
    expect(r.diverged).toBe(false)
    expect(r.cells.claude.fields.env).toBe('TOKEN')
    expect(JSON.stringify(r)).not.toContain('secret-')
  })

  it('lets a project-scoped entry stand in for an agent with no global one', () => {
    const cfg = { url: 'https://x' }
    const inv = {
      ...EMPTY,
      mcp: [
        {
          name: 'proj',
          config: cfg,
          agents: ['claude' as const],
          presences: [{ agent: 'claude' as const, scope: 'project' as const, projectPath: '/r', config: cfg }]
        }
      ]
    }
    expect(row(inv, 'proj').cells.claude.state).toBe('present')
  })
})

describe('buildParity — skills, plugins, marketplaces', () => {
  it('uses the SKILL.md fingerprint to tell a copy from a drifted copy', () => {
    const inv = {
      ...EMPTY,
      skills: [
        { name: 'review', description: 'a', agent: 'claude' as const, path: '/c/review', fingerprint: 'aaa' },
        { name: 'review', description: 'a', agent: 'codex' as const, path: '/x/review', fingerprint: 'aaa' },
        { name: 'review', description: 'b', agent: 'copilot' as const, path: '/p/review', fingerprint: 'bbb' }
      ]
    }
    const r = row(inv, 'review')
    expect(r.cells.codex.state).toBe('present')
    expect(r.cells.copilot.state).toBe('differs')
  })

  // codex records no plugin version; comparing against a version it never had would
  // report every codex plugin as different from the others
  it('does not call a plugin divergent when an agent records no version', () => {
    const inv = {
      ...EMPTY,
      plugins: [
        { name: 'git-workflow@tashtit', agent: 'claude' as const, version: '0.1.0', marketplace: 'tashtit' },
        { name: 'git-workflow@tashtit', agent: 'codex' as const, marketplace: 'tashtit' }
      ]
    }
    const r = row(inv, 'git-workflow@tashtit')
    expect(r.diverged).toBe(false)
    expect(r.cells.codex.state).toBe('present')
    expect(r.cells.copilot.state).toBe('missing')
  })

  it('reports a real version difference between two agents', () => {
    const inv = {
      ...EMPTY,
      plugins: [
        { name: 'p@m', agent: 'claude' as const, version: '1.0.0' },
        { name: 'p@m', agent: 'copilot' as const, version: '0.9.0' }
      ]
    }
    expect(row(inv, 'p@m').diverged).toBe(true)
  })

  it('ignores a local marketplace path when comparing sources', () => {
    const inv = {
      ...EMPTY,
      marketplaces: [
        { name: 'mine', agent: 'claude' as const, source: '/Users/x/.claude/plugins/marketplaces/mine' },
        { name: 'mine', agent: 'codex' as const, source: '/Users/x/.codex/mine' }
      ]
    }
    expect(row(inv, 'mine').diverged).toBe(false)
  })
})

describe('buildParity — instructions', () => {
  const state = (files: InstructionsState['files']): InstructionsState => ({
    repoRoot: null,
    baseline: 'be careful',
    files
  })

  it('lines the three agent files up as one row', () => {
    const rows = buildParity(
      EMPTY,
      state([
        { agents: ['claude'], path: '/h/.claude/CLAUDE.md', exists: true, content: '', status: 'synced' },
        { agents: ['codex'], path: '/h/.codex/AGENTS.md', exists: true, content: '', status: 'drifted' },
        { agents: ['copilot'], path: '/h/.copilot/i.md', exists: false, content: '', status: 'missing' }
      ])
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].cells.claude.state).toBe('present')
    expect(rows[0].cells.codex.state).toBe('differs')
    expect(rows[0].cells.copilot.state).toBe('missing')
  })

  it('says nothing at all until a baseline exists', () => {
    const rows = buildParity(EMPTY, { repoRoot: null, baseline: '   ', files: [] }).rows
    expect(rows).toHaveLength(0)
  })

  // one repo-scope AGENTS.md is read by codex *and* copilot — it fills both cells
  it('counts a shared file for every agent that reads it', () => {
    const rows = buildParity(EMPTY, {
      repoRoot: '/repo',
      baseline: 'x',
      files: [
        { agents: ['claude'], path: '/repo/CLAUDE.md', exists: true, content: '', status: 'synced' },
        { agents: ['codex', 'copilot'], path: '/repo/AGENTS.md', exists: true, content: '', status: 'synced' }
      ]
    }).rows
    expect(rows[0].incomplete).toBe(false)
    expect(rows[0].diverged).toBe(false)
    expect(rows[0].name).toContain('repo')
  })
})

describe('buildParity — report', () => {
  it('counts aligned, diverged and incomplete rows', () => {
    const inv: ExtensionsInventory = {
      ...EMPTY,
      mcp: [
        mcpServer('everywhere', {
          claude: { url: 'https://a' },
          codex: { url: 'https://a' },
          copilot: { url: 'https://a' }
        }),
        mcpServer('lonely', { claude: { url: 'https://b' } }),
        mcpServer('split', { claude: { url: 'https://c' }, codex: { url: 'https://d' } })
      ]
    }
    const report = buildParity(inv)
    expect(report.total).toBe(3)
    expect(report.aligned).toBe(1)
    expect(report.diverged).toBe(1)
    // 'lonely' has two gaps and 'split' has one
    expect(report.incomplete).toBe(2)
  })

  it('groups rows by kind and sorts each group by name', () => {
    const inv: ExtensionsInventory = {
      ...EMPTY,
      mcp: [mcpServer('zed', { claude: {} }), mcpServer('alpha', { claude: {} })],
      skills: [{ name: 'sk', description: '', agent: 'claude', path: '/s', fingerprint: 'a' }]
    }
    expect(buildParity(inv).rows.map((r) => r.name)).toEqual(['alpha', 'zed', 'sk'])
  })
})
