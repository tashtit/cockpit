import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CleanupView } from '../../src/renderer/src/CleanupView'
import type {
  CleanupReport,
  Provider,
  SessionWorktree,
  StaleSession,
  StaleWorktree
} from '../../src/shared/types'

const DAY = 86_400_000
const NOW = Date.parse('2026-08-23T12:00:00Z')

function session(over: Partial<StaleSession> = {}): StaleSession {
  return {
    id: 'claude:one',
    provider: 'claude',
    title: 'Refactor the parser',
    repoName: 'cockpit',
    cwd: '/repos/cockpit',
    updatedAt: NOW - 120 * DAY,
    bytes: 4_200_000,
    archived: false,
    worktree: null,
    blocks: [],
    ...over
  }
}

function carried(over: Partial<SessionWorktree> = {}): SessionWorktree {
  return { path: '/wt/fix-login', branch: 'cockpit/fix-login', bytes: 400_000_000, sessionCount: 1, ...over }
}

/** Three sessions, one per agent, for range and filter tests. */
function trio(): StaleSession[] {
  const agents: Provider[] = ['claude', 'codex', 'copilot']
  return agents.map((p, i) =>
    session({
      id: `${p}:${i}`,
      provider: p,
      title: `Task ${i + 1}`,
      repoName: i === 2 ? 'cachely' : 'cockpit',
      updatedAt: NOW - (100 + i) * DAY
    })
  )
}

function worktree(over: Partial<StaleWorktree> = {}): StaleWorktree {
  return {
    path: '/userData/worktrees/cockpit/orphan',
    repoRoot: '/repos/cockpit',
    repoName: 'cockpit',
    branch: 'cockpit/orphan',
    origin: 'cockpit',
    lastActivity: NOW - 200 * DAY,
    sessionCount: 0,
    missing: false,
    unpushed: 0,
    bytes: 51_000_000,
    blocks: [],
    ...over
  }
}

function report(over: Partial<CleanupReport> = {}): CleanupReport {
  const sessions = over.sessions ?? [session()]
  const worktrees = over.worktrees ?? [worktree()]
  return {
    staleDays: 30,
    scannedAt: NOW,
    sessions,
    staleSessionCount: sessions.length,
    staleSessionBytes: sessions.reduce((n, s) => n + s.bytes, 0),
    worktrees,
    staleWorktreeCount: worktrees.length,
    totalSessions: 312,
    totalWorktrees: 9,
    ...over
  }
}

function mount(r: CleanupReport = report()): void {
  vi.mocked(window.cockpit.scanCleanup).mockResolvedValue(r)
  render(<CleanupView onClose={() => {}} />)
}

/** The group summary mixes elements (<strong>N</strong> selected) — read it whole. */
const summary = (n = 0): string =>
  document.querySelectorAll('.cl-head-summary')[n]?.textContent ?? ''

/** Same for the row's "takes its worktree · 400 MB" chip. */
const carryText = (): string => document.querySelector('.cl-carry')?.textContent ?? ''

const picks = (): HTMLElement[] =>
  screen
    .getAllByRole('checkbox')
    .filter((c) => (c.getAttribute('aria-label') ?? '').startsWith('Select session'))

describe('CleanupView — what it shows', () => {
  it('scans on open and shows what is stale against what exists', async () => {
    mount()
    expect(await screen.findByText(/312 sessions/)).toBeInTheDocument()
    expect(screen.getByText(/of 9 worktrees/)).toBeInTheDocument()
  })

  it('lists stale sessions with their age and size', async () => {
    mount()
    expect(await screen.findByText('Refactor the parser')).toBeInTheDocument()
    expect(screen.getByText('idle 4mo')).toBeInTheDocument()
    expect(screen.getByText('4.2 MB')).toBeInTheDocument()
  })

  it('says on the row that a session takes its worktree with it', async () => {
    mount(report({ sessions: [session({ worktree: carried() })] }))
    await screen.findByText('Refactor the parser')
    expect(carryText()).toMatch(/takes its worktree · 400 MB/)
  })

  it('warns when a carried worktree is shared with other sessions', async () => {
    mount(report({ sessions: [session({ worktree: carried({ sessionCount: 3 }) })] }))
    await screen.findByText('Refactor the parser')
    expect(carryText()).toMatch(/shared ×3/)
  })

  it('marks a worktree Cockpit never created as external', async () => {
    mount(report({ worktrees: [worktree({ origin: 'external', path: '/repos/x/.claude/wt' })] }))
    expect(await screen.findByText('external')).toBeInTheDocument()
  })

  it('says so when there is nothing to clean', async () => {
    mount(report({ sessions: [], worktrees: [], staleSessionCount: 0, staleWorktreeCount: 0 }))
    expect(await screen.findByText(/every session is still recent/)).toBeInTheDocument()
    expect(screen.getByText(/No leftovers/)).toBeInTheDocument()
  })

  it('admits when it is showing only a window onto the backlog', async () => {
    mount(report({ sessions: [session()], staleSessionCount: 1203 }))
    expect(await screen.findByText(/Showing the 1 oldest of 1203/)).toBeInTheDocument()
  })
})

describe('CleanupView — selection', () => {
  it('select-all takes every shown row', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await user.click(await screen.findByLabelText('Select all shown — stale sessions'))
    expect(summary()).toMatch(/3 selected/)
    await user.click(screen.getByRole('button', { name: 'Archive 3' }))
    await waitFor(() =>
      expect(window.cockpit.archiveSessions).toHaveBeenCalledWith(['claude:0', 'codex:1', 'copilot:2'])
    )
  })

  it('select-all skips rows that are blocked', async () => {
    const user = userEvent.setup()
    const rows = trio()
    rows[1] = { ...rows[1], blocks: ['busy'] }
    mount(report({ sessions: rows }))
    await user.click(await screen.findByLabelText('Select all shown — stale sessions'))
    await user.click(screen.getByRole('button', { name: 'Archive 2' }))
    await waitFor(() =>
      expect(window.cockpit.archiveSessions).toHaveBeenCalledWith(['claude:0', 'copilot:2'])
    )
  })

  it('shift-click selects the range between the two rows', async () => {
    const user = userEvent.setup()
    const rows = [...trio(), session({ id: 'claude:3', title: 'Task 4' })]
    mount(report({ sessions: rows }))
    await screen.findByText('Task 1')
    await user.click(picks()[0])
    await user.keyboard('{Shift>}')
    await user.click(picks()[2])
    await user.keyboard('{/Shift}')
    // rows 0..2 inclusive, and nothing beyond the anchor
    await user.click(screen.getByRole('button', { name: 'Archive 3' }))
    await waitFor(() =>
      expect(window.cockpit.archiveSessions).toHaveBeenCalledWith([
        'claude:0',
        'codex:1',
        'copilot:2'
      ])
    )
  })

  it('shift-click can clear a range as well as fill one', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await user.click(await screen.findByLabelText('Select all shown — stale sessions'))
    await user.click(picks()[0])
    await user.keyboard('{Shift>}')
    await user.click(picks()[2])
    await user.keyboard('{/Shift}')
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
  })

  it('adds up what the selection frees, worktrees included', async () => {
    const user = userEvent.setup()
    mount(
      report({
        sessions: [session({ bytes: 1_000_000, worktree: carried({ bytes: 400_000_000 }) })]
      })
    )
    await user.click(await screen.findByLabelText('Select session Refactor the parser'))
    expect(summary()).toMatch(/401 MB/)
    expect(summary()).toMatch(/1 worktree/)
  })

  it('does not count a shared worktree until every session in it is picked', async () => {
    const user = userEvent.setup()
    const shared = carried({ bytes: 400_000_000, sessionCount: 2 })
    mount(
      report({
        sessions: [
          session({ id: 'claude:a', title: 'A', bytes: 1_000_000, worktree: shared }),
          session({ id: 'claude:b', title: 'B', bytes: 1_000_000, worktree: shared })
        ]
      })
    )
    await user.click(await screen.findByLabelText('Select session A'))
    // one of two: the worktree is not counted, so only the transcript's own bytes
    expect(summary()).toMatch(/1 selected · 1 MB/)
    await user.click(screen.getByLabelText('Select session B'))
    expect(summary()).toMatch(/402 MB/)
  })

  it('never lets a blocked row be selected, and says why', async () => {
    mount(report({ worktrees: [worktree({ blocks: ['dirty'] })] }))
    const pick = await screen.findByLabelText(
      'Select worktree /userData/worktrees/cockpit/orphan'
    )
    expect(pick).toBeDisabled()
    expect(screen.getByText('uncommitted changes')).toBeInTheDocument()
  })
})

describe('CleanupView — filtering', () => {
  /** Open a dimension pill by its accessible name ("Agent Any"). */
  const openPill = async (
    user: ReturnType<typeof userEvent.setup>,
    name: RegExp
  ): Promise<void> => {
    await user.click(await screen.findByRole('button', { name }))
  }

  it('summarises a dimension on its own pill', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await openPill(user, /^Agent Any/)
    await user.click(screen.getByRole('button', { name: 'Codex' }))
    // the pill is the active-filter chip — it names the one selection outright
    expect(screen.getByRole('button', { name: /^Agent Codex/ })).toBeInTheDocument()
    expect(screen.getByText('Task 2')).toBeInTheDocument()
    expect(screen.queryByText('Task 1')).not.toBeInTheDocument()
    expect(summary()).toMatch(/1 shown of 3/)
  })

  it('counts a multi-value selection instead of listing it', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await openPill(user, /^Agent Any/)
    await user.click(screen.getByRole('button', { name: 'Claude' }))
    await user.click(screen.getByRole('button', { name: 'Codex' }))
    expect(screen.getByRole('button', { name: /^Agent 2 selected/ })).toBeInTheDocument()
    expect(summary()).toMatch(/2 shown of 3/)
  })

  it('excludes a value, and says "not x"', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await openPill(user, /^Agent Any/)
    await user.click(screen.getByRole('button', { name: 'Exclude Claude' }))
    expect(screen.getByRole('button', { name: /^Agent not Claude/ })).toBeInTheDocument()
    expect(screen.queryByText('Task 1')).not.toBeInTheDocument()
    expect(screen.getByText('Task 2')).toBeInTheDocument()
  })

  it('ANDs across dimensions', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await openPill(user, /^Agent Any/)
    await user.click(screen.getByRole('button', { name: 'Copilot' }))
    await user.keyboard('{Escape}')
    await openPill(user, /^Project Any/)
    // Task 3 is the copilot one, and the only one in cachely
    await user.click(screen.getByRole('button', { name: 'cockpit' }))
    expect(summary()).toMatch(/0 shown of 3/)
  })

  it('pins a dimension onto the bar through Add filter', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await screen.findByText('Task 1')
    // scoped to the sessions bar: the worktrees bar pins State by default
    const bar = (): HTMLElement => document.querySelectorAll('.fb-bar')[0] as HTMLElement
    expect(within(bar()).queryByRole('button', { name: /^State/ })).not.toBeInTheDocument()
    await user.click(within(bar()).getByRole('button', { name: 'Add filter' }))
    await user.click(screen.getByRole('switch', { name: /State/ }))
    expect(within(bar()).getByRole('button', { name: /^State Any/ })).toBeInTheDocument()
  })

  it('keeps a dimension on the bar while it carries a value, even if unpinned', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    const bar = (): HTMLElement => document.querySelectorAll('.fb-bar')[0] as HTMLElement
    await openPill(user, /^Agent Any/)
    await user.click(screen.getByRole('button', { name: 'Codex' }))
    await user.keyboard('{Escape}')
    // unpinning a dimension that is filtering would hide what is shaping the list,
    // so "Remove from bar" clears it first
    await user.click(within(bar()).getByRole('button', { name: /^Agent Codex/ }))
    await user.click(screen.getByRole('button', { name: 'Remove from bar' }))
    expect(within(bar()).queryByRole('button', { name: /^Agent/ })).not.toBeInTheDocument()
    expect(summary()).toMatch(/3 shown/)
  })

  it('clears everything, including the text query', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await user.type(await screen.findByLabelText('Filter sessions'), 'Task 3')
    await openPill(user, /^Agent Any/)
    await user.click(screen.getByRole('button', { name: 'Copilot' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getAllByRole('button', { name: 'Clear all' })[0])
    expect(screen.getByLabelText('Filter sessions')).toHaveValue('')
    expect(screen.getByRole('button', { name: /^Agent Any/ })).toBeInTheDocument()
    expect(summary()).toMatch(/3 shown/)
  })

  it('filters sessions by text', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await user.type(await screen.findByLabelText('Filter sessions'), 'Task 3')
    expect(screen.getByText('Task 3')).toBeInTheDocument()
    expect(screen.queryByText('Task 1')).not.toBeInTheDocument()
  })

  it('select-all after a filter takes only what the filter shows', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await openPill(user, /^Agent Any/)
    await user.click(screen.getByRole('button', { name: 'Copilot' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByLabelText('Select all shown — stale sessions'))
    await user.click(screen.getByRole('button', { name: 'Archive 1' }))
    await waitFor(() => expect(window.cockpit.archiveSessions).toHaveBeenCalledWith(['copilot:2']))
  })

  it('keeps selections made under a previous filter, and discloses them', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await openPill(user, /^Agent Any/)
    await user.click(screen.getByRole('button', { name: 'Claude' }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByLabelText('Select all shown — stale sessions'))
    // switch the dimension: the claude pick is still armed but no longer on screen
    await openPill(user, /^Agent Claude/)
    await user.click(screen.getByRole('button', { name: 'Claude' }))
    await user.click(screen.getByRole('button', { name: 'Codex' }))
    await user.keyboard('{Escape}')
    expect(summary()).toMatch(/1 not shown/)
  })

  it('filters worktrees by origin and to removable ones only', async () => {
    const user = userEvent.setup()
    mount(
      report({
        worktrees: [
          worktree({ path: '/wt/mine', origin: 'cockpit' }),
          worktree({ path: '/wt/theirs', origin: 'external' }),
          worktree({ path: '/wt/dirty', origin: 'external', blocks: ['dirty'] })
        ]
      })
    )
    await openPill(user, /^Origin Any/)
    await user.click(screen.getByRole('button', { name: 'External' }))
    await user.keyboard('{Escape}')
    expect(summary(1)).toMatch(/2 shown of 3/)
    await openPill(user, /^State Any/)
    await user.click(screen.getByRole('button', { name: 'Removable' }))
    await user.keyboard('{Escape}')
    expect(summary(1)).toMatch(/1 shown of 3/)
  })

  it('only offers dimension values the rows actually carry', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: [session({ provider: 'claude' })] }))
    await openPill(user, /^Agent Any/)
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Codex' })).not.toBeInTheDocument()
  })

  it('says when a filter matches nothing', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: trio() }))
    await user.type(await screen.findByLabelText('Filter sessions'), 'nothing matches this')
    expect(screen.getByText('No sessions match this filter.')).toBeInTheDocument()
  })
})

describe('CleanupView — acting', () => {
  it('takes two clicks to delete, and says what it will take', async () => {
    const user = userEvent.setup()
    mount(report({ sessions: [session({ worktree: carried() })] }))
    await user.click(await screen.findByLabelText('Select session Refactor the parser'))
    await user.click(screen.getByRole('button', { name: 'Delete 1…' }))
    expect(window.cockpit.deleteSessions).not.toHaveBeenCalled()
    const armed = screen.getByRole('button', { name: 'Delete 1 for good?' })
    expect(armed).toHaveAttribute('title', expect.stringContaining('worktrees these sessions ran in'))
    await user.click(armed)
    await waitFor(() => expect(window.cockpit.deleteSessions).toHaveBeenCalledWith(['claude:one']))
  })

  it('archives without arming — it is the reversible tier', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByLabelText('Select session Refactor the parser'))
    await user.click(screen.getByRole('button', { name: 'Archive 1' }))
    await waitFor(() => expect(window.cockpit.archiveSessions).toHaveBeenCalledWith(['claude:one']))
  })

  it('changing the threshold persists it and rescans', async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByText('Refactor the parser')
    await user.click(screen.getByRole('button', { name: /^Idle threshold/ }))
    await user.click(screen.getByRole('option', { name: 'Idle over 90 days' }))
    await waitFor(() => expect(window.cockpit.setStaleDays).toHaveBeenCalledWith(90))
    expect(window.cockpit.scanCleanup).toHaveBeenCalledTimes(2)
  })

  it('reports refusals from main instead of swallowing them', async () => {
    const user = userEvent.setup()
    mount()
    vi.mocked(window.cockpit.removeWorktrees).mockResolvedValue({
      cleaned: 0,
      freedBytes: 0,
      failed: [{ target: '/userData/worktrees/cockpit/orphan', reason: 'it has uncommitted changes' }]
    })
    await user.click(
      await screen.findByLabelText('Select worktree /userData/worktrees/cockpit/orphan')
    )
    await user.click(screen.getByRole('button', { name: 'Remove 1…' }))
    await user.click(screen.getByRole('button', { name: 'Remove 1 worktree?' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('it has uncommitted changes')
  })
})
