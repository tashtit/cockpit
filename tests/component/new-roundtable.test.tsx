import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewRoundtable } from '../../src/renderer/src/NewRoundtable'
import type { ModelEndpoint } from '../../src/shared/types'

/** Pick an option from the app's own Select (a button + listbox, never a native select). */
async function choose(trigger: HTMLElement, option: string | RegExp): Promise<void> {
  await userEvent.click(trigger)
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

const seat = (name: string): HTMLElement => screen.getByRole('group', { name: `${name} seat` })
/** A Select trigger is named "<label> <value>" — match on the label. */
const control = (name: string, label: string): HTMLElement =>
  within(seat(name)).getByRole('button', {
    // "model" must not also match "model provider"
    name: new RegExp(`^${name.replace('#', '\\#')} ${label} (?!provider)`)
  })

const createdSeats = () => vi.mocked(window.cockpit.createRoundtable).mock.calls[0][0].seats

beforeEach(() => window.localStorage.clear())

describe('NewRoundtable', () => {
  it('lays every seat out with its own agent, account, model provider and model', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    for (const name of ['Claude', 'Codex']) {
      const card = seat(name)
      // every choice is visible and labelled, even with nothing configured to choose from
      for (const label of ['Agent', 'Account', 'Model provider', 'Model']) {
        expect(within(card).getByText(label)).toBeInTheDocument()
      }
    }
    // the model is a picker over every model the agent offers — never a text field
    expect(screen.queryByRole('textbox', { name: /model/i })).not.toBeInTheDocument()
    await userEvent.click(control('Codex', 'model'))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'default model',
      expect.stringContaining('GPT-5.6-Sol'),
      expect.stringContaining('GPT-5.5')
    ])
    await userEvent.keyboard('{Escape}')
    await choose(control('Claude', 'model'), /^opus/)
    expect(control('Claude', 'model')).toHaveTextContent('opus')
    // the listing is asked for per agent and account home
    expect(window.cockpit.listAgentModels).toHaveBeenCalledWith('codex', undefined)
    // the account stays a read-only field when there is one — same shape as a Select
    await waitFor(() => expect(within(seat('Claude')).getByText('not signed in')).toHaveClass('ns-account-single'))
  })

  it('switches a seat to a different agent, and picks from that agent’s models', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    await choose(control('Codex', 'model'), /^GPT-5\.5/)
    await choose(control('Codex', 'agent'), 'Copilot')
    expect(screen.queryByRole('group', { name: 'Codex seat' })).not.toBeInTheDocument()

    // the codex model did not follow the seat to another agent
    expect(control('Copilot', 'model')).toHaveTextContent('default model')
    await choose(control('Copilot', 'model'), /^auto/)
    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Open roundtable' }))
    await waitFor(() => expect(window.cockpit.createRoundtable).toHaveBeenCalled())
    expect(createdSeats()).toEqual([
      expect.objectContaining({ provider: 'claude', model: undefined }),
      expect.objectContaining({ provider: 'copilot', model: 'auto' })
    ])
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
    await waitFor(() => control('Claude #1', 'model provider'))
    await choose(control('Claude #1', 'model provider'), 'Gateway')
    await choose(control('Claude #1', 'model'), 'big')
    // an anthropic-type provider cannot run Codex: the column stays, inert
    expect(within(seat('Codex')).getByText('Codex (own)')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Open roundtable' }))
    await waitFor(() => expect(window.cockpit.createRoundtable).toHaveBeenCalled())
    expect(createdSeats()).toEqual([
      expect.objectContaining({ provider: 'claude', modelEndpoint: 'ep-a', model: 'big' }),
      expect.objectContaining({ provider: 'codex', modelEndpoint: undefined }),
      expect.objectContaining({ provider: 'claude', modelEndpoint: undefined, model: undefined })
    ])
  })

  it('seats an exact duplicate only once it is confirmed as deliberate', async () => {
    const onCreated = vi.fn()
    render(<NewRoundtable repos={[]} onCreated={onCreated} onCancel={() => {}} />)
    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    const open = screen.getByRole('button', { name: 'Open roundtable' })
    expect(open).toBeEnabled()

    await userEvent.click(screen.getByRole('button', { name: 'Add Claude seat' }))
    // only the later seat of the identical pair carries the mark
    expect(within(seat('Claude #2')).getByText('duplicate')).toBeInTheDocument()
    expect(within(seat('Claude #1')).queryByText('duplicate')).not.toBeInTheDocument()
    expect(open).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Seat the duplicate on purpose' }))
    expect(open).toBeEnabled()

    // a different model makes it a different voice — no mark, nothing to confirm
    await choose(control('Claude #2', 'model'), /^haiku/)
    expect(screen.queryByText('duplicate')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    await userEvent.click(open)
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('rt-1'))
  })

  it('sets this table’s spending limits on the same page, and shows what a message costs', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    const limits = screen.getByRole('group', { name: 'Roundtable spending limits' })
    expect(screen.getByText(/costs 2 agent turns — one per seat/)).toBeInTheDocument()
    expect(screen.getByText(/stops at 80 turns — about 40 messages/)).toBeInTheDocument()

    // 3 seats on 6 turns a message: two rounds at most, whatever the cap asked for
    await userEvent.click(screen.getByRole('button', { name: 'Add Copilot seat' }))
    await choose(within(limits).getByRole('button', { name: /^Agent turns per message/ }), '8 turns')
    await choose(screen.getByRole('button', { name: /^Goal/ }), 'Reach an understanding')
    expect(screen.getByText(/up to 6 agent turns — 3 seats × 2 rounds,/)).toBeInTheDocument()
    await choose(within(limits).getByRole('button', { name: /^Agent turns for the table/ }), 'no ceiling')
    expect(screen.getByText(/No ceiling for the whole table/)).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Open roundtable' }))
    await waitFor(() =>
      expect(window.cockpit.createRoundtable).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'consensus',
          maxRounds: 2,
          limits: { maxTurnsPerMessage: 8, maxTurnsPerTable: 0 }
        })
      )
    )
    // the next table starts from what was chosen here
    expect(JSON.parse(window.localStorage.getItem('cockpit:rt-limits')!)).toEqual({
      maxTurnsPerMessage: 8,
      maxTurnsPerTable: 0
    })
  })

  it('needs a topic and at least two seats, and stops adding at eight', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    const open = screen.getByRole('button', { name: 'Open roundtable' })
    await userEvent.type(screen.getByLabelText('Topic'), 'tabs or spaces')
    expect(open).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Codex seat' }))
    expect(open).toBeDisabled()

    for (let i = 0; i < 7; i++) {
      await userEvent.click(screen.getByRole('button', { name: 'Add Codex seat' }))
    }
    expect(screen.getByRole('button', { name: 'Add Claude seat' })).toBeDisabled()
    // discussion-only: the form offers no permission mode at all
    expect(screen.queryByText(/YOLO/i)).not.toBeInTheDocument()
  })
})
