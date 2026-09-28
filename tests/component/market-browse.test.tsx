import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

  // disabling the control the person is on drops keyboard focus to the page
  it('keeps the lookup line and its button where focus is while a lookup runs', async () => {
    await openBrowse([])
    let answer: (c: MarketplaceCatalog) => void = () => {}
    vi.mocked(window.cockpit.lookupMarketplace).mockReturnValue(new Promise((r) => (answer = r)))
    const line = screen.getByLabelText('Look up a marketplace')
    await userEvent.type(line, 'tashtit/marketplace')
    const button = screen.getByRole('button', { name: 'Look it up' })
    await userEvent.click(button)
    expect(line).toBeEnabled()
    expect(screen.getByRole('button', { name: 'reading…' })).toHaveAttribute('aria-disabled', 'true')
    expect(document.activeElement).toBe(button)
    // a second click while it reads asks nothing more
    await userEvent.click(button)
    expect(window.cockpit.lookupMarketplace).toHaveBeenCalledTimes(1)
    answer({ ...unread, origin: 'remote', problem: undefined, plugins: [] })
    expect(await screen.findByRole('button', { name: 'Look it up' })).toBe(document.activeElement)
  })

  it('keeps the chip it was clicked on focused while the add runs, then hands focus to the card', async () => {
    await openBrowse()
    let land: (r: typeof installed) => void = () => {}
    vi.mocked(window.cockpit.addFromCatalog).mockReturnValue(new Promise((r) => (land = r)))
    await userEvent.click(screen.getByRole('button', { name: /^acme-market/ }))
    const chip = screen.getByRole('button', { name: 'Add secure-ci to Claude' })
    await userEvent.click(chip)
    expect(document.activeElement).toBe(chip)
    expect(chip).toBeEnabled()
    expect(chip).toHaveAttribute('aria-disabled', 'true')
    // busy is one write at a time across the card: another chip does nothing now
    await userEvent.click(screen.getByRole('button', { name: 'Add the acme-market marketplace to Codex' }))
    expect(window.cockpit.addFromCatalog).toHaveBeenCalledTimes(1)
    // it landed: the chip is lit and inert, and focus is on the plugin it added
    land(
      buildReport(null, [
        buildRow(
          { kind: 'plugin', name: 'secure-ci@acme-market', enabled: { claude: true }, source: 'acme-market' },
          { detail: 'from acme-market', fields: {} },
          { claude: { present: true, detail: 'v1.0.0', fields: {} } }
        )
      ])
    )
    expect(await screen.findByRole('button', { name: 'secure-ci is in Claude' })).toBeDisabled()
    expect(document.activeElement).toHaveTextContent('secure-ci')
    expect(document.activeElement?.tagName).not.toBe('BODY')
  })

  // every add moves the report and re-reads the machine's list, which never has what a
  // lookup read from GitHub — that catalogue must outlive the add it was read for
  it('keeps a catalogue it looked up through the adds made from it', async () => {
    await openBrowse()
    vi.mocked(window.cockpit.lookupMarketplace).mockResolvedValue({
      ...unread,
      origin: 'remote',
      problem: undefined,
      plugins: [{ name: 'git-workflow', id: 'git-workflow@tashtit', description: 'Focused commits', keywords: [] }]
    })
    await userEvent.click(screen.getByRole('button', { name: /^tashtit/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Look it up: tashtit' }))
    expect(await screen.findByText('Focused commits')).toBeInTheDocument()
    // the add lands; Claude now has the marketplace, but no clone was read here yet
    vi.mocked(window.cockpit.listCatalogs).mockResolvedValue([acme, { ...unread, agents: ['claude'] }])
    vi.mocked(window.cockpit.addFromCatalog).mockResolvedValue(buildReport(null, []))
    await userEvent.click(screen.getByRole('button', { name: 'Add the tashtit marketplace to Claude' }))
    await waitFor(() => expect(window.cockpit.listCatalogs).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('button', { name: 'the tashtit marketplace is in Claude' })).toBeDisabled()
    expect(screen.getByText('Focused commits')).toBeInTheDocument()
    // and its plugins can go to the agent that has the marketplace now
    expect(screen.getByRole('button', { name: 'Add git-workflow to Claude' })).toBeEnabled()
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
