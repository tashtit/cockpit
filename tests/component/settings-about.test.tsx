import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../src/renderer/src/Settings'
import type { AppInfo, UpdateState } from '../../src/shared/types'

const installed: AppInfo = {
  version: '1.4.2',
  packaged: true,
  platform: 'darwin',
  arch: 'arm64',
  electron: '44.2.0',
  releasesUrl: 'https://github.com/tashtit/cockpit/releases'
}

describe('Settings › About', () => {
  it('shows the installed version and checks for updates on demand', async () => {
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'idle' })
    vi.mocked(window.cockpit.checkForUpdates).mockResolvedValue({
      status: 'available',
      version: '1.5.0',
      checkedAt: Date.now()
    })
    render(<Settings onClose={vi.fn()} />)

    expect(await screen.findByText('v1.4.2')).toBeInTheDocument()
    expect(screen.getByText('installed · arm64')).toBeInTheDocument()
    expect(screen.getByText('Not checked yet.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(window.cockpit.checkForUpdates).toHaveBeenCalled()
    expect(await screen.findByText('Version 1.5.0 is available.')).toBeInTheDocument()

    // the offer is a button, never a silent download
    await userEvent.click(screen.getByRole('button', { name: 'Download 1.5.0' }))
    expect(window.cockpit.downloadUpdate).toHaveBeenCalled()
  })

  it('follows pushed state from download progress to restart', async () => {
    const pushed: { cb: ((s: UpdateState) => void) | null } = { cb: null }
    vi.mocked(window.cockpit.onUpdateState).mockImplementation((cb) => {
      pushed.cb = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'idle' })
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('v1.4.2')

    act(() => pushed.cb?.({ status: 'downloading', version: '1.5.0', percent: 42 }))
    expect(screen.getByText('Downloading 1.5.0 · 42%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled()

    act(() => pushed.cb?.({ status: 'ready', version: '1.5.0' }))
    expect(screen.getByRole('status')).toHaveTextContent('1.5.0 downloaded')
    await userEvent.click(screen.getByRole('button', { name: 'Restart to install' }))
    expect(window.cockpit.installUpdate).toHaveBeenCalled()
  })

  it('reports a failed check without hiding the retry', async () => {
    const pushed: { cb: ((s: UpdateState) => void) | null } = { cb: null }
    vi.mocked(window.cockpit.onUpdateState).mockImplementation((cb) => {
      pushed.cb = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'idle' })
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('v1.4.2')

    act(() => pushed.cb?.({ status: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' }))
    expect(screen.getByText(/Update check failed: net::ERR_INTERNET_DISCONNECTED/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  })

  it('explains that a development run cannot update, with no controls to press', async () => {
    // the stub's defaults are the dev-run shape: 0.0.0, not packaged, unsupported
    render(<Settings onClose={vi.fn()} />)
    expect(await screen.findByText('v0.0.0')).toBeInTheDocument()
    expect(screen.getByText('development run')).toBeInTheDocument()
    expect(screen.getByText(/installed builds only/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull()
  })

  it('opens the release notes externally', async () => {
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    render(<Settings onClose={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Release notes' }))
    expect(window.cockpit.openExternal).toHaveBeenCalledWith(installed.releasesUrl)
  })
})
