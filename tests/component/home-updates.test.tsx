import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeUpdates } from '../../src/renderer/src/HomeUpdates'
import type { UpdateSuggestion } from '../../src/shared/types'

const cli: UpdateSuggestion = {
  kind: 'cli',
  id: 'cli:codex',
  name: 'Codex',
  agents: ['codex'],
  current: '0.150.0',
  latest: '0.155.1',
  detail: 'Homebrew has 0.155.1'
}

const mcp: UpdateSuggestion = {
  kind: 'mcp',
  id: 'mcp:playwright',
  name: 'playwright',
  agents: [],
  current: '0.0.78',
  latest: '0.0.81',
  detail: 'npm · @playwright/mcp'
}

const plugin: UpdateSuggestion = {
  kind: 'plugin',
  id: 'plugin:review@acme',
  name: 'review@acme',
  agents: ['claude', 'copilot'],
  current: '1.2.0',
  latest: '1.4.0',
  detail: 'acme has 1.4.0'
}

const drift: UpdateSuggestion = {
  kind: 'drift',
  id: 'drift:mcp:github',
  name: 'github',
  agents: ['copilot'],
  detail: 'MCP servers — the agents run different definitions'
}

function renderStrip(items: readonly UpdateSuggestion[]): {
  agents: () => void
  about: () => void
} {
  vi.mocked(window.cockpit.getUpdatesDigest).mockResolvedValue({ items, at: 0, problems: [] })
  const jump = { agents: vi.fn(), about: vi.fn() }
  render(<HomeUpdates jump={jump} />)
  return jump
}

describe('the home’s updates strip', () => {
  it('stays off the screen entirely when nothing is out of date', async () => {
    renderStrip([])
    await waitFor(() => expect(window.cockpit.getUpdatesDigest).toHaveBeenCalled())
    expect(screen.queryByRole('region', { name: 'Updates' })).not.toBeInTheDocument()
  })

  it('opens on one line, and counts updates apart from disagreements', async () => {
    renderStrip([cli, mcp, drift])
    const head = await screen.findByRole('button', { name: /2 updates/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveTextContent('2 updates · 1 agent difference')
    // closed: the rows are not on screen at all, the board below owns that room
    expect(screen.queryByText('Homebrew has 0.155.1')).not.toBeInTheDocument()
  })

  it('shows every row when opened, and remembers that it was opened', async () => {
    renderStrip([cli, mcp, drift])
    await userEvent.click(await screen.findByRole('button', { name: /2 updates/ }))
    expect(screen.getByText('Homebrew has 0.155.1')).toBeInTheDocument()
    expect(screen.getByText('npm · @playwright/mcp')).toBeInTheDocument()
    expect(window.localStorage.getItem('cockpit:home-updates-open')).toBe('1')
  })

  it('pins an MCP server to the release the registry offered', async () => {
    renderStrip([mcp])
    await userEvent.click(await screen.findByRole('button', { name: /1 update/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Update to 0.0.81' }))
    expect(window.cockpit.setMcpVersion).toHaveBeenCalledWith(
      { repoRoot: null, kind: 'mcp', name: 'playwright' },
      '0.0.81'
    )
    // and it asks again rather than leaving the settled row on screen — a plain ask:
    // main forgot its gathering when the pin landed, and a forced one would pull every
    // marketplace again, which is Check again's to do
    await waitFor(() => expect(window.cockpit.getUpdatesDigest).toHaveBeenCalledTimes(2))
    expect(window.cockpit.getUpdatesDigest).not.toHaveBeenCalledWith(true)
  })

  it('updates a plugin through each agent’s own plugin update', async () => {
    renderStrip([plugin])
    await userEvent.click(await screen.findByRole('button', { name: /1 update/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Update to 1.4.0' }))
    expect(window.cockpit.updatePlugin).toHaveBeenCalledWith('review@acme')
  })

  it('asks everything again only when the person says so', async () => {
    renderStrip([plugin])
    await userEvent.click(await screen.findByRole('button', { name: /1 update/ }))
    expect(window.cockpit.getUpdatesDigest).not.toHaveBeenCalledWith(true)
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(window.cockpit.getUpdatesDigest).toHaveBeenCalledWith(true)
  })

  // a disabled button drops keyboard focus to the page the moment it is clicked
  it('keeps focus on the button it was clicked on while the update runs', async () => {
    let done: (v: unknown) => void = () => {}
    vi.mocked(window.cockpit.updatePlugin).mockReturnValue(new Promise((r) => (done = r)) as never)
    renderStrip([plugin, mcp])
    await userEvent.click(await screen.findByRole('button', { name: /2 updates/ }))
    const button = screen.getByRole('button', { name: 'Update to 1.4.0' })
    await userEvent.click(button)
    expect(document.activeElement).toBe(button)
    expect(button).toHaveAttribute('aria-disabled', 'true')
    // and nothing else starts meanwhile
    await userEvent.click(screen.getByRole('button', { name: 'Update to 0.0.81' }))
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(window.cockpit.setMcpVersion).not.toHaveBeenCalled()
    expect(window.cockpit.getUpdatesDigest).not.toHaveBeenCalledWith(true)
    done(undefined)
  })

  it('hands a CLI update to Terminal, where the person can answer it', async () => {
    renderStrip([cli])
    await userEvent.click(await screen.findByRole('button', { name: /1 update/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Update in Terminal' }))
    expect(window.cockpit.openCliUpdate).toHaveBeenCalledWith('codex')
  })

  // Settings › Accounts' own flow: one Terminal per click, the row saying where the
  // update is, and the list asked again once the version moved on
  it('says the update is in Terminal, opens one window per click, and lets the row go once it lands', async () => {
    let opened: () => void = () => {}
    vi.mocked(window.cockpit.openCliUpdate).mockReturnValue(new Promise<void>((r) => (opened = r)))
    renderStrip([cli])
    await userEvent.click(await screen.findByRole('button', { name: /1 update/ }))
    const button = screen.getByRole('button', { name: 'Update in Terminal' })
    await userEvent.dblClick(button)
    expect(window.cockpit.openCliUpdate).toHaveBeenCalledTimes(1)
    opened()
    expect(await screen.findByRole('button', { name: 'Open Terminal again' })).toBeInTheDocument()
    expect(screen.getByText('Finish the update in the Terminal window — this row updates by itself.')).toBeInTheDocument()
    expect(screen.queryByText('Homebrew has 0.155.1')).not.toBeInTheDocument()

    // Codex moved on: the list is asked again, and the digest no longer has the row
    vi.mocked(window.cockpit.getUpdatesDigest).mockResolvedValue({ items: [mcp], at: 1, problems: [] })
    vi.mocked(window.cockpit.listCliStatus).mockResolvedValue([
      {
        provider: 'codex',
        installed: true,
        version: '0.155.1',
        path: '/opt/homebrew/bin/codex',
        install: 'brew-cask',
        latest: '0.155.1',
        upstream: '0.155.1',
        channel: 'Homebrew',
        updateAvailable: false,
        updateCommand: 'brew update && brew upgrade --cask codex'
      }
    ])
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(screen.queryByText('Codex')).not.toBeInTheDocument())
    expect(screen.getByText('playwright')).toBeInTheDocument()
  })

  it('sends a disagreement to the view that settles it', async () => {
    const jump = renderStrip([drift])
    await userEvent.click(await screen.findByRole('button', { name: /1 agent difference/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Settle it' }))
    expect(jump.agents).toHaveBeenCalled()
  })

  it('says what it could not ask, rather than pretending the list is complete', async () => {
    vi.mocked(window.cockpit.getUpdatesDigest).mockResolvedValue({
      items: [mcp],
      at: 0,
      problems: ['couldn’t ask npm about every pinned MCP server']
    })
    render(<HomeUpdates jump={{ agents: vi.fn(), about: vi.fn() }} />)
    await userEvent.click(await screen.findByRole('button', { name: /1 update/ }))
    expect(screen.getByText('couldn’t ask npm about every pinned MCP server')).toBeInTheDocument()
  })
})
