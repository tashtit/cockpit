import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CleanupView } from '../../src/renderer/src/CleanupView'
import type { CleanupReport, StaleSession, StaleWorktree } from '../../src/shared/types'

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
    blocks: [],
    ...over
  }
}

function worktree(over: Partial<StaleWorktree> = {}): StaleWorktree {
  return {
    path: '/userData/worktrees/cockpit/fix-login',
    repoRoot: '/repos/cockpit',
    repoName: 'cockpit',
    branch: 'cockpit/fix-login',
    origin: 'cockpit',
    lastActivity: NOW - 200 * DAY,
    sessionCount: 2,
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

describe('CleanupView', () => {
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

  it('marks a worktree Cockpit never created as external', async () => {
    mount(report({ worktrees: [worktree({ origin: 'external', path: '/repos/x/.claude/worktrees/spike' })] }))
    expect(await screen.findByText('external')).toBeInTheDocument()
  })

  it('archives the selected sessions', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByLabelText('Select session Refactor the parser'))
    await user.click(screen.getByRole('button', { name: /^Archive/ }))
    await waitFor(() =>
      expect(window.cockpit.archiveSessions).toHaveBeenCalledWith(['claude:one'])
    )
  })

  it('takes two clicks to delete session files', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByLabelText('Select session Refactor the parser'))
    await user.click(screen.getByRole('button', { name: 'Delete files…' }))
    expect(window.cockpit.deleteSessions).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /Delete 1 for good\?/ }))
    await waitFor(() =>
      expect(window.cockpit.deleteSessions).toHaveBeenCalledWith(['claude:one'])
    )
  })

  it('never lets a blocked row be selected, and says why', async () => {
    mount(report({ worktrees: [worktree({ blocks: ['dirty'] })] }))
    const pick = await screen.findByLabelText(
      'Select worktree /userData/worktrees/cockpit/fix-login'
    )
    expect(pick).toBeDisabled()
    expect(screen.getByText('uncommitted changes')).toBeInTheDocument()
  })

  it('select-all skips blocked rows', async () => {
    const user = userEvent.setup()
    mount(
      report({
        worktrees: [worktree(), worktree({ path: '/repos/x/wt-dirty', blocks: ['dirty'] })]
      })
    )
    await user.click((await screen.findAllByRole('button', { name: 'Select all' }))[1])
    await user.click(screen.getByRole('button', { name: /^Remove 1…$/ }))
    await user.click(screen.getByRole('button', { name: /Remove 1 worktree\?/ }))
    await waitFor(() =>
      expect(window.cockpit.removeWorktrees).toHaveBeenCalledWith([
        '/userData/worktrees/cockpit/fix-login'
      ])
    )
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
      failed: [{ target: '/userData/worktrees/cockpit/fix-login', reason: 'it has uncommitted changes' }]
    })
    await user.click(
      await screen.findByLabelText('Select worktree /userData/worktrees/cockpit/fix-login')
    )
    await user.click(screen.getByRole('button', { name: /^Remove 1…$/ }))
    await user.click(screen.getByRole('button', { name: /Remove 1 worktree\?/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('it has uncommitted changes')
  })

  it('says so when there is nothing to clean', async () => {
    mount(report({ sessions: [], worktrees: [], staleSessionCount: 0, staleWorktreeCount: 0 }))
    expect(await screen.findByText(/every session is still recent/)).toBeInTheDocument()
    expect(screen.getByText(/every checkout is still in use/)).toBeInTheDocument()
  })

  it('admits when it is showing only a window onto the backlog', async () => {
    mount(report({ sessions: [session()], staleSessionCount: 1203 }))
    expect(await screen.findByText(/Showing the 1 oldest of 1203/)).toBeInTheDocument()
  })
})
