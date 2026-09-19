import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings, SETTINGS_SECTIONS } from '../../src/renderer/src/Settings'
import type { SourceStats } from '../../src/shared/types'

const sources: SourceStats[] = [
  {
    path: '/home/dev/.claude',
    provider: 'claude',
    label: 'claude-default',
    count: 12,
    lastUpdatedAt: Date.now() - 60_000,
    missing: false
  }
]

const tabs = (): HTMLElement => screen.getByRole('tablist', { name: 'Settings sections' })
const tab = (name: string): HTMLElement => screen.getByRole('tab', { name })

beforeEach(() => {
  vi.mocked(window.cockpit.getSourceStats).mockResolvedValue(sources)
})

describe('Settings tabs', () => {
  it('opens on the first tab with only that panel mounted', async () => {
    render(<Settings onClose={vi.fn()} />)

    expect(tabs()).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(SETTINGS_SECTIONS.length)
    expect(tab('Accounts')).toHaveAttribute('aria-selected', 'true')
    // exactly one panel exists at a time — that is what makes each tab its own page
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(await screen.findByText('claude-default')).toBeInTheDocument()
    // and the sections behind the other tabs are not rendered anywhere
    expect(screen.queryByRole('button', { name: /^Time format/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export backup…' })).toBeNull()
  })

  it('switches panels on click, one selected tab at a time', async () => {
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')

    await userEvent.click(tab('View'))
    expect(tab('View')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Accounts')).toHaveAttribute('aria-selected', 'false')
    expect(await screen.findByRole('button', { name: /^Time format/ })).toBeInTheDocument()
    expect(screen.queryByText('claude-default')).toBeNull()

    await userEvent.click(tab('Accounts'))
    expect(await screen.findByText('claude-default')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Time format/ })).toBeNull()
  })

  it('reads a tab’s own data only when that tab is opened', async () => {
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')
    // the View tab has never been open: nothing asked main for its setting
    expect(window.cockpit.getHistoryDays).not.toHaveBeenCalled()

    await userEvent.click(tab('View'))
    await waitFor(() => expect(window.cockpit.getHistoryDays).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: /^Sessions to show/ })).toBeInTheDocument()
  })

  it('offers a one-day window, and saves it', async () => {
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')
    await userEvent.click(tab('View'))

    await userEvent.click(await screen.findByRole('button', { name: /^Sessions to show/ }))
    // the shortest window the presets offer — "today's work only"
    const day = await screen.findByRole('option', { name: 'Last day' })
    expect(day).toBeInTheDocument()
    await userEvent.click(day)
    expect(window.cockpit.setHistoryDays).toHaveBeenCalledWith(1)
  })

  it('opens on the tab a deep link names', async () => {
    render(<Settings onClose={vi.fn()} section="backup" />)

    expect(tab('Backup')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('button', { name: 'Export backup…' })).toBeInTheDocument()
    expect(window.cockpit.getSourceStats).not.toHaveBeenCalled()
  })

  it('keeps the card’s head and its tabs reachable from every tab', async () => {
    // the bug the tabs replaced: picking a section scrolled its heading to the top of
    // the card, taking the title, the section list and Close off the screen with it.
    // Nothing here may scroll, so nothing can be scrolled out of reach.
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView')
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')

    for (const s of SETTINGS_SECTIONS) {
      await userEvent.click(tab(s.label))
      expect(tab(s.label)).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Close' })).toBeVisible()
      expect(tabs()).toBeVisible()
    }
    expect(scrolled).not.toHaveBeenCalled()
    scrolled.mockRestore()
  })

  it('moves between tabs with the arrow keys, as one tab stop', async () => {
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')

    // only the selected tab is in the tab order; the rest are reached with arrows
    expect(tab('Accounts')).toHaveAttribute('tabindex', '0')
    expect(tab('View')).toHaveAttribute('tabindex', '-1')

    tab('Accounts').focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(tab('View')).toHaveFocus()
    expect(tab('View')).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{ArrowLeft}')
    expect(tab('Accounts')).toHaveAttribute('aria-selected', 'true')

    await userEvent.keyboard('{End}')
    expect(tab('About')).toHaveAttribute('aria-selected', 'true')
    // and it wraps, rather than dead-ending at either edge
    await userEvent.keyboard('{ArrowRight}')
    expect(tab('Accounts')).toHaveAttribute('aria-selected', 'true')
  })

  it('names each panel by its tab, and only the open tab names a panel', async () => {
    render(<Settings onClose={vi.fn()} section="about" />)
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAccessibleName('About')
    expect(tab('About')).toHaveAttribute('aria-controls', panel.id)
    // the other five panels are not in the DOM, so their tabs must not name one:
    // an aria-controls pointing at nothing is a dead "go to the controlled element"
    for (const s of SETTINGS_SECTIONS.filter((s) => s.id !== 'about')) {
      expect(tab(s.label)).not.toHaveAttribute('aria-controls')
    }
  })

  it('takes a deep link to a tab the user has since left', async () => {
    // the sidebar's usage meters name 'accounts' every time they are clicked, so the
    // section alone cannot say "take me there" twice — App counts the asking
    const { rerender } = render(<Settings onClose={vi.fn()} section="accounts" openCount={1} />)
    await screen.findByText('claude-default')

    await userEvent.click(tab('Backup'))
    expect(tab('Backup')).toHaveAttribute('aria-selected', 'true')

    rerender(<Settings onClose={vi.fn()} section="accounts" openCount={2} />)
    expect(tab('Accounts')).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('claude-default')).toBeInTheDocument()
  })

  it('leaves the open tab alone when Settings is reopened with no tab named', async () => {
    const { rerender } = render(<Settings onClose={vi.fn()} openCount={1} />)
    await screen.findByText('claude-default')
    await userEvent.click(tab('Backup'))

    rerender(<Settings onClose={vi.fn()} openCount={2} />)
    expect(tab('Backup')).toHaveAttribute('aria-selected', 'true')
  })
})
