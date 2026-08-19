import { describe, it, expect } from 'vitest'
import {
  adoptInventory,
  buildReport,
  buildRow,
  instructionRow,
  kindsForScope,
  mcpFields,
  sameFields,
  type Actual
} from '../src/shared/library'
import type { ExtensionsInventory, LibraryEntry, McpConfig, Provider } from '../src/shared/types'

const EMPTY: ExtensionsInventory = { mcp: [], skills: [], plugins: [], marketplaces: [] }

const has = (config: McpConfig): Actual => ({
  present: true,
  detail: '',
  fields: mcpFields(config)
})
const missing: Actual = { present: false, detail: '', fields: {} }

function mcpEntry(enabled: Partial<Record<Provider, boolean>>, config: McpConfig): LibraryEntry {
  return { kind: 'mcp', name: 'gh', enabled, config }
}

function row(
  enabled: Partial<Record<Provider, boolean>>,
  config: McpConfig,
  actual: Partial<Record<Provider, Actual>>
): ReturnType<typeof buildRow> {
  const entry = mcpEntry(enabled, config)
  return buildRow(entry, { detail: '', fields: mcpFields(config) }, actual)
}

const CFG: McpConfig = { command: 'gh-mcp', args: ['--stdio'] }

describe('the switch against what the agent has', () => {
  it('is quiet when the agent holds exactly what Cockpit holds', () => {
    const r = row({ claude: true }, CFG, { claude: has(CFG) })
    expect(r.cells.claude.state).toBe('on')
    expect(r.drift).toEqual([])
  })

  it('is quiet when a switch is off and the agent doesn’t have it', () => {
    const r = row({ claude: false }, CFG, { claude: missing })
    expect(r.cells.claude.state).toBe('off')
    expect(r.drift).toEqual([])
  })

  // the three ways reality can disagree with the switch
  it('reports a switch that is on but never applied', () => {
    expect(row({ codex: true }, CFG, { codex: missing }).cells.codex.state).toBe('pending')
  })

  // one agent has nobody to disagree with, and Cockpit is not a second opinion
  it('leaves a lone agent alone whatever it runs', () => {
    const r = row({ codex: true }, CFG, { codex: has({ command: 'npx', args: ['-y', 'gh-mcp'] }) })
    expect(r.cells.codex.state).toBe('on')
    expect(r.drift).toEqual([])
  })

  it('flags the odd one out when two agents agree and a third doesn’t', () => {
    const r = row({ claude: true, codex: true, copilot: true }, CFG, {
      claude: has(CFG),
      codex: has(CFG),
      copilot: has({ command: 'npx', args: ['-y', 'gh-mcp'] })
    })
    expect(r.cells.claude.state).toBe('on')
    expect(r.cells.copilot.state).toBe('changed')
    expect(r.disagree).toBe(true)
  })

  // two agents, two answers, no majority — Cockpit has no version to break the tie,
  // so it flags both and asks rather than picking a winner
  it('flags both when two agents disagree and neither is the majority', () => {
    const r = row({ claude: true, copilot: true }, CFG, {
      claude: has(CFG),
      copilot: has({ command: 'npx' })
    })
    expect(r.cells.claude.state).toBe('changed')
    expect(r.cells.copilot.state).toBe('changed')
  })

  it('reports something added behind Cockpit’s back', () => {
    expect(row({}, CFG, { copilot: has(CFG) }).cells.copilot.state).toBe('extra')
  })

  it('marks an agent that can’t hold it at all, and never calls that drift', () => {
    const r = row({ codex: true }, CFG, {
      codex: { ...missing, reason: 'Codex reads MCP servers globally only' }
    })
    expect(r.cells.codex.state).toBe('na')
    expect(r.drift).toEqual([])
  })

  it('compares env var names but never their values', () => {
    const r = row({ claude: true }, { command: 'x', env: { TOKEN: 'a' } }, {
      claude: has({ command: 'x', env: { TOKEN: 'b' } })
    })
    expect(r.cells.claude.state).toBe('on')
    expect(JSON.stringify(r)).not.toContain('"a"')
  })

  it('notices when one agent dropped the env vars the others have', () => {
    const withEnv = { command: 'x', env: { TOKEN: 'a' } }
    const r = row({ claude: true, codex: true, copilot: true }, withEnv, {
      claude: has(withEnv),
      codex: has(withEnv),
      copilot: has({ command: 'x' })
    })
    expect(r.cells.copilot.state).toBe('changed')
  })
})

describe('sameFields', () => {
  // a version or source an agent simply doesn't record is unknown, not different —
  // otherwise the lamp would come on for something the user can never clear
  it('ignores a field only one side records', () => {
    expect(sameFields({ marketplace: 'tashtit' }, { marketplace: 'tashtit', version: '1' })).toBe(true)
    expect(sameFields({ marketplace: 'tashtit', version: '1' }, { marketplace: 'tashtit' })).toBe(true)
  })

  it('still catches a field both sides record differently', () => {
    expect(sameFields({ version: '1' }, { version: '2' })).toBe(false)
  })
})

describe('adoptInventory', () => {
  it('switches on whatever an agent already has, so a first run agrees with reality', () => {
    const entries = adoptInventory([], {
      ...EMPTY,
      mcp: [
        {
          name: 'gh',
          config: CFG,
          agents: ['claude', 'codex'],
          presences: [
            { agent: 'claude', scope: 'user', config: CFG },
            { agent: 'codex', scope: 'user', config: CFG }
          ]
        }
      ]
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].enabled).toEqual({ claude: true, codex: true })
    expect(entries[0].config).toEqual(CFG)
  })

  it('never overwrites a switch the user set', () => {
    const existing: LibraryEntry[] = [{ kind: 'skill', name: 'review', enabled: { claude: false } }]
    const entries = adoptInventory(existing, {
      ...EMPTY,
      skills: [{ name: 'review', description: '', agent: 'claude', path: '/p', fingerprint: 'a' }]
    })
    // the user switched it off; adoption must not switch it back on behind them
    expect(entries[0].enabled.claude).toBe(false)
  })

  it('keys plugins by the id every agent uses', () => {
    const entries = adoptInventory([], {
      ...EMPTY,
      plugins: [
        { name: 'git-workflow@tashtit', agent: 'claude', marketplace: 'tashtit' },
        { name: 'git-workflow@tashtit', agent: 'codex', marketplace: 'tashtit' }
      ]
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].enabled).toEqual({ claude: true, codex: true })
  })
})

describe('scope', () => {
  it('offers everything globally, and only what a repo can carry in a project', () => {
    expect(kindsForScope(null)).toContain('plugin')
    expect(kindsForScope('/repo')).not.toContain('plugin')
    expect(kindsForScope('/repo')).not.toContain('marketplace')
    expect(kindsForScope('/repo')).toEqual(['instructions', 'mcp', 'skill'])
  })

  it('names the global-only kinds in a project report', () => {
    expect(buildReport('/repo', []).globalOnly).toEqual(['plugin', 'marketplace'])
    expect(buildReport(null, []).globalOnly).toEqual([])
  })
})

describe('buildReport', () => {
  it('counts switches that are on and disagreements that need attention', () => {
    const rows = [
      row({ claude: true, codex: true }, CFG, { claude: has(CFG), codex: has(CFG) }),
      { ...row({ copilot: true }, CFG, { copilot: missing }), id: 'mcp:other', name: 'other' }
    ]
    const report = buildReport(null, rows)
    expect(report.on).toBe(2)
    expect(report.drift).toBe(1)
  })

  it('groups by kind and sorts each group by name', () => {
    const mk = (kind: LibraryEntry['kind'], name: string): ReturnType<typeof buildRow> =>
      buildRow({ kind, name, enabled: {} }, { detail: '', fields: {} }, {})
    const names = buildReport(null, [
      mk('skill', 'zed'),
      mk('mcp', 'beta'),
      mk('skill', 'alpha'),
      mk('mcp', 'alpha')
    ]).rows.map((r) => `${r.kind}:${r.name}`)
    expect(names).toEqual(['mcp:alpha', 'mcp:beta', 'skill:alpha', 'skill:zed'])
  })
})

describe('the instructions row', () => {
  const entry: LibraryEntry = {
    kind: 'instructions',
    name: 'Shared baseline',
    enabled: { claude: true, codex: true, copilot: true }
  }

  it('reads each agent’s file status as that agent’s state', () => {
    const r = instructionRow(
      {
        repoRoot: null,
        baseline: 'be careful',
        files: [
          { agents: ['claude'], path: '/h/.claude/CLAUDE.md', exists: true, content: '', status: 'synced' },
          { agents: ['codex'], path: '/h/.codex/AGENTS.md', exists: true, content: '', status: 'drifted' },
          { agents: ['copilot'], path: '/h/.copilot/i.md', exists: false, content: '', status: 'missing' }
        ]
      },
      entry
    )
    expect(r.cells.claude.state).toBe('on')
    expect(r.cells.codex.state).toBe('changed')
    expect(r.cells.copilot.state).toBe('pending')
  })

  // one repo AGENTS.md is read by codex *and* copilot — it fills both cells
  it('counts a shared file for every agent that reads it', () => {
    const r = instructionRow(
      {
        repoRoot: '/repo',
        baseline: 'x',
        files: [
          { agents: ['claude'], path: '/repo/CLAUDE.md', exists: true, content: '', status: 'synced' },
          { agents: ['codex', 'copilot'], path: '/repo/AGENTS.md', exists: true, content: '', status: 'synced' }
        ]
      },
      entry
    )
    expect(r.drift).toEqual([])
  })
})
