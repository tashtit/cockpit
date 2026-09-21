import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewRoundtable } from '../../src/renderer/src/NewRoundtable'
import { DEFAULT_ROUNDTABLE_LIMITS } from '../../src/shared/roundtable'
import type { ModelEndpoint } from '../../src/shared/types'

/** Pick an option from the app's own Select (a button + listbox, never a native select). */
async function choose(trigger: HTMLElement, option: string): Promise<void> {
  await userEvent.click(trigger)
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

describe('NewRoundtable', () => {
  it('keeps a one-account seat the same shape as a seat that can choose', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    const acct = await waitFor(() => document.querySelector('.rt-seat-cfg-acct')!)
    // the read-only field is trigger-shaped, the same recipe NewSession uses
    expect(acct.className).toContain('ns-account-single')
  })

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

  it('gives every seat its own model provider, and a model from that provider’s catalog', async () => {
    const gateway: ModelEndpoint = {
      id: 'ep-a',
      label: 'Gateway',
      type: 'anthropic',
      baseUrl: 'https://gw.example/v1',
      models: ['big', 'small']
    }
    vi.mocked(window.cockpit.getModelEndpoints).mockResolvedValue([gateway])
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: 'Add Claude seat' }))

    // only the first Claude moves to the gateway; its twin stays on Claude's own backend
    await choose(await screen.findByRole('button', { name: /^Claude #1 model provider/ }), 'Gateway')
    await choose(screen.getByRole('button', { name: /^Claude #1 model (?!provider)/ }), 'big')
    // an anthropic-type provider cannot run Codex: the column stays, inert
    expect(screen.queryByRole('button', { name: /^Codex model provider/ })).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Open roundtable' }))
    await waitFor(() => expect(window.cockpit.createRoundtable).toHaveBeenCalled())
    expect(vi.mocked(window.cockpit.createRoundtable).mock.calls[0][0].seats).toEqual([
      expect.objectContaining({ provider: 'claude', modelEndpoint: 'ep-a', model: 'big' }),
      expect.objectContaining({ provider: 'codex', modelEndpoint: undefined }),
      expect.objectContaining({ provider: 'claude', modelEndpoint: undefined, model: undefined })
    ])
  })

  it('allows an identical seat, and marks it so it is a choice', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    expect(screen.queryByText('duplicate')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add Claude seat' }))
    // the second Claude repeats the first exactly — only the later seat carries the mark
    expect(screen.getAllByText('duplicate')).toHaveLength(1)
    expect(screen.getByText(/at the full cost of a seat/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    expect(screen.getByRole('button', { name: 'Open roundtable' })).toBeEnabled()

    // a different model makes it a different voice
    await userEvent.type(screen.getByRole('combobox', { name: 'Claude #2 model' }), 'haiku')
    expect(screen.queryByText('duplicate')).not.toBeInTheDocument()
  })

  it('shows what a message will cost and holds the round cap to the limits', async () => {
    vi.mocked(window.cockpit.getRoundtableLimits).mockResolvedValue({
      ...DEFAULT_ROUNDTABLE_LIMITS,
      maxSeats: 6,
      maxTurnsPerMessage: 6
    })
    const onOpenLimits = vi.fn()
    render(
      <NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} onOpenLimits={onOpenLimits} />
    )
    expect(await screen.findByText(/costs 2 agent turns — one per seat/)).toBeInTheDocument()
    expect(screen.getByText(/Limits: 6 seats, 6 turns a message, 80 turns a table/)).toBeInTheDocument()

    // six seats fit now; the cards disarm at the limit, not at four
    for (const _ of [1, 2, 3, 4]) {
      await userEvent.click(screen.getByRole('button', { name: 'Add Codex seat' }))
    }
    expect(screen.getByRole('button', { name: 'Add Codex seat' })).toBeDisabled()

    // 6 seats × 6 turns a message = one round: consensus cannot ask for more
    await choose(screen.getByRole('button', { name: /^Goal/ }), 'Reach an understanding')
    expect(screen.getByText(/up to 6 agent turns — 6 seats × 1 round,/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Open roundtable' }))
    await waitFor(() =>
      expect(window.cockpit.createRoundtable).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'consensus', maxRounds: 1 })
      )
    )

    await userEvent.click(screen.getByRole('button', { name: 'Change limits' }))
    expect(onOpenLimits).toHaveBeenCalled()
  })
})
