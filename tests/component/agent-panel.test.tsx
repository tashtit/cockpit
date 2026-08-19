import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiSetup } from '../../src/renderer/src/AiSetup'
import { buildReport, buildRow, mcpFields, type PanelReport } from '../../src/shared/library'
import type { LibraryEntry, McpConfig, Provider, RepoGroup } from '../../src/shared/types'

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
  vi.mocked(window.cockpit.fixPanelDrift).mockResolvedValue(report)
  vi.mocked(window.cockpit.forgetPanelEntry).mockResolvedValue(report)
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

  it('opens a row onto Cockpit’s definition beside each agent’s', async () => {
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: /github/ }))
    const diff = screen.getByRole('table', { name: 'github — Cockpit and each agent' })
    // Cockpit leads the table — it is the source of truth, not one opinion among four
    const headers = within(diff).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['field', 'Cockpit', 'Claude', 'Codex', 'Copilot'])
    expect(within(diff).getByRole('rowheader', { name: 'command' }).closest('tr')).toHaveClass(
      'differs'
    )
  })

  it('offers both honest answers to a disagreement', async () => {
    await openPanel()
    await userEvent.click(screen.getByRole('button', { name: /github/ }))
    expect(screen.getByText(/Copilot is running a different github/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Take this agent’s version' }))
    expect(window.cockpit.fixPanelDrift).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'mcp', name: 'github' },
      'copilot',
      'adopt'
    )
  })

  it('needs a second click to remove something everywhere', async () => {
    await openPanel()
    await section('MCP servers')
    await userEvent.click(screen.getByRole('button', { name: /linear/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove linear everywhere' }))
    expect(window.cockpit.forgetPanelEntry).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm removing linear everywhere' }))
    expect(window.cockpit.forgetPanelEntry).toHaveBeenCalledWith({
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
    expect(await screen.findByText('quiet')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /^Needs you/ })).not.toBeInTheDocument()
  })

  it('searches across every section, not just the one showing', async () => {
    await openPanel()
    await search('evalkit')
    // the plugin lives in a section the panel wasn't showing
    expect(screen.getByText('evalkit@tashtit')).toBeInTheDocument()
    expect(screen.queryByText('github')).not.toBeInTheDocument()
    expect(screen.getByText(/1 match for/)).toBeInTheDocument()
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
  it('opens on Global and says what that means', async () => {
    await openPanel()
    expect(screen.getByText(/every session, in every repo/)).toBeInTheDocument()
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
