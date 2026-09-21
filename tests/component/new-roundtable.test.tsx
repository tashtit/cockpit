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
      for (const label of ['Model', 'Thinking', 'Account', 'Model provider']) {
        expect(within(card).getByText(label)).toBeInTheDocument()
      }
      // the agent is the card's title, and a picker in its own right
      expect(within(card).getByRole('button', { name: new RegExp(`^${name} agent ${name}`) })).toBeInTheDocument()
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
    expect(screen.queryByRole('checkbox', { name: /on purpose/ })).not.toBeInTheDocument()

    await userEvent.click(open)
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('rt-1'))
  })

  it('sets this table’s spending limits on the same page, and shows what a message costs', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    // the bill rides the footer beside Open, whatever else is on screen
    expect(document.querySelector('.rt-footer')).toHaveTextContent('2 seats · 2 agent turns a message')
    const limits = screen.getByRole('group', { name: 'Roundtable spending limits' })
    expect(screen.getByText(/costs 2 agent turns — one per seat/)).toBeInTheDocument()
    expect(screen.getByText(/stops at 80 turns — about 40 messages/)).toBeInTheDocument()

    // 3 seats on 6 turns a message: two rounds at most, whatever the cap asked for
    await userEvent.click(screen.getByRole('button', { name: 'Add Copilot seat' }))
    await choose(within(limits).getByRole('button', { name: /^Agent turns per message/ }), '8 turns')
    await choose(screen.getByRole('button', { name: /^Goal/ }), 'Reach an understanding')
    expect(screen.getByText(/up to 6 agent turns — 3 seats × 2 rounds,/)).toBeInTheDocument()
    expect(document.querySelector('.rt-footer')).toHaveTextContent('3 seats · up to 6 agent turns a message')
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

  it('offers the thinking levels the chosen model takes, and each agent’s own knob', async () => {
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    await choose(control('Codex', 'model'), /^GPT-5\.6-Sol/)
    // the model's own list and default, straight from codex's catalog
    expect(control('Codex', 'thinking')).toHaveTextContent('default · low')
    await choose(control('Codex', 'thinking'), 'ultra')
    // only codex has a fast tier; only copilot a context tier; claude has neither —
    // each is on or off, so each is a checkbox on the seat's own card
    await userEvent.click(within(seat('Codex')).getByRole('checkbox', { name: /fast/ }))
    expect(within(seat('Claude')).queryByRole('checkbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add Copilot seat' }))
    await userEvent.click(within(seat('Copilot')).getByRole('checkbox', { name: 'long context' }))
    await choose(control('Claude', 'thinking'), 'max')

    // a model that does not take "ultra" drops the choice rather than sending it
    await choose(control('Codex', 'model'), /^GPT-5\.5/)
    expect(control('Codex', 'thinking')).toHaveTextContent('default · medium')
    await choose(control('Codex', 'model'), /^GPT-5\.6-Sol/)

    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Open roundtable' }))
    await waitFor(() => expect(window.cockpit.createRoundtable).toHaveBeenCalled())
    expect(createdSeats()).toEqual([
      expect.objectContaining({ provider: 'claude', effort: 'max', fast: undefined }),
      expect.objectContaining({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra', fast: true }),
      expect.objectContaining({ provider: 'copilot', longContext: true, effort: undefined })
    ])
  })

  it('copies a seat as a marked twin, and brings the seating back next time', async () => {
    const first = render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    await choose(control('Claude', 'model'), /^opus/)
    await choose(control('Claude', 'thinking'), 'high')
    await userEvent.click(screen.getByRole('button', { name: 'Copy Claude seat' }))
    // the copy sits right after its original, set up the same — so it is a duplicate
    expect(control('Claude #2', 'model')).toHaveTextContent('opus')
    expect(control('Claude #2', 'thinking')).toHaveTextContent('high')
    expect(within(seat('Claude #2')).getByText('duplicate')).toBeInTheDocument()
    await choose(control('Claude #2', 'thinking'), 'low')
    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Open roundtable' }))
    await waitFor(() => expect(window.cockpit.createRoundtable).toHaveBeenCalled())
    first.unmount()

    // a new form starts from that seating: the topic is all that is left to write
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    expect(screen.getByLabelText('Topic')).toHaveFocus()
    expect(control('Claude #1', 'thinking')).toHaveTextContent('high')
    expect(control('Claude #2', 'thinking')).toHaveTextContent('low')
    expect(seat('Codex')).toBeInTheDocument()
  })

  it('shows a signed-out agent before the table starts, and opens once it is fixed', async () => {
    let claude: 'signed-out' | 'signed-in' = 'signed-out'
    vi.mocked(window.cockpit.signInState).mockImplementation(async (provider) =>
      provider === 'claude' ? claude : 'signed-in'
    )
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    // said on the add pill before any seat is added, and on the seated card
    expect(await screen.findByRole('button', { name: 'Add Claude seat (signed out)' })).toBeInTheDocument()
    expect(await within(seat('Claude')).findByText('signed out')).toBeInTheDocument()
    expect(within(seat('Claude')).getByRole('alert')).toHaveTextContent(
      /The Claude app keeps its own sign-in.*Run claude auth login in a terminal/
    )
    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    const open = screen.getByRole('button', { name: 'Open roundtable' })
    expect(open).toBeDisabled()
    expect(document.querySelector('.rt-footer')).toHaveTextContent('Claude can’t run')

    // signed in at a terminal, then Recheck: the seat clears and the table can open
    claude = 'signed-in'
    await userEvent.click(within(seat('Claude')).getByRole('button', { name: 'Recheck' }))
    await waitFor(() => expect(within(seat('Claude')).queryByText('signed out')).not.toBeInTheDocument())
    expect(open).toBeEnabled()
  })

  it('holds Open for a seat whose CLI is not installed, and while seats are being checked', async () => {
    let resolveCodex: (s: 'missing') => void = () => {}
    vi.mocked(window.cockpit.signInState).mockImplementation(async (provider) =>
      provider === 'codex' ? new Promise((r) => (resolveCodex = r)) : 'signed-in'
    )
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    await userEvent.type(screen.getByLabelText('Topic'), 'x')
    const open = screen.getByRole('button', { name: 'Open roundtable' })
    // an answer still out is not a green light
    await waitFor(() => expect(document.querySelector('.rt-footer')).toHaveTextContent('Checking the seats can run'))
    expect(open).toBeDisabled()
    resolveCodex('missing')
    expect(await within(seat('Codex')).findByText('not installed')).toBeInTheDocument()
    expect(within(seat('Codex')).getByRole('alert')).toHaveTextContent(/can’t find the codex command/)
    expect(open).toBeDisabled()
  })

  it('signs a seat in from the form, and clears it once Terminal is done', async () => {
    let claude: 'signed-out' | 'signed-in' = 'signed-out'
    vi.mocked(window.cockpit.signInState).mockImplementation(async (provider) =>
      provider === 'claude' ? claude : 'signed-in'
    )
    render(<NewRoundtable repos={[]} onCreated={vi.fn()} onCancel={() => {}} />)
    await userEvent.click(await within(seat('Claude')).findByRole('button', { name: 'Sign in…' }))
    expect(window.cockpit.openSignIn).toHaveBeenCalledWith('claude', undefined)
    expect(within(seat('Claude')).getByRole('alert')).toHaveTextContent(/Finish signing in in the Terminal window/)

    // the person signs in; coming back to the window is enough — no Recheck to press
    claude = 'signed-in'
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(within(seat('Claude')).queryByText('signed out')).not.toBeInTheDocument())
  })
})
