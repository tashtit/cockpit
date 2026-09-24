import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UpdateBar } from '../../src/renderer/src/UpdateBar'
import { updatePrompt } from '../../src/renderer/src/update-prompt'
import type { UpdateState } from '../../src/shared/types'

/** Render the bar with main's pushes in the test's hands. */
function renderBar(initial: UpdateState): { push: (s: UpdateState) => void; onOpenAbout: () => void } {
  const pushed: { cb: ((s: UpdateState) => void) | null } = { cb: null }
  vi.mocked(window.cockpit.onUpdateState).mockImplementation((cb) => {
    pushed.cb = cb
    return () => {}
  })
  vi.mocked(window.cockpit.getUpdateState).mockResolvedValue(initial)
  const onOpenAbout = vi.fn()
  render(<UpdateBar onOpenAbout={onOpenAbout} />)
  return { push: (s) => act(() => pushed.cb?.(s)), onOpenAbout }
}

describe('updatePrompt', () => {
  it('has nothing to say unless an update needs you', () => {
    expect(updatePrompt({ status: 'unsupported', message: 'dev run' }, null)).toBeNull()
    expect(updatePrompt({ status: 'up-to-date', checkedAt: 1 }, null)).toBeNull()
    expect(updatePrompt({ status: 'idle' }, null)).toBeNull()
    // a failed check names no version: offline for an afternoon is not worth a bar
    expect(updatePrompt({ status: 'error', message: 'offline' }, null)).toBeNull()
  })

  it('holds a downloaded build through the check that runs with it on disk', () => {
    const ready = updatePrompt({ status: 'ready', version: '1.5.0' }, null)
    expect(updatePrompt({ status: 'checking' }, ready)).toBe(ready)
    expect(updatePrompt({ status: 'checking' }, null)).toBeNull()
  })

  it('sends a rolled-back install to why, rather than offering the build again', () => {
    expect(updatePrompt({ status: 'available', version: '1.5.0', installFailure: 'copy failed' }, null)).toEqual({
      kind: 'failed',
      reason: 'copy failed'
    })
    // a build downloaded again by hand is still one click from a restart
    expect(updatePrompt({ status: 'ready', version: '1.5.0', installFailure: 'copy failed' }, null)?.kind).toBe('ready')
  })
})

describe('UpdateBar', () => {
  it('stays out of the footer in a build that cannot update', async () => {
    renderBar({ status: 'unsupported', message: 'Updates apply to installed builds only' })
    await act(async () => {})
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('restarts into a downloaded build in one click', async () => {
    renderBar({ status: 'ready', version: '1.5.0' })
    await userEvent.click(await screen.findByRole('button', { name: 'Restart to update Cockpit to 1.5.0' }))
    expect(window.cockpit.installUpdate).toHaveBeenCalledWith(undefined)
  })

  it('asks first when the restart would stop turns Cockpit is running', async () => {
    vi.mocked(window.cockpit.installUpdate).mockResolvedValueOnce({ restarting: false, runningTurns: 2 })
    renderBar({ status: 'ready', version: '1.5.0' })
    await userEvent.click(await screen.findByRole('button', { name: /Restart to update/ }))

    const confirm = await screen.findByRole('button', { name: 'Confirm: restarting stops 2 turns Cockpit is running' })
    expect(confirm).toHaveTextContent('Stop 2 turns and restart?')
    expect(screen.getByRole('status')).toHaveTextContent('press again to restart anyway')

    // Escape backs out, and the next click asks main again rather than assuming
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: /Restart to update/ })).toBeInTheDocument()

    vi.mocked(window.cockpit.installUpdate).mockResolvedValueOnce({ restarting: false, runningTurns: 1 })
    await userEvent.click(screen.getByRole('button', { name: /Restart to update/ }))
    await userEvent.click(await screen.findByRole('button', { name: /stops 1 turn Cockpit/ }))
    expect(window.cockpit.installUpdate).toHaveBeenLastCalledWith({ stopRunning: true })
  })

  it('follows the updater from an offer through the download to the restart', async () => {
    const { push } = renderBar({ status: 'idle' })
    await act(async () => {})
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    // auto-download off: the offer waits for a click
    push({ status: 'available', version: '1.5.0', checkedAt: 1 })
    expect(screen.getByRole('status')).toHaveTextContent('Cockpit 1.5.0 is available')
    await userEvent.click(screen.getByRole('button', { name: 'Download Cockpit 1.5.0' }))
    expect(window.cockpit.downloadUpdate).toHaveBeenCalled()

    push({ status: 'downloading', version: '1.5.0', percent: 42 })
    expect(screen.getByRole('button', { name: /Downloading Cockpit 1.5.0/ })).toHaveTextContent('42%')

    push({ status: 'ready', version: '1.5.0' })
    expect(screen.getByRole('status')).toHaveTextContent('Cockpit 1.5.0 is ready — restart to update')
    // the four-hourly check runs with the build on disk, and the bar holds through it
    push({ status: 'checking' })
    expect(screen.getByRole('button', { name: 'Restart to update Cockpit to 1.5.0' })).toBeInTheDocument()
  })

  it('opens About for the reason when an update could not be installed', async () => {
    const { onOpenAbout } = renderBar({ status: 'error', version: '1.5.0', message: 'ENOSPC: no space left' })
    const bar = await screen.findByRole('button', { name: 'Cockpit 1.5.0 could not be installed — open About' })
    expect(bar).toHaveTextContent('Update failed')
    expect(bar).toHaveAttribute('title', 'ENOSPC: no space left')
    await userEvent.click(bar)
    expect(onOpenAbout).toHaveBeenCalled()
  })
})
