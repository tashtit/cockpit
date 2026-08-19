import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewRoundtable } from '../../src/renderer/src/NewRoundtable'

describe('NewRoundtable', () => {
  it('needs a topic and at least two seats before it can open', async () => {
    const onCreated = vi.fn()
    render(<NewRoundtable repos={[]} onCreated={onCreated} onCancel={() => {}} />)

    // claude + codex are seated by default; the cards ADD seats now
    expect(screen.getByRole('group', { name: 'Add seats' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Claude model' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Codex model' })).toBeInTheDocument()

    const open = screen.getByRole('button', { name: 'Open roundtable' })
    expect(open).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Topic'), 'tabs or spaces')
    expect(open).toBeEnabled()

    // dropping to one seat disarms the form again
    await userEvent.click(screen.getByRole('button', { name: 'Remove Codex seat' }))
    expect(open).toBeDisabled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('seats the same provider twice with different models and hands over the id', async () => {
    const onCreated = vi.fn()
    render(<NewRoundtable repos={[]} onCreated={onCreated} onCancel={() => {}} />)

    // a second Claude seat joins the default pair; twin rows get ordinals
    await userEvent.click(screen.getByRole('button', { name: 'Add Claude seat' }))
    expect(screen.getByText('Claude #1')).toBeInTheDocument()
    expect(screen.getByText('Claude #2')).toBeInTheDocument()

    await userEvent.type(screen.getByRole('combobox', { name: 'Claude #1 model' }), 'opus')
    await userEvent.type(screen.getByRole('combobox', { name: 'Claude #2 model' }), 'haiku')
    await userEvent.type(screen.getByLabelText('Topic'), 'depth or speed?')
    await userEvent.click(screen.getByRole('button', { name: 'Open roundtable' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('rt-1'))
    expect(window.cockpit.createRoundtable).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'depth or speed?',
        repoRoot: null,
        seats: [
          expect.objectContaining({ provider: 'claude', model: 'opus' }),
          expect.objectContaining({ provider: 'codex', model: undefined }),
          expect.objectContaining({ provider: 'claude', model: 'haiku' })
        ]
      })
    )
    // discussion-only: the form offers no permission mode at all
    expect(screen.queryByText(/YOLO/i)).not.toBeInTheDocument()
  })

  it('caps the table at four seats', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add Copilot seat' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add Claude seat' }))
    // four seated — the add cards disarm
    expect(screen.getByRole('button', { name: 'Add Codex seat' })).toBeDisabled()
  })
})
