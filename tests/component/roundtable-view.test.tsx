import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RoundtableView } from '../../src/renderer/src/RoundtableView'
import { emptyRoundtable } from './stub-api'
import type { RoundtableEvent, RoundtableSnapshot } from '../../src/shared/types'

function fixture(overrides: Partial<RoundtableSnapshot> = {}): RoundtableSnapshot {
  return {
    ...emptyRoundtable(),
    id: 'rt-1',
    title: 'adopt biome?',
    topic: 'adopt biome?',
    branch: 'cockpit/table-adopt-biome',
    participants: [
      { provider: 'claude', nativeSessionId: 'c1', seenUpTo: 2, accountLabel: 'me@x' },
      { provider: 'codex', nativeSessionId: 'x1', seenUpTo: 3 }
    ],
    entries: [
      { speaker: 'user', text: 'adopt biome?', at: 1 },
      { speaker: 'claude', text: 'I lean yes — one tool.', at: 2, seat: 0 },
      { speaker: 'codex', text: 'Benchmarks first.', at: 3, seat: 1 }
    ],
    ...overrides
  }
}

describe('RoundtableView', () => {
  it('renders the shared transcript with per-agent attribution', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(fixture())
    render(<RoundtableView id="rt-1" />)

    await waitFor(() => expect(screen.getByText('adopt biome?', { selector: 'pre' })).toBeInTheDocument())
    expect(screen.getByText('Roundtable')).toBeInTheDocument()
    expect(screen.getByText('I lean yes — one tool.')).toBeInTheDocument()
    expect(screen.getByText('Benchmarks first.')).toBeInTheDocument()
    // speaker attribution lines carry the agent names
    expect(screen.getByText('Claude', { selector: '.rt-speaker' })).toBeInTheDocument()
    expect(screen.getByText('Codex', { selector: '.rt-speaker' })).toBeInTheDocument()
    // idle table: send + one-more-round available
    expect(screen.getByRole('button', { name: 'One more round' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('sends a user message and can run another round', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(fixture())
    render(<RoundtableView id="rt-1" />)
    await waitFor(() => expect(screen.getByRole('textbox')).toBeInTheDocument())

    await userEvent.type(screen.getByRole('textbox'), 'what about CI time?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(window.cockpit.sendRoundtableMessage).toHaveBeenCalledWith('rt-1', 'what about CI time?')

    await userEvent.click(screen.getByRole('button', { name: 'One more round' }))
    expect(window.cockpit.continueRoundtable).toHaveBeenCalledWith('rt-1')
  })

  it('a running round shows the speaking seat and swaps Send for Stop', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({ running: true, speaking: [1] })
    )
    render(<RoundtableView id="rt-1" />)

    await waitFor(() => expect(screen.getByText('Codex is thinking…')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'One more round' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(window.cockpit.stopRoundtable).toHaveBeenCalledWith('rt-1')
  })

  it('appends streamed entries from events, deduping against the snapshot', async () => {
    let handler: ((ev: RoundtableEvent) => void) | null = null
    vi.mocked(window.cockpit.onRoundtableEvent).mockImplementation((cb) => {
      handler = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(fixture())
    render(<RoundtableView id="rt-1" />)
    await waitFor(() => expect(screen.getByText('Benchmarks first.')).toBeInTheDocument())

    act(() => {
      // an entry the snapshot already carried must not render twice
      handler!({
        id: 'rt-1',
        type: 'entry',
        index: 2,
        entry: { speaker: 'codex', text: 'Benchmarks first.', at: 3, seat: 1 }
      })
      handler!({
        id: 'rt-1',
        type: 'entry',
        index: 3,
        entry: { speaker: 'claude', text: 'Fresh point.', at: 4, seat: 0 }
      })
      // events for another table are not ours
      handler!({
        id: 'rt-other',
        type: 'entry',
        index: 0,
        entry: { speaker: 'codex', text: 'wrong table', at: 5, seat: 0 }
      })
    })

    expect(screen.getAllByText('Benchmarks first.')).toHaveLength(1)
    expect(screen.getByText('Fresh point.')).toBeInTheDocument()
    expect(screen.queryByText('wrong table')).not.toBeInTheDocument()
  })

  it('a wave shows every thinking seat and streams them side by side', async () => {
    let handler: ((ev: RoundtableEvent) => void) | null = null
    vi.mocked(window.cockpit.onRoundtableEvent).mockImplementation((cb) => {
      handler = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({ running: true, speaking: [0, 1] })
    )
    render(<RoundtableView id="rt-1" />)
    await waitFor(() =>
      expect(screen.getByText('Claude and Codex are thinking…')).toBeInTheDocument()
    )

    // both seats stream at once, each into its own attributed live block
    act(() => {
      handler!({ id: 'rt-1', type: 'delta', speaker: 'claude', seat: 0, text: 'claude streaming' })
      handler!({ id: 'rt-1', type: 'delta', speaker: 'codex', seat: 1, text: 'codex streaming' })
    })
    await waitFor(() => expect(screen.getByText('claude streaming')).toBeInTheDocument())
    expect(screen.getByText('codex streaming')).toBeInTheDocument()

    // one seat finishing collapses only its own live block
    act(() => {
      handler!({
        id: 'rt-1',
        type: 'entry',
        index: 3,
        entry: { speaker: 'claude', text: 'claude final', at: 9, seat: 0 }
      })
      handler!({ id: 'rt-1', type: 'turn-end', speaker: 'claude', seat: 0 })
    })
    await waitFor(() => expect(screen.getByText('claude final')).toBeInTheDocument())
    expect(screen.queryByText('claude streaming')).not.toBeInTheDocument()
    expect(screen.getByText('codex streaming')).toBeInTheDocument()
    expect(screen.getByText('Codex is thinking…')).toBeInTheDocument()
  })

  it('a concluded cycle renders the app-assembled outcome from the seats\' own lines', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        mode: 'consensus',
        maxRounds: 3,
        roundsRun: 2,
        concluded: true,
        entries: [
          { speaker: 'user', text: 'adopt biome?', at: 1 },
          {
            speaker: 'claude',
            text: 'Yes — one tool.',
            at: 2,
            stance: 'agree',
            stanceNote: 'adopt biome behind a flag',
            seat: 0
          },
          {
            speaker: 'codex',
            text: 'Benchmarks first, then fine.',
            at: 3,
            stance: 'continue',
            stanceNote: 'CI time unproven',
            seat: 1
          }
        ]
      })
    )
    render(<RoundtableView id="rt-1" />)

    // a split table says so — and each seat's line is its own words, not a summary
    const outcome = await screen.findByRole('region', { name: 'Roundtable outcome' })
    expect(within(outcome).getByText('No full agreement')).toBeInTheDocument()
    expect(within(outcome).getByText('adopt biome behind a flag')).toBeInTheDocument()
    expect(within(outcome).getByText('CI time unproven')).toBeInTheDocument()
    expect(within(outcome).getByText('agrees')).toBeInTheDocument()
    expect(within(outcome).getByText('not yet')).toBeInTheDocument()
    expect(within(outcome).getByText(/2 rounds/)).toBeInTheDocument()
    // the in-transcript chips still mark each contribution
    expect(screen.getByText('· agrees')).toBeInTheDocument()
    expect(screen.getByText('· not yet')).toBeInTheDocument()
    // the table element mirrors the same states on its seats
    const tableEl = screen.getByLabelText('The table')
    expect(within(tableEl).getByText('agrees')).toBeInTheDocument()
    expect(within(tableEl).getByText('not yet')).toBeInTheDocument()
  })

  it('failed turns render as annotations, not contributions', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        entries: [
          { speaker: 'user', text: 'adopt biome?', at: 1 },
          { speaker: 'codex', text: 'codex CLI not found', at: 2, error: true }
        ]
      })
    )
    render(<RoundtableView id="rt-1" />)
    await waitFor(() =>
      expect(screen.getByText(/Codex turn failed: codex CLI not found/)).toBeInTheDocument()
    )
  })
})
