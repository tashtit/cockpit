import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiSetup } from '../../src/renderer/src/AiSetup'
import { buildReport, buildRow } from '../../src/shared/library'
import type { MarketplaceCatalog, RepoGroup } from '../../src/shared/types'

const repo: RepoGroup = {
  key: '/dev/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/dev/rocket',
  sessionCount: 1,
  archivedCount: 0,
  heldCount: 0,
  byProvider: {},
  lastActivity: 0,
  providers: ['claude'],
  hidden: false
}

const acme: MarketplaceCatalog = {
  name: 'acme-market',
  source: 'acme/agent-plugins',
  agents: ['claude'],
  origin: 'local',
  plugins: [
    {
      name: 'review',
      id: 'review@acme-market',
      description: 'Reviews a diff before it ships',
      version: '1.4.0',
      keywords: ['diff', 'pr']
    },
    {
      name: 'secure-ci',
      id: 'secure-ci@acme-market',
      description: 'Pinned actions and least-privilege tokens',
      keywords: ['actions']
    }
  ]
}

/** One nobody here has added: it lists, with no catalogue and a way to read one. */
const unread: MarketplaceCatalog = {
  name: 'tashtit',
  source: 'https://github.com/tashtit/marketplace.git',
  agents: [],
  plugins: [],
  problem: 'no catalogue on this machine yet',
  recommended: true
}

/** The plugin row a catalogue lines up against: review is already in Claude Code. */
const installed = buildReport(null, [
  buildRow(
    { kind: 'plugin', name: 'review@acme-market', enabled: { claude: true }, source: 'acme-market' },
    { detail: 'from acme-market', fields: {} },
    { claude: { present: true, detail: 'v1.0.0', fields: {} } }
  )
])

async function openBrowse(catalogs: readonly MarketplaceCatalog[] = [acme, unread]): Promise<void> {
  vi.mocked(window.cockpit.getPanel).mockResolvedValue(installed)
  vi.mocked(window.cockpit.addFromCatalog).mockResolvedValue(installed)
  vi.mocked(window.cockpit.listCatalogs).mockResolvedValue(catalogs)
  render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
  await userEvent.click(await screen.findByRole('tab', { name: /^Browse/ }))
}

describe('Agents › Browse', () => {
  it('is a section of its own in Global', async () => {
    await openBrowse()
    expect(screen.getByRole('tab', { name: /^Browse/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/Adding a marketplace installs nothing/)).toBeInTheDocument()
  })

  it('is absent in a repo scope — a repo installs no plugins', async () => {
    vi.mocked(window.cockpit.getPanel).mockResolvedValue(buildReport('/dev/rocket', []))
    render(<AiSetup repos={[repo]} repoRoot="/dev/rocket" onScope={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByRole('tab', { name: /^Instructions/ })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /^Browse/ })).not.toBeInTheDocument()
  })

  it('opens a marketplace onto what it offers, and installs one plugin in one agent', async () => {
    await openBrowse()
    await userEvent.click(screen.getByRole('button', { name: /^acme-market/ }))
    expect(screen.getByText('Reviews a diff before it ships')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add secure-ci to Claude' }))
    expect(window.cockpit.addFromCatalog).toHaveBeenCalledWith(
      { kind: 'plugin', name: 'secure-ci@acme-market' },
      'claude'
    )
  })

  it('will not offer a plugin to an agent that hasn’t got its marketplace', async () => {
    await openBrowse()
    await userEvent.click(screen.getByRole('button', { name: /^acme-market/ }))
    const codex = screen.getByRole('button', { name: 'Add secure-ci to Codex' })
    expect(codex).toBeDisabled()
    expect(codex.getAttribute('title')).toContain('hasn’t got the acme-market marketplace yet')
  })

  it('shows a plugin an agent already has as lit and inert — uninstalling is elsewhere', async () => {
    await openBrowse()
    await userEvent.click(screen.getByRole('button', { name: /^acme-market/ }))
    const had = screen.getByRole('button', { name: 'review is in Claude' })
    expect(had).toBeDisabled()
    expect(had).toHaveClass('on')
  })

  it('adds the marketplace itself to an agent that hasn’t got it', async () => {
    await openBrowse()
    await userEvent.click(screen.getByRole('button', { name: 'Add the acme-market marketplace to Codex' }))
    expect(window.cockpit.addFromCatalog).toHaveBeenCalledWith(
      { kind: 'marketplace', name: 'acme-market', source: 'acme/agent-plugins' },
      'codex'
    )
  })

  it('searches the catalogues rather than the panel’s own rows', async () => {
    await openBrowse()
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search this scope' }), 'least-privilege')
    expect(screen.getByText('Pinned actions and least-privilege tokens')).toBeInTheDocument()
    expect(screen.queryByText('Reviews a diff before it ships')).not.toBeInTheDocument()
  })

  it('reads a catalogue from its repository only when asked', async () => {
    await openBrowse()
    expect(window.cockpit.lookupMarketplace).not.toHaveBeenCalled()
    vi.mocked(window.cockpit.lookupMarketplace).mockResolvedValue({
      ...unread,
      origin: 'remote',
      problem: undefined,
      plugins: [
        { name: 'git-workflow', id: 'git-workflow@tashtit', description: 'Focused commits', keywords: [] }
      ]
    })
    await userEvent.click(screen.getByRole('button', { name: /^tashtit/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Look it up: tashtit' }))
    expect(window.cockpit.lookupMarketplace).toHaveBeenCalledWith(
      'https://github.com/tashtit/marketplace.git'
    )
    expect(await screen.findByText('Focused commits')).toBeInTheDocument()
  })

  it('looks up a repository the person types, without installing anything', async () => {
    await openBrowse([])
    vi.mocked(window.cockpit.lookupMarketplace).mockResolvedValue({
      ...unread,
      origin: 'remote',
      problem: undefined,
      plugins: [{ name: 'api-design', id: 'api-design@tashtit', description: 'Contracts', keywords: [] }]
    })
    await userEvent.type(screen.getByLabelText('Look up a marketplace'), 'tashtit/marketplace')
    await userEvent.click(screen.getByRole('button', { name: 'Look it up' }))
    expect(window.cockpit.lookupMarketplace).toHaveBeenCalledWith('tashtit/marketplace')
    // the plugins are there to read, and the marketplace comes first: a plugin can
    // only be installed from a marketplace that agent already has
    const row = await screen.findByText('api-design')
    expect(
      within(row.closest('li') as HTMLElement).getByRole('button', { name: 'Add api-design to Claude' })
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Add the tashtit marketplace to Claude' })
    ).toBeEnabled()
    expect(window.cockpit.addFromCatalog).not.toHaveBeenCalled()
  })
})
