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

describe('RoundtableView header', () => {
  it('names a repo-backed table by its worktree, not by where worktrees live', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        repoRoot: '/Users/dev/code/rocket',
        branch: 'cockpit/table-adopt-biome',
        cwd: '/Users/dev/Library/Application Support/cockpit/worktrees/rocket/table-adopt-biome'
      })
    )
    render(<RoundtableView id="rt-1" />)
    // the branch chip beside it already says table-adopt-biome, so the label stays bare
    await waitFor(() =>
      expect(document.querySelector('.chat-cwd')).toHaveTextContent(/^worktree$/)
    )
    // the full path stays one hover and one click away
    expect(document.querySelector('.chat-cwd')).toHaveAttribute(
      'title',
      expect.stringContaining('Application Support')
    )
  })

  it("calls a repo-less table's room what the form called it", async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        repoRoot: null,
        branch: null,
        cwd: '/Users/dev/Library/Application Support/cockpit/roundtables/rt-1/room'
      })
    )
    render(<RoundtableView id="rt-1" />)
    await waitFor(() => expect(document.querySelector('.chat-cwd')).toHaveTextContent('scratch room'))
  })
})

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
    // no seats named: the whole table
    expect(window.cockpit.sendRoundtableMessage).toHaveBeenCalledWith('rt-1', 'what about CI time?', { seats: undefined, whenBusy: 'queue' })

    await userEvent.click(screen.getByRole('button', { name: 'One more round' }))
    expect(window.cockpit.continueRoundtable).toHaveBeenCalledWith('rt-1', undefined)
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

  it("a seat's live block keeps its text and tool calls in the order they happened", async () => {
    let handler: ((ev: RoundtableEvent) => void) | null = null
    vi.mocked(window.cockpit.onRoundtableEvent).mockImplementation((cb) => {
      handler = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(fixture({ running: true, speaking: [0] }))
    render(<RoundtableView id="rt-1" />)
    await waitFor(() => expect(screen.getByText('Claude is thinking…')).toBeInTheDocument())

    // one burst: the first passage is still in the text batch when the tool call arrives
    act(() => {
      handler!({ id: 'rt-1', type: 'delta', speaker: 'claude', seat: 0, text: 'Checking the ' })
      handler!({ id: 'rt-1', type: 'delta', speaker: 'claude', seat: 0, text: 'registry first.' })
      handler!({ id: 'rt-1', type: 'tool', speaker: 'claude', seat: 0, toolName: 'Bash', detail: 'npm view takt' })
      handler!({ id: 'rt-1', type: 'tool', speaker: 'claude', seat: 0, toolName: 'WebSearch', detail: 'takt software' })
      handler!({ id: 'rt-1', type: 'delta', speaker: 'claude', seat: 0, text: 'Takt is taken.' })
    })
    await waitFor(() => expect(screen.getByText('Takt is taken.')).toBeInTheDocument())

    const block = document.querySelector('.rt-live')!
    const order = [...block.children].map((el) =>
      el.classList.contains('tool-row')
        ? `tool: ${el.querySelector('summary')!.textContent}`
        : `text: ${el.querySelector('.streaming-plain')!.textContent}`
    )
    expect(order).toEqual([
      'text: Checking the registry first.',
      expect.stringMatching(/^tool: .*Bash.*npm view takt/),
      expect.stringMatching(/^tool: .*WebSearch.*takt software/),
      'text: Takt is taken.'
    ])
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

  it('a seat that never spoke reads as "no reply", never as dissent', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        mode: 'consensus',
        roundsRun: 1,
        concluded: true,
        entries: [
          { speaker: 'user', text: 'adopt biome?', at: 1 },
          { speaker: 'claude', text: 'Yes.', at: 2, stance: 'agree', stanceNote: 'adopt it', seat: 0 },
          // codex's CLI failed — silence is not a position
          { speaker: 'codex', text: 'codex exited with code 1', at: 3, error: true, seat: 1 }
        ]
      })
    )
    render(<RoundtableView id="rt-1" />)

    const outcome = await screen.findByRole('region', { name: 'Roundtable outcome' })
    expect(within(outcome).getByText('no reply')).toBeInTheDocument()
    expect(within(outcome).queryByText('not yet')).not.toBeInTheDocument()
    expect(within(outcome).getByText('(no reply this cycle)')).toBeInTheDocument()
    // a table nobody agreed on is still not a shared understanding
    expect(within(outcome).getByText('No full agreement')).toBeInTheDocument()
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

describe('RoundtableView spending limits', () => {
  it('shows what the table has spent and raises its ceiling in place', async () => {
    // two replies on record against a ceiling of three: a two-seat round no longer fits
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({ limits: { maxTurnsPerMessage: 16, maxTurnsPerTable: 3, maxTurnMinutes: 15 } })
    )
    vi.mocked(window.cockpit.setRoundtableLimits).mockImplementation(async (_id, limits) =>
      fixture({ limits })
    )
    render(<RoundtableView id="rt-1" />)

    const budget = await screen.findByRole('button', { name: '2 of 3 agent turns' })
    expect(budget).toHaveClass('spent')
    // said before the user tries — with the way on
    expect(screen.getByText(/another round would pass its ceiling/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Raise the limit' }))

    const editor = screen.getByRole('group', { name: 'Roundtable spending limits' })
    await userEvent.click(within(editor).getByRole('button', { name: /^Agent turns for the table/ }))
    await userEvent.click(await screen.findByRole('option', { name: '80 turns' }))
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(window.cockpit.setRoundtableLimits).toHaveBeenCalledWith(
      'rt-1',
      { maxTurnsPerMessage: 16, maxTurnsPerTable: 80, maxTurnMinutes: 15 },
      undefined
    )
    expect(await screen.findByRole('button', { name: '2 of 80 agent turns' })).not.toHaveClass('spent')
    expect(screen.queryByText(/another round would pass its ceiling/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Roundtable spending limits' })).not.toBeInTheDocument()
  })
})

describe('RoundtableView failed seats', () => {
  it('names the fix for a lapsed sign-in, and says why a consensus table stopped', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        mode: 'consensus',
        roundsRun: 1,
        concluded: false,
        entries: [
          { speaker: 'user', text: 'rename it?', at: 1 },
          {
            speaker: 'claude',
            seat: 0,
            text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
            at: 2,
            error: true
          },
          { speaker: 'codex', seat: 1, text: 'Orrery.', at: 3, stance: 'agree', stanceNote: 'Orrery' }
        ]
      })
    )
    render(<RoundtableView id="rt-1" />)
    expect(await screen.findByText('claude auth login')).toBeInTheDocument()
    expect(screen.getByText(/Stopped reaching an understanding — Claude couldn’t answer/)).toBeInTheDocument()
    // a stop is not an outcome: no ledger claims agreement or disagreement
    expect(screen.queryByText(/Shared understanding|No full agreement/)).not.toBeInTheDocument()
  })

  it('a failure that is not a sign-in gets no sign-in advice', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        entries: [
          { speaker: 'user', text: 'q', at: 1 },
          { speaker: 'codex', seat: 1, text: 'process exited with code 1', at: 2, error: true }
        ]
      })
    )
    render(<RoundtableView id="rt-1" />)
    expect(await screen.findByText(/Codex turn failed: process exited/)).toBeInTheDocument()
    expect(screen.queryByText(/sign in again/)).not.toBeInTheDocument()
    // an open table never runs rounds on its own, so there is nothing to stop
    expect(screen.queryByText(/Stopped reaching an understanding/)).not.toBeInTheDocument()
  })
})

describe('RoundtableView addressing seats', () => {
  it('sends to the seats left on, and says whom a message went to', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        entries: [
          { speaker: 'user', text: 'adopt biome?', at: 1 },
          { speaker: 'user', text: 'just codex', at: 2, to: [1] }
        ]
      })
    )
    render(<RoundtableView id="rt-1" />)
    // the caption on a message that went to part of the table
    expect(await screen.findByText('to Codex')).toBeInTheDocument()

    const toRow = screen.getByRole('group', { name: 'Send to' })
    await userEvent.click(within(toRow).getByRole('button', { name: 'Claude' }))
    expect(within(toRow).getByRole('button', { name: 'Claude' })).toHaveAttribute('aria-pressed', 'false')
    // the last seat on can't be switched off too — a message always reaches someone
    expect(within(toRow).getByRole('button', { name: 'Codex' })).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message the roundtable' }), 'your turn{Enter}')
    expect(window.cockpit.sendRoundtableMessage).toHaveBeenCalledWith('rt-1', 'your turn', { seats: [1], whenBusy: 'queue' })

    await userEvent.click(within(toRow).getByRole('button', { name: 'everyone' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Message the roundtable' }), 'all{Enter}')
    expect(window.cockpit.sendRoundtableMessage).toHaveBeenLastCalledWith('rt-1', 'all', { seats: undefined, whenBusy: 'queue' })
  })

  it('a table stopped by a failed seat offers to carry on without it', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({
        mode: 'consensus',
        concluded: false,
        entries: [
          { speaker: 'user', text: 'rename it?', at: 1 },
          { speaker: 'claude', seat: 0, text: 'Failed to authenticate: OAuth session expired', at: 2, error: true },
          { speaker: 'codex', seat: 1, text: 'Orrery.', at: 3, stance: 'agree' }
        ]
      })
    )
    render(<RoundtableView id="rt-1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'continue without Claude' }))
    expect(window.cockpit.continueRoundtable).toHaveBeenCalledWith('rt-1', [1])
    // and the composer now addresses the same seats
    expect(
      within(screen.getByRole('group', { name: 'Send to' })).getByRole('button', { name: 'Claude' })
    ).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('RoundtableView while a round runs', () => {
  it('a message typed mid-round waits for the round, or stops it and goes now', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({ running: true, speaking: [0], speakingSince: { 0: Date.now() - 180_000 } })
    )
    render(<RoundtableView id="rt-1" />)
    const box = await screen.findByRole('textbox', { name: 'Message the roundtable' })
    expect(box).toBeEnabled()
    // the stuck seat shows how long it has been at it, and can be skipped
    expect(await screen.findByText('Claude · 3m')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Skip Claude — go on without it' }))
    expect(window.cockpit.skipRoundtableSeat).toHaveBeenCalledWith('rt-1', 0)

    await userEvent.type(box, 'and CI?')
    await userEvent.click(screen.getByRole('button', { name: 'Send after round' }))
    expect(window.cockpit.sendRoundtableMessage).toHaveBeenLastCalledWith('rt-1', 'and CI?', {
      seats: undefined,
      whenBusy: 'queue'
    })
    await userEvent.type(box, 'stop, new idea')
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }))
    expect(window.cockpit.sendRoundtableMessage).toHaveBeenLastCalledWith('rt-1', 'stop, new idea', {
      seats: undefined,
      whenBusy: 'interrupt'
    })
  })

  it('shows the waiting message as not sent yet, and cancels it', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({ running: true, speaking: [1], queued: { text: 'and CI?', to: [1] } })
    )
    render(<RoundtableView id="rt-1" />)
    expect(await screen.findByText(/waiting — goes out when this round ends · to Codex/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'cancel' }))
    expect(window.cockpit.unqueueRoundtableMessage).toHaveBeenCalledWith('rt-1')
  })

  it('changes the round cap and the time limit mid-cycle', async () => {
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(
      fixture({ mode: 'consensus', maxRounds: 5, running: true, speaking: [0] })
    )
    render(<RoundtableView id="rt-1" />)
    await userEvent.click(await screen.findByRole('button', { name: /agent turns$/ }))
    const editor = screen.getByRole('group', { name: 'Roundtable spending limits' })
    expect(within(editor).getByText(/Applies from the next round/)).toBeInTheDocument()
    await userEvent.click(within(editor).getByRole('button', { name: /^Round cap/ }))
    await userEvent.click(await screen.findByRole('option', { name: '2 rounds' }))
    await userEvent.click(within(editor).getByRole('button', { name: /^Longest a seat may take/ }))
    await userEvent.click(await screen.findByRole('option', { name: '5 min' }))
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    expect(window.cockpit.setRoundtableLimits).toHaveBeenLastCalledWith(
      'rt-1',
      { maxTurnsPerMessage: 16, maxTurnsPerTable: 80, maxTurnMinutes: 5 },
      2
    )
  })
})

describe('RoundtableView transcript window', () => {
  it('renders the newest entries and shows the next batch on request', async () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      speaker: (i % 2 === 0 ? 'user' : 'claude') as 'user' | 'claude',
      seat: i % 2 === 0 ? undefined : 0,
      text: `entry ${i}`,
      at: i + 1
    }))
    vi.mocked(window.cockpit.getRoundtable).mockResolvedValue(fixture({ entries }))
    render(<RoundtableView id="rt-1" />)
    expect(await screen.findByText(/showing the last 200 of 250 messages/)).toBeInTheDocument()
    expect(screen.queryByText('entry 49')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'show 50 earlier' }))
    expect(screen.getByText('entry 0')).toBeInTheDocument()
    expect(screen.queryByText(/showing the last/)).not.toBeInTheDocument()
  })
})
