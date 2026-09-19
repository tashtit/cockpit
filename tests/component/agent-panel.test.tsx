import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiSetup } from '../../src/renderer/src/AiSetup'
import {
  buildReport,
  buildRow,
  fieldsKey,
  instructionRow,
  mcpFields,
  type PanelReport
} from '../../src/shared/library'
import type {
  InstructionsState,
  LibraryEntry,
  McpConfig,
  McpVersion,
  Provider,
  RepoGroup
} from '../../src/shared/types'

const COCKPIT_GH: McpConfig = { command: 'gh-mcp', args: ['--stdio'] }
const OTHER_GH: McpConfig = { command: 'npx', args: ['-y', 'gh-mcp'] }

const present = (config: McpConfig) => ({ present: true, detail: '', fields: mcpFields(config) })
const absent = { present: false, detail: '', fields: {} }

function mcpRow(
  name: string,
  enabled: Partial<Record<Provider, boolean>>,
  actual: Partial<Record<Provider, ReturnType<typeof present>>>,
  config: McpConfig = COCKPIT_GH
): ReturnType<typeof buildRow> {
  const entry: LibraryEntry = { kind: 'mcp', name, enabled, config }
  return buildRow(entry, { detail: 'gh-mcp --stdio', fields: mcpFields(config) }, actual)
}

const report: PanelReport = buildReport(null, [
  // claude and codex match Cockpit; copilot is running something else
  mcpRow(
    'github',
    { claude: true, codex: true, copilot: true },
    { claude: present(COCKPIT_GH), codex: present(COCKPIT_GH), copilot: present(OTHER_GH) }
  ),
  // switched off everywhere but claude — Cockpit still keeps it
  mcpRow('linear', { claude: true }, { claude: present(COCKPIT_GH), codex: absent, copilot: absent }),
  buildRow(
    { kind: 'plugin', name: 'evalkit@tashtit', enabled: { claude: true }, source: 'tashtit' },
    { detail: 'from tashtit', fields: { marketplace: 'tashtit' } },
    { claude: { present: true, detail: 'v0.1.0', fields: { marketplace: 'tashtit' } } }
  )
])

const repo: RepoGroup = {
  key: 'acme/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/dev/rocket',
  sessionCount: 1,
  archivedCount: 0,
  lastActivity: 0,
  providers: ['claude'],
  hidden: false
}

async function openPanel(): Promise<void> {
  vi.mocked(window.cockpit.getPanel).mockResolvedValue(report)
  vi.mocked(window.cockpit.setPanelSwitch).mockResolvedValue(report)
  vi.mocked(window.cockpit.matchPanelEntry).mockResolvedValue(report)
  vi.mocked(window.cockpit.removePanelEntry).mockResolvedValue(report)
  vi.mocked(window.cockpit.restorePanelEntry).mockResolvedValue(report)
  render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
  await screen.findByText('github')
}

const sw = (name: string, agent: string): HTMLElement =>
  screen.getByRole('switch', { name: `${name} in ${agent}` })

/** The panel opens on what needs attention, so most rows live one click away. */
const section = async (label: string): Promise<void> => {
  await userEvent.click(screen.getByRole('tab', { name: new RegExp(`^${label}`) }))
}

const search = async (text: string): Promise<void> => {
  await userEvent.type(screen.getByRole('searchbox', { name: 'Search this scope' }), text)
}

/** The card is three bands deep now — no tab bar between the scope and the panel. */
const noTabBar = (): void => {
  expect(screen.queryByRole('tablist', { name: 'Agents sections' })).not.toBeInTheDocument()
}

describe('Agents › Panel', () => {
  it('shows each agent’s switch set to what Cockpit asked for', async () => {
    await openPanel()
    expect(sw('github', 'Claude')).toHaveAttribute('aria-checked', 'true')
    await section('MCP servers')
    expect(sw('linear', 'Codex')).toHaveAttribute('aria-checked', 'false')
  })

  it('lights a lamp on the agent that disagrees with its switch', async () => {
    await openPanel()
    // claude and codex agree with Cockpit; only copilot's lamp is lit
    expect(screen.getAllByText('differs')).toHaveLength(1)
    expect(sw('github', 'Copilot')).toHaveClass('drift')
  })

  it('switches an agent on with one click', async () => {
    await openPanel()
    await section('MCP servers')
    await userEvent.click(sw('linear', 'Codex'))
    expect(window.cockpit.setPanelSwitch).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'mcp', name: 'linear' },
      'codex',
      true
    )
  })

  it('switches an agent off with one click, keeping the entry', async () => {
    await openPanel()
    await section('MCP servers')
    await userEvent.click(sw('linear', 'Claude'))
    expect(window.cockpit.setPanelSwitch).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'mcp', name: 'linear' },
      'claude',
      false
    )
  })

  // turning a plugin off uninstalls it, which is not something one stray click should do
  it('asks before switching a plugin off', async () => {
    await openPanel()
    await section('Plugins')
    await userEvent.click(sw('evalkit@tashtit', 'Claude'))
    expect(window.cockpit.setPanelSwitch).not.toHaveBeenCalled()
    // the armed state reads as a placard in the row's flag slot, like every other warning
    expect(screen.getByText('click again to remove')).toBeInTheDocument()
    await userEvent.click(sw('evalkit@tashtit', 'Claude'))
    expect(window.cockpit.setPanelSwitch).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'plugin', name: 'evalkit@tashtit' },
      'claude',
      false
    )
  })

  it('opens a row onto what each agent actually runs', async () => {
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: /github/ }))
    const diff = screen.getByRole('table', { name: 'github — what each agent runs' })
    // Cockpit leads the table — it is the source of truth, not one opinion among four
    // the agents are compared with each other; Cockpit isn't a column, because it
    // holds a backup rather than a version anyone should be judged against
    const headers = within(diff).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['field', 'Claude', 'Codex', 'Copilot'])
    expect(within(diff).getByRole('rowheader', { name: 'command' }).closest('tr')).toHaveClass(
      'differs'
    )
  })

  // Cockpit has no version of its own, so it can't pick a winner — the user does
  it('asks which agent is right when they disagree', async () => {
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: /github/ }))
    expect(screen.getByText(/don’t run the same github/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Use Claude’s' }))
    expect(window.cockpit.matchPanelEntry).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'mcp', name: 'github' },
      'claude'
    )
  })

  it('needs a second click to remove something everywhere', async () => {
    await openPanel()
    await section('MCP servers')
    await userEvent.click(screen.getByRole('button', { name: /linear/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove linear everywhere' }))
    expect(window.cockpit.removePanelEntry).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm removing linear everywhere' }))
    expect(window.cockpit.removePanelEntry).toHaveBeenCalledWith({
      repoRoot: null,
      kind: 'mcp',
      name: 'linear'
    })
  })

  // removing everywhere is the one action that would otherwise be unrecoverable —
  // keeping a copy is the entire reason Cockpit has a config of its own
  it('keeps a removed entry so it can be put back', async () => {
    const gone = mcpRow('linear', {}, {})
    vi.mocked(window.cockpit.getPanel).mockResolvedValue({
      ...buildReport(null, []),
      removed: [{ ...gone, removed: true }]
    })
    vi.mocked(window.cockpit.restorePanelEntry).mockResolvedValue(buildReport(null, []))
    render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: /^Removed/ }))
    expect(screen.getByText('linear')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Put it back' }))
    expect(window.cockpit.restorePanelEntry).toHaveBeenCalledWith({
      repoRoot: null,
      kind: 'mcp',
      name: 'linear'
    })
  })

  it('reports a failed write instead of showing the switch as moved', async () => {
    await openPanel()
    await section('MCP servers')
    vi.mocked(window.cockpit.setPanelSwitch).mockRejectedValueOnce(new Error('codex config is read-only'))
    await userEvent.click(sw('linear', 'Codex'))
    expect(await screen.findByRole('alert')).toHaveTextContent('codex config is read-only')
  })
})

describe('Agents › whether a server answers', () => {
  // it is a fact about one server, so it lives on that server's row rather than in
  // a tab of its own that lists every server again
  it('checks the server from its own row', async () => {
    await openPanel()
    await section('MCP servers')
    await userEvent.click(screen.getByRole('button', { name: /linear/ }))
    vi.mocked(window.cockpit.checkMcp).mockResolvedValue({ status: 'ok' })
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(window.cockpit.checkMcp).toHaveBeenCalledWith('linear')
    expect(await screen.findByText('answers')).toBeInTheDocument()
  })

  it('offers the CLI login only for agents that have one', async () => {
    await openPanel()
    await section('MCP servers')
    await userEvent.click(screen.getByRole('button', { name: /github/ }))
    vi.mocked(window.cockpit.checkMcp).mockResolvedValue({ status: 'needs-auth', detail: 'HTTP 401' })
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByRole('button', { name: 'Log in · Claude' })).toBeInTheDocument()
    // copilot has no `mcp login`, so it is never offered one
    expect(screen.queryByRole('button', { name: 'Log in · Copilot' })).not.toBeInTheDocument()
  })

  it('logs in against the scope the panel is showing', async () => {
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(report)
    render(<AiSetup repos={[repo]} repoRoot="/dev/rocket" onScope={vi.fn()} onClose={vi.fn()} />)
    await screen.findByText('github')
    await section('MCP servers')
    await userEvent.click(screen.getByRole('button', { name: /github/ }))
    vi.mocked(window.cockpit.checkMcp).mockResolvedValue({ status: 'needs-auth' })
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Log in · Claude' }))
    expect(window.cockpit.loginMcp).toHaveBeenCalledWith('github', 'claude', '/dev/rocket')
  })
})

describe('Agents › is there a newer one', () => {
  const pinned = { command: 'npx', args: ['-y', 'shots-mcp@0.0.78'] }
  const bump: McpVersion = {
    name: 'shots',
    registry: 'npm',
    pkg: 'shots-mcp',
    current: '0.0.78',
    latest: '0.0.82',
    status: 'update'
  }

  async function openPinned(version: McpVersion = bump): Promise<void> {
    const pinnedReport = buildReport(null, [
      mcpRow('shots', { claude: true }, { claude: present(pinned) }, pinned)
    ])
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(pinnedReport)
    vi.mocked(window.cockpit.setMcpVersion).mockResolvedValue(pinnedReport)
    vi.mocked(window.cockpit.mcpVersions).mockResolvedValue([version])
    render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('tab', { name: /^MCP servers/ })
    await section('MCP servers')
  }

  it('marks the row, and bumps every agent that runs it from the row itself', async () => {
    await openPinned()
    expect(await screen.findByText('update 0.0.82')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /shots/ }))
    expect(screen.getByText(/shots-mcp is pinned to 0.0.78; npm has 0.0.82/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Update to 0.0.82' }))
    expect(window.cockpit.setMcpVersion).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'mcp', name: 'shots' },
      '0.0.82'
    )
  })

  it('says a pin is current without asking to be acted on', async () => {
    await openPinned({ ...bump, latest: '0.0.78', status: 'current' })
    expect(screen.queryByText(/^update /)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /shots/ }))
    expect(screen.getByText('up to date')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Update to/ })).not.toBeInTheDocument()
  })

  // offline, the row still says what it is pinned to — the version line says why
  it('names the registry that didn’t answer', async () => {
    await openPinned({ ...bump, latest: undefined, status: 'unknown', detail: 'timed out' })
    await userEvent.click(screen.getByRole('button', { name: /shots/ }))
    expect(screen.getByText(/Couldn’t ask npm about shots-mcp — timed out/)).toBeInTheDocument()
  })
})

describe('Agents › what an agent can’t be given', () => {
  it('explains an unswitchable agent in the row, not only in a tooltip', async () => {
    const reason = 'openai-bundled ships with Codex — there’s no source another agent could add it from.'
    const blocked = buildReport(null, [
      buildRow(
        { kind: 'plugin', name: 'visualize@openai-bundled', enabled: { codex: true }, source: 'openai-bundled' },
        { detail: 'from openai-bundled', fields: {} },
        {
          codex: { present: true, detail: 'v1.0.0', fields: {} },
          claude: { present: false, detail: '', fields: {}, reason },
          copilot: { present: false, detail: '', fields: {}, reason }
        }
      )
    ])
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(blocked)
    render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    await screen.findByRole('tab', { name: /^Plugins/ })
    await section('Plugins')
    // no switch at all for an agent that could never install it
    expect(
      screen.queryByRole('switch', { name: 'visualize@openai-bundled in Claude' })
    ).not.toBeInTheDocument()
    await userEvent.click(await screen.findByRole('button', { name: /visualize/ }))
    // the reason is in the row, not only in the chip's title: a tooltip is unreadable
    // to a keyboard, and the chip's own text can't hold a sentence
    const note = screen.getByText((_t, el) => el?.className === 'pnl-note')
    // one sentence, not one per blocked agent: the chip under it names the agent
    expect(note.textContent).toBe(reason)
    expect(screen.getByText('Codex only')).toBeInTheDocument()
  })
})

describe('Agents › a difference kept on purpose', () => {
  it('offers "keep as they are" beside the agents to copy from', async () => {
    await openPanel()
    vi.mocked(window.cockpit.keepPanelDifference).mockResolvedValue(report)
    await userEvent.click(screen.getByRole('button', { name: /github/ }))
    expect(screen.getByText(/Which one is right\?/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Keep as they are' }))
    expect(window.cockpit.keepPanelDifference).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'mcp', name: 'github' },
      true
    )
    expect(await screen.findByText(/Copilot runs its own github on purpose/)).toBeInTheDocument()
  })

  it('shows a kept row as settled, with the way back to drift', async () => {
    const entry: LibraryEntry = {
      kind: 'mcp',
      name: 'github',
      enabled: { claude: true, codex: true, copilot: true },
      config: COCKPIT_GH,
      kept: { copilot: fieldsKey(mcpFields(OTHER_GH)) }
    }
    const kept = buildReport(null, [
      buildRow(
        entry,
        { detail: 'gh-mcp --stdio', fields: mcpFields(COCKPIT_GH) },
        { claude: present(COCKPIT_GH), codex: present(COCKPIT_GH), copilot: present(OTHER_GH) }
      )
    ])
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(kept)
    vi.mocked(window.cockpit.keepPanelDifference).mockResolvedValue(kept)
    render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    // nothing needs attention any more: no Needs you, no flag, no amber ring
    expect(await screen.findByRole('tab', { name: /^MCP servers/ })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /^Needs you/ })).not.toBeInTheDocument()
    await section('MCP servers')
    expect(screen.queryByText('differs')).not.toBeInTheDocument()
    expect(sw('github', 'Copilot')).not.toHaveClass('drift')
    await userEvent.click(screen.getByRole('button', { name: /github/ }))
    expect(screen.getByText('Copilot runs its own github on purpose.')).toBeInTheDocument()
    expect(screen.queryByText(/Which one is right\?/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Treat as drift again' }))
    expect(window.cockpit.keepPanelDifference).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'mcp', name: 'github' },
      false
    )
  })
})

describe('Agents › finding things', () => {
  // the whole setup in one scroll was a wall — the panel shows one section at a time
  it('opens on what needs attention, not on everything', async () => {
    await openPanel()
    expect(screen.getByRole('tab', { name: /^Needs you/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('github')).toBeInTheDocument()
    // the rows that are fine are one click away, not in your face
    expect(screen.queryByText('linear')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^MCP servers/ })).toHaveTextContent('2')
  })

  it('opens on the first section when nothing needs attention', async () => {
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(
      buildReport(null, [mcpRow('quiet', { claude: true }, { claude: present(COCKPIT_GH) })])
    )
    render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    // instructions always has a section — writing a baseline is the point of it
    expect(await screen.findByRole('tab', { name: /^Instructions/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.queryByRole('tab', { name: /^Needs you/ })).not.toBeInTheDocument()
    await section('MCP servers')
    expect(screen.getByText('quiet')).toBeInTheDocument()
  })

  it('searches across every section, not just the one showing', async () => {
    await openPanel()
    await search('evalkit')
    // the plugin lives in a section the panel wasn't showing
    expect(screen.getByText('evalkit@tashtit')).toBeInTheDocument()
    expect(screen.queryByText('github')).not.toBeInTheDocument()
    expect(screen.getByText(/1 match for/)).toBeInTheDocument()
  })

  it('says what the chips do, once per section — a first visit has no legend otherwise', async () => {
    await openPanel()
    await section('MCP servers')
    expect(screen.getByText(/Click an agent to switch it on or off there\./)).toBeInTheDocument()
  })

  it('walks the section pills with the arrow keys', async () => {
    await openPanel()
    screen.getByRole('tab', { name: /^Needs you/ }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /^Instructions/ })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: /^Needs you/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('leaves a zero count off a pill — "Instructions 0" reads like a fault', async () => {
    await openPanel()
    expect(screen.getByRole('tab', { name: /^Instructions/ })).toHaveTextContent(/^Instructions$/)
    expect(screen.getByRole('tab', { name: /^MCP servers/ })).toHaveTextContent(/^MCP servers2$/)
  })

  it('tells a screen reader why a chip has no switch, not only a hover', async () => {
    // a kind an agent has no switch for arrives with a reason instead of a config
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(
      buildReport(null, [
        buildRow(
          { kind: 'plugin', name: 'evalkit@tashtit', enabled: { claude: true }, source: 'tashtit' },
          { detail: 'from tashtit', fields: { marketplace: 'tashtit' } },
          {
            claude: { present: true, detail: 'v0.1.0', fields: { marketplace: 'tashtit' } },
            copilot: { present: false, detail: '', fields: {}, reason: 'Copilot has no plugin system' }
          }
        )
      ])
    )
    render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    // nothing drifts, so the panel lands on Instructions — the plugin is one click away
    await screen.findByRole('tab', { name: /^Plugins/ })
    await section('Plugins')
    await screen.findByText('evalkit@tashtit')
    const na = document.querySelector('.ag-chip.na')
    expect(na).not.toBeNull()
    expect(na?.textContent).toMatch(/Copilot: not available — Copilot has no plugin system/)
    expect(na).toHaveAttribute('title', 'Copilot has no plugin system')
  })

  it('labels which section a search result came from', async () => {
    await openPanel()
    await search('evalkit')
    // the section pill also says "Plugins" — this is the tag on the row itself
    expect(document.querySelector('.pnl-kind')).toHaveTextContent('Plugins')
  })

  it('says so when a search finds nothing', async () => {
    await openPanel()
    await search('nothing-by-this-name')
    expect(screen.getByText(/nothing here matches/)).toBeInTheDocument()
  })
})

describe('Agents › scope', () => {
  it('opens on Global and says what that means, with nothing stacked in between', async () => {
    await openPanel()
    expect(screen.getByText(/every session, in every repo/)).toBeInTheDocument()
    noTabBar()
  })

  it('reads a project scope, and says which kinds a repo can’t carry', async () => {
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(buildReport('/dev/rocket', []))
    render(<AiSetup repos={[repo]} repoRoot="/dev/rocket" onScope={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText(/Plugins and Marketplaces are installed per machine/)).toBeInTheDocument()
    expect(window.cockpit.getPanel).toHaveBeenCalledWith('/dev/rocket')
  })

  it('falls back to Global when the repo is no longer indexed', async () => {
    const onScope = vi.fn()
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(buildReport(null, []))
    render(<AiSetup repos={[]} repoRoot="/dev/gone" onScope={onScope} onClose={vi.fn()} />)
    expect(onScope).toHaveBeenCalledWith(null)
  })
})

describe('Agents › the instructions row', () => {
  const BASE = '# Rules\n\nUse worktrees.'
  const inst: InstructionsState = {
    repoRoot: null,
    baseline: BASE,
    files: [
      {
        agents: ['claude'],
        path: '/Users/me/.claude/CLAUDE.md',
        exists: true,
        content: '',
        block: BASE,
        own: { above: 2, below: 0 },
        duplicates: 0,
        readBy: [],
        status: 'synced'
      },
      {
        agents: ['codex'],
        path: '/Users/me/.codex/AGENTS.md',
        exists: true,
        content: '',
        block: '# Rules\n\nUse branches.',
        own: { above: 0, below: 0 },
        duplicates: 0,
        readBy: [],
        status: 'drifted'
      },
      {
        agents: ['copilot'],
        path: '/Users/me/.copilot/copilot-instructions.md',
        exists: true,
        content: '',
        block: BASE,
        own: { above: 0, below: 0 },
        duplicates: 0,
        readBy: [],
        status: 'synced'
      }
    ]
  }
  const entry: LibraryEntry = {
    kind: 'instructions',
    name: 'Shared baseline',
    enabled: { claude: true, codex: true, copilot: true }
  }

  // "differs" on an instructions row used to open onto a table of file paths — the
  // one comparison Cockpit can actually make is each file against the baseline
  it('opens onto each file’s diff against the baseline, with the fix beside it', async () => {
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(
      buildReport(null, [instructionRow(inst, entry)])
    )
    vi.mocked(window.cockpit.getInstructions).mockResolvedValue(inst)
    vi.mocked(window.cockpit.applyInstructions).mockResolvedValue({
      ...inst,
      files: inst.files.map((f) => ({ ...f, block: BASE, status: 'synced' }))
    })
    render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: /Shared baseline/ }))

    const codex = await screen.findByRole('region', { name: 'Changes to ~/.codex/AGENTS.md' })
    expect(within(codex).getByText('rewrites block')).toBeInTheDocument()
    expect(codex.querySelector('.idiff-line.del .idiff-text')).toHaveTextContent('Use branches.')
    expect(codex.querySelector('.idiff-line.add .idiff-text')).toHaveTextContent('Use worktrees.')
    expect(document.querySelector('.pnl-diff')).toBeNull()
    // the same layout switch every diff in the app carries
    expect(screen.getByRole('group', { name: 'Diff layout' })).toBeInTheDocument()

    await userEvent.click(within(codex).getByRole('button', { name: 'Re-apply' }))
    expect(window.cockpit.applyInstructions).toHaveBeenCalledWith(null, '/Users/me/.codex/AGENTS.md')
    // the panel re-reads every agent once a file has been rewritten
    expect(window.cockpit.getPanel).toHaveBeenCalledTimes(2)
    expect(await within(codex).findByText('no changes')).toBeInTheDocument()
  })

  // in its own section the editor already is the row, opened: repeating the row under
  // it echoed the same files, the same drift and a second diff
  it('keeps only the agent switches in the Instructions section, not a second row', async () => {
    const panel = buildReport(null, [instructionRow(inst, entry)])
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(panel)
    vi.mocked(window.cockpit.setPanelSwitch).mockResolvedValue(panel)
    vi.mocked(window.cockpit.getInstructions).mockResolvedValue(inst)
    render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: /^Instructions/ }))

    expect(await screen.findByText('Kept in sync for')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Shared baseline/ })).not.toBeInTheDocument()
    const codex = screen.getByRole('switch', { name: 'Shared baseline in Codex' })
    expect(codex).toHaveAttribute('aria-checked', 'true')
    // the switch still does what the row's did
    await userEvent.click(codex)
    expect(window.cockpit.setPanelSwitch).toHaveBeenCalled()
  })
})
