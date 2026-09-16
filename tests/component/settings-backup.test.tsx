import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../src/renderer/src/Settings'
import type { BackupPreview, RestoreSummary } from '../../src/shared/types'

const preview = (over: Partial<BackupPreview> = {}): BackupPreview => ({
  token: 'tok',
  createdAt: '2026-09-16T10:00:00.000Z',
  appVersion: '1.2.3',
  sealed: false,
  counts: { scopes: 2, entries: 4, skills: 1, endpoints: 1, sessions: 3 },
  unmatched: [],
  commands: [],
  ...over
})

const summary = (over: Partial<RestoreSummary> = {}): RestoreSummary => ({
  added: { entries: 4, skills: 1, endpoints: 1, sources: 0, instructions: 0 },
  kept: [],
  skipped: [],
  needsValues: [],
  undoId: 'undo-1',
  ...over
})

const exportButton = (): HTMLElement => screen.getByRole('button', { name: 'Export backup…' })

describe('Settings › Backup', () => {
  it('will not export until both passphrases match and are long enough', async () => {
    render(<Settings onClose={vi.fn()} />)

    // no passphrase at all is a valid choice — the button is live from the start
    expect(await screen.findByLabelText('Passphrase · optional')).toBeInTheDocument()
    expect(exportButton()).toBeEnabled()

    await userEvent.type(screen.getByLabelText('Passphrase · optional'), 'correct horse')
    expect(exportButton()).toBeDisabled()
    expect(screen.getByText("The two passphrases don't match yet.")).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Repeat passphrase'), 'correct hor')
    expect(exportButton()).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Repeat passphrase'), 'se')
    expect(exportButton()).toBeEnabled()

    vi.mocked(window.cockpit.exportBackup).mockResolvedValue({
      path: '/Users/me/Downloads/cockpit-backup.json',
      counts: { scopes: 1, entries: 2, skills: 1, endpoints: 0, sessions: 0 },
      secretsIncluded: true,
      withheld: [],
      unreadableKeys: 0,
      skippedFiles: 0
    })
    await userEvent.click(exportButton())
    expect(window.cockpit.exportBackup).toHaveBeenCalledWith('correct horse')
    // once as the visible outcome line, once in the card's sr-only status region
    expect(
      await screen.findAllByText(/Backup written to \/Users\/me\/Downloads\/cockpit-backup.json/)
    ).toHaveLength(2)
  })

  it('refuses a passphrase shorter than the minimum', async () => {
    render(<Settings onClose={vi.fn()} />)
    await userEvent.type(await screen.findByLabelText('Passphrase · optional'), 'short')
    await userEvent.type(screen.getByLabelText('Repeat passphrase'), 'short')
    expect(exportButton()).toBeDisabled()
    expect(screen.getByText('A passphrase needs at least 8 characters.')).toBeInTheDocument()
  })

  it('previews a chosen file, restores it, then offers an undo', async () => {
    vi.mocked(window.cockpit.openBackup).mockResolvedValue(
      preview({ unmatched: ['gh:owner/other'], commands: ['npx'] })
    )
    vi.mocked(window.cockpit.restoreBackup).mockResolvedValue(
      summary({ needsValues: ['github in global — TOKEN'] })
    )
    render(<Settings onClose={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Choose backup…' }))
    expect(await screen.findByText(/4 library entries · 1 skills · 1 providers/)).toBeInTheDocument()
    expect(screen.getByText(/MCP servers it would add run: npx/)).toBeInTheDocument()
    expect(screen.getByText(/No repo here for gh:owner\/other/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(window.cockpit.restoreBackup).toHaveBeenCalledWith('tok', undefined)
    expect(
      await screen.findAllByText('Restored 4 library entries, 1 skills, 1 providers')
    ).toHaveLength(2)
    expect(
      screen.getByText(/Needs values before it can be switched on: github in global — TOKEN/)
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Undo this restore' }))
    expect(window.cockpit.undoRestore).toHaveBeenCalledWith('undo-1')
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Restore undone — settings are back as they were'
    )
  })

  it('asks for the passphrase of a sealed file and keeps it open when it is wrong', async () => {
    vi.mocked(window.cockpit.openBackup).mockResolvedValue(preview({ sealed: true }))
    vi.mocked(window.cockpit.restoreBackup).mockRejectedValue(
      new Error('wrong passphrase or damaged backup')
    )
    render(<Settings onClose={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Choose backup…' }))
    const restore = await screen.findByRole('button', { name: 'Restore' })
    expect(restore).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Passphrase for this backup'), 'nope nope nope')
    await userEvent.click(restore)
    expect(await screen.findByRole('alert')).toHaveTextContent('wrong passphrase or damaged backup')
    // still open: the user only has to fix the passphrase, not find the file again
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })
})
