import { describe, it, expect } from 'vitest'
import {
  AttentionTracker,
  BURST_MS,
  LANDING_MAX,
  LANDING_TTL_MS,
  OBSERVED_ECHO_MS,
  elapsedLabel,
  failureSnippet,
  outcomeSnippet,
  prIsRed,
  sanitizeSeenPrs,
  sanitizeUnseen,
  tableOutcome,
  type Unseen
} from '../src/main/attention-core'
import type { ObservedTurn } from '../src/main/liveness-core'
import type { AttentionPrefs, PrStatus, Roundtable, RoundtableEntry } from '../src/shared/types'

const ALL_ON: AttentionPrefs = { notifications: true, sound: true, badge: true }
const WORKTREE = '/Users/dev/Library/Application Support/Cockpit/worktrees/login-flake'
const CHECKOUT = '/Users/dev/src/rocket'

/** A tracker on a clock the test moves by hand. */
function harness(unseen: readonly Unseen[] = []): {
  t: AttentionTracker
  clock: { now: number }
  titles: Map<string, string>
  flush: (prefs?: AttentionPrefs) => ReturnType<AttentionTracker['flush']>
} {
  const clock = { now: 1_700_000_000_000 }
  const titles = new Map<string, string>()
  const t = new AttentionTracker({ now: () => clock.now, unseen })
  return {
    t,
    clock,
    titles,
    flush: (prefs = ALL_ON) => t.flush(prefs, (u) => (u.id ? (titles.get(u.id) ?? null) : null))
  }
}

/** One claude turn resuming `native`, run to completion with the given closing text. */
function runTurn(
  h: ReturnType<typeof harness>,
  opts: {
    turnId: string
    provider?: 'claude' | 'codex' | 'copilot'
    cwd?: string
    resume?: string
    announce?: string
    text?: string
    error?: string
    minutes?: number
  }
): void {
  const provider = opts.provider ?? 'claude'
  h.t.turnStarted({
    turnId: opts.turnId,
    provider,
    cwd: opts.cwd ?? CHECKOUT,
    prompt: 'fix the login flake\nit fails on CI only',
    resumeNativeId: opts.resume
  })
  if (opts.announce) h.t.chatEvent({ turnId: opts.turnId, type: 'session', nativeSessionId: opts.announce })
  h.t.chatEvent({ turnId: opts.turnId, type: 'text', text: 'Let me look at the test first.' })
  h.t.chatEvent({ turnId: opts.turnId, type: 'tool', toolName: 'Bash', detail: 'npm test' })
  if (opts.text) h.t.chatEvent({ turnId: opts.turnId, type: 'text', text: opts.text })
  if (opts.error) h.t.chatEvent({ turnId: opts.turnId, type: 'error', message: opts.error })
  h.clock.now += (opts.minutes ?? 4) * 60_000
  h.t.chatEvent({ turnId: opts.turnId, type: 'done' })
}

describe('AttentionTracker — what lands', () => {
  it('a turn nobody watched lands, counts on the badge, and notifies once the burst window closes', () => {
    const h = harness()
    h.titles.set('claude:abc', 'Fix the login flake')
    runTurn(h, { turnId: 't1', resume: 'abc', text: '## Done\n**Fixed** the flake by retrying the token refresh.' })

    expect(h.t.landings()).toEqual([{ id: 'claude:abc', at: h.clock.now, kind: 'landed' }])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    expect(h.t.flushAt()).toBe(h.clock.now + BURST_MS)

    const { notice, sound } = h.flush()
    expect(sound).toBe('finish')
    expect(notice).toMatchObject({
      title: 'Claude finished after 4m',
      subtitle: 'Fix the login flake',
      body: 'Done',
      failed: false,
      target: { kind: 'session', id: 'claude:abc' },
      keys: ['claude:abc']
    })
    expect(h.t.flushAt()).toBeNull()
  })

  it('quotes the closing words — what the agent said after its last tool call', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', resume: 'abc', text: 'Fixed the flake by retrying the token refresh.' })
    expect(h.flush().notice?.body).toBe('Fixed the flake by retrying the token refresh.')
  })

  it('never lands the session on screen while the window is focused — the user watched it', () => {
    const h = harness()
    h.t.setWindowFocused(true)
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    runTurn(h, { turnId: 't1', resume: 'abc', text: 'Done.' })

    expect(h.t.landings()).toEqual([])
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.t.flushAt()).toBeNull()
  })

  it('the session on screen in a background window does land, and coming back clears it and its banner', () => {
    const h = harness()
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    h.t.setWindowFocused(false)
    runTurn(h, { turnId: 't1', resume: 'abc', text: 'Done.' })
    const { notice } = h.flush()
    expect(notice?.id).toBe('cockpit:claude:abc')

    h.t.setWindowFocused(true)
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.t.takeWithdrawn()).toEqual(['cockpit:claude:abc'])
    expect(h.t.takeWithdrawn()).toEqual([])
  })

  it('a brand-new chat on screen is matched by agent and directory, before and after it names itself', () => {
    const h = harness()
    h.t.setWindowFocused(true)
    h.t.setFocus({ kind: 'session', id: null, provider: 'codex', cwd: `${WORKTREE}/` })
    runTurn(h, { turnId: 't1', provider: 'codex', cwd: WORKTREE, announce: 'n1', text: 'Done.' })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)

    // but a resumed conversation that happens to share the directory is not that chat
    runTurn(h, { turnId: 't2', provider: 'codex', cwd: WORKTREE, resume: 'old', text: 'Done.' })
    expect(h.t.landings().map((l) => l.id)).toEqual(['codex:old'])
  })

  it('a turn the user stopped is not news, even though it ends with an error', () => {
    const h = harness()
    h.t.turnStarted({ turnId: 't1', provider: 'claude', cwd: CHECKOUT, prompt: 'x', resumeNativeId: 'abc' })
    h.t.turnCancelled('t1')
    h.t.chatEvent({ turnId: 't1', type: 'error', message: 'claude exited with code null' })
    h.t.chatEvent({ turnId: 't1', type: 'done' })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.t.flushAt()).toBeNull()
  })

  it('ignores turns it never saw start — a roundtable seat is its table\'s business', () => {
    const h = harness()
    h.t.chatEvent({ turnId: 'seat', type: 'done' })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
  })

  it('a failure says so, with the error in one line and the failure sound', () => {
    const h = harness()
    runTurn(h, {
      turnId: 't1',
      provider: 'codex',
      resume: 'r1',
      error: 'codex exited with code 1:\nerror: model not found\n  at main',
      minutes: 0
    })
    const { notice, sound } = h.flush()
    expect(sound).toBe('fail')
    expect(notice).toMatchObject({
      title: 'Codex failed',
      body: 'codex exited with code 1: error: model not found',
      failed: true
    })
  })

  it('a claude resume forks a new id — one conversation lands once, under the id it now has', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', resume: 'a', text: 'first' })
    expect(h.t.landings().map((l) => l.id)).toEqual(['claude:a'])
    h.flush()

    runTurn(h, { turnId: 't2', resume: 'a', announce: 'b', text: 'second' })
    expect(h.t.landings().map((l) => l.id)).toEqual(['claude:b'])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    // the earlier banner moved to the new id rather than being withdrawn: nobody opened it
    expect(h.t.takeWithdrawn()).toEqual([])
    h.t.setFocus({ kind: 'session', id: 'claude:b', provider: 'claude', cwd: CHECKOUT })
    expect(h.t.takeWithdrawn()).toEqual(['cockpit:claude:a'])
  })
})

describe('AttentionTracker — opening and bursts', () => {
  it('opening a session before the burst flushes drops its notification — the user got there first', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', resume: 'abc', text: 'Done.' })
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    expect(h.flush()).toEqual({ notice: null, sound: null })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
  })

  it('several endings together become one notification, pointed at the board', () => {
    const h = harness()
    h.titles.set('claude:a', 'Fix the login flake')
    h.titles.set('codex:b', 'Add pagination')
    runTurn(h, { turnId: 't1', resume: 'a', text: 'Done.' })
    const due = h.t.flushAt()
    runTurn(h, { turnId: 't2', provider: 'codex', resume: 'b', error: 'boom', minutes: 0 })
    runTurn(h, { turnId: 't3', provider: 'copilot', resume: 'c', text: 'Done.', minutes: 0 })
    runTurn(h, { turnId: 't4', provider: 'copilot', resume: 'd', text: 'Done.', minutes: 0 })
    // later endings join the burst — they don't push its deadline out
    expect(h.t.flushAt()).toBe(due)

    const { notice, sound } = h.flush()
    expect(sound).toBe('fail')
    expect(notice).toMatchObject({
      title: '3 finished · 1 failed',
      target: { kind: 'home' },
      keys: ['claude:a', 'codex:b', 'copilot:c', 'copilot:d']
    })
    expect(notice?.body.split('\n')).toEqual([
      'Claude finished · Fix the login flake',
      'Codex failed · Add pagination',
      'Copilot finished · fix the login flake',
      '+1 more'
    ])
  })

  it('the same session ending twice inside one burst speaks once, with its latest news', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', resume: 'a', text: 'first pass', minutes: 0 })
    runTurn(h, { turnId: 't2', resume: 'a', text: 'second pass', minutes: 0 })
    const { notice } = h.flush()
    expect(notice?.keys).toEqual(['claude:a'])
    expect(notice?.body).toBe('second pass')
  })

  it('a withdrawn summary waits until every session it named has been opened', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', resume: 'a', text: 'Done.' })
    runTurn(h, { turnId: 't2', resume: 'b', text: 'Done.' })
    const id = h.flush().notice?.id
    h.t.setFocus({ kind: 'session', id: 'claude:a', provider: 'claude', cwd: CHECKOUT })
    expect(h.t.takeWithdrawn()).toEqual([])
    h.t.setFocus({ kind: 'session', id: 'claude:b', provider: 'claude', cwd: CHECKOUT })
    expect(h.t.takeWithdrawn()).toEqual([id])
  })

  it('switches: notifications off still plays the sound, sound off stays quiet, badge off shows nothing', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', resume: 'a', text: 'Done.' })
    expect(h.flush({ notifications: false, sound: true, badge: true })).toEqual({
      notice: null,
      sound: 'finish'
    })
    runTurn(h, { turnId: 't2', resume: 'b', text: 'Done.' })
    const quiet = h.flush({ notifications: true, sound: false, badge: false })
    expect(quiet.sound).toBeNull()
    expect(quiet.notice).not.toBeNull()
    expect(h.t.badgeCount({ notifications: true, sound: true, badge: false })).toBe(0)
    expect(h.t.badgeCount(ALL_ON)).toBe(2)
  })
})

describe('AttentionTracker — sessions without an id yet', () => {
  it('copilot never names its session: the landing counts, finds its session later, and then shows as landed', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', provider: 'copilot', cwd: WORKTREE, text: 'Done.' })
    expect(h.t.landings()).toEqual([])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    const { notice } = h.flush()
    // nothing to open yet but the board
    expect(notice?.subtitle).toBe('fix the login flake')
    expect(notice?.target).toEqual({ kind: 'home' })

    h.t.resolve((u) => (u.provider === 'copilot' && u.cwd === WORKTREE ? 'copilot:s1' : null))
    expect(h.t.landings().map((l) => l.id)).toEqual(['copilot:s1'])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    // a click now goes to the session it became
    expect(notice && h.t.targetFor(notice)).toEqual({ kind: 'session', id: 'copilot:s1' })
  })

  it('opening the new chat in that directory clears an id-less landing', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', provider: 'copilot', cwd: WORKTREE, text: 'Done.' })
    h.t.setFocus({ kind: 'session', id: 'copilot:indexed', provider: 'copilot', cwd: WORKTREE })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
  })

  it('a spawn that fails before the window reports the new chat is cleared when the report arrives', () => {
    const h = harness()
    h.t.setWindowFocused(true)
    // the home board was on screen when the refusal came back (it beats the focus push)
    h.t.turnStarted({ turnId: 't1', provider: 'claude', cwd: WORKTREE, prompt: 'go' })
    h.t.chatEvent({ turnId: 't1', type: 'error', message: 'Working directory no longer exists' })
    h.t.chatEvent({ turnId: 't1', type: 'done' })
    expect(h.t.badgeCount(ALL_ON)).toBe(1)

    h.t.setFocus({ kind: 'session', id: null, provider: 'claude', cwd: WORKTREE })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.flush()).toEqual({ notice: null, sound: null })
  })
})

describe('AttentionTracker — roundtables', () => {
  const consensus = { kind: 'consensus' as const, detail: 'All 2 seats agree.' }

  it('a table concluding lands once and opens the table', () => {
    const h = harness()
    h.t.tableEnded({ id: 'rt1', title: 'Adopt incremental indexing?', outcome: consensus })
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    expect(h.t.landings()).toEqual([])
    const { notice, sound } = h.flush()
    expect(sound).toBe('finish')
    expect(notice).toMatchObject({
      title: 'Roundtable reached consensus',
      subtitle: 'Adopt incremental indexing?',
      body: 'All 2 seats agree.',
      target: { kind: 'roundtable', id: 'rt1' }
    })
  })

  it('stays quiet about the table on screen, and opening one clears it', () => {
    const h = harness()
    h.t.setWindowFocused(true)
    h.t.setFocus({ kind: 'roundtable', id: 'rt1' })
    h.t.tableEnded({ id: 'rt1', title: 'x', outcome: consensus })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)

    h.t.tableEnded({ id: 'rt2', title: 'y', outcome: { kind: 'failed', detail: 'boom' } })
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    expect(h.flush().sound).toBe('fail')
    h.t.setFocus({ kind: 'roundtable', id: 'rt2' })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
  })
})

describe('AttentionTracker — keeping it bounded', () => {
  it('forgets landings older than a week and keeps only the newest when there are too many', () => {
    const now = 1_700_000_000_000
    const old: Unseen = { key: 'claude:old', kind: 'session', id: 'claude:old', startedAt: 0, at: now - LANDING_TTL_MS - 1 }
    const many: Unseen[] = Array.from({ length: LANDING_MAX + 5 }, (_, i) => ({
      key: `claude:s${i}`,
      kind: 'session',
      id: `claude:s${i}`,
      startedAt: now - 1000 + i,
      at: now - 1000 + i
    }))
    const h = harness([old, ...many])
    expect(h.t.badgeCount(ALL_ON)).toBe(LANDING_MAX)
    expect(h.t.landings().some((l) => l.id === 'claude:old')).toBe(false)
    expect(h.t.landings()[0].id).toBe(`claude:s${LANDING_MAX + 4}`)
    expect(h.t.landings().some((l) => l.id === 'claude:s0')).toBe(false)
  })

  it('reads the persisted file as untrusted input', () => {
    const now = 1_700_000_000_000
    expect(sanitizeUnseen('nope', now)).toEqual([])
    expect(
      sanitizeUnseen(
        [
          null,
          { key: 'claude:a', kind: 'session', id: 'claude:a', provider: 'claude', cwd: CHECKOUT, startedAt: now - 5, at: now - 1 },
          { key: 'table:rt', kind: 'roundtable', id: 'rt', at: now - 2, provider: 'rm -rf' },
          { key: '', kind: 'session', at: now },
          { key: 'x', kind: 'wat', at: now },
          { key: 'stale', kind: 'session', at: now - LANDING_TTL_MS - 1 },
          { key: 'nan', kind: 'session', at: 'soon' }
        ],
        now
      )
    ).toEqual([
      { key: 'table:rt', kind: 'roundtable', id: 'rt', startedAt: now - 2, at: now - 2 },
      { key: 'claude:a', kind: 'session', id: 'claude:a', provider: 'claude', cwd: CHECKOUT, startedAt: now - 5, at: now - 1 }
    ])
  })
})

describe('notification text', () => {
  it('outcomeSnippet takes the first readable line, markdown stripped, clipped', () => {
    expect(outcomeSnippet('\n\n### Summary\n- more')).toBe('Summary')
    expect(outcomeSnippet('- **Fixed** `retry()` in auth_client')).toBe('Fixed retry() in auth_client')
    expect(outcomeSnippet('1. first step')).toBe('first step')
    expect(outcomeSnippet('a'.repeat(200))).toHaveLength(110)
    expect(outcomeSnippet('a'.repeat(200)).endsWith('…')).toBe(true)
    expect(outcomeSnippet('   \n  ')).toBe('')
  })

  it('failureSnippet joins a trailing colon with the line that explains it', () => {
    expect(failureSnippet('claude reported an error: rate limited')).toBe('claude reported an error: rate limited')
    expect(failureSnippet('copilot exited with code 2:\n\n  auth required\nmore')).toBe(
      'copilot exited with code 2: auth required'
    )
    expect(failureSnippet('')).toBe('')
  })

  it('elapsedLabel stays silent for quick turns and reads naturally for long ones', () => {
    expect(elapsedLabel(1200)).toBeNull()
    expect(elapsedLabel(42_000)).toBe('42s')
    expect(elapsedLabel(4 * 60_000 + 10_000)).toBe('4m')
    expect(elapsedLabel(65 * 60_000)).toBe('1h 5m')
  })
})

describe('tableOutcome', () => {
  const seats: Roundtable['participants'] = [
    { provider: 'claude', nativeSessionId: null, seenUpTo: 0 },
    { provider: 'codex', nativeSessionId: null, seenUpTo: 0 }
  ]
  const entry = (over: Partial<RoundtableEntry>): RoundtableEntry => ({
    speaker: 'claude',
    text: 'reply',
    at: 0,
    ...over
  })
  const user = entry({ speaker: 'user', text: 'topic' })

  it('every seat agreeing is consensus, quoting a seat\'s own one-liner', () => {
    expect(
      tableOutcome({
        mode: 'consensus',
        concluded: true,
        roundsRun: 2,
        participants: seats,
        entries: [
          user,
          entry({ seat: 0, stance: 'continue' }),
          entry({ seat: 0, stance: 'agree', stanceNote: 'ship it behind a flag' }),
          entry({ speaker: 'codex', seat: 1, stance: 'agree' })
        ]
      })
    ).toEqual({ kind: 'consensus', detail: 'All 2 agree: ship it behind a flag' })
  })

  it('hitting the round cap without agreement says so', () => {
    expect(
      tableOutcome({
        mode: 'consensus',
        concluded: true,
        roundsRun: 3,
        participants: seats,
        entries: [user, entry({ seat: 0, stance: 'agree' }), entry({ speaker: 'codex', seat: 1, stance: 'continue' })]
      })
    ).toEqual({ kind: 'no-consensus', detail: 'No agreement after 3 rounds.' })
  })

  it('an open table finishing a round counts replies; all errors is a failure', () => {
    expect(
      tableOutcome({
        mode: 'open',
        concluded: false,
        roundsRun: 1,
        participants: seats,
        entries: [user, entry({ seat: 0 }), entry({ speaker: 'codex', seat: 1, error: true, text: 'boom' })]
      })
    ).toEqual({ kind: 'replied', detail: '1 of 2 seats replied.' })
    expect(
      tableOutcome({
        mode: 'open',
        concluded: false,
        roundsRun: 1,
        participants: seats,
        entries: [user, entry({ seat: 0, error: true, text: 'a' }), entry({ speaker: 'codex', seat: 1, error: true, text: 'b' })]
      })
    ).toEqual({ kind: 'failed', detail: "Every seat's turn failed." })
    // older files carry no seat index: the provider's first seat stands in
    expect(
      tableOutcome({ mode: 'open', concluded: false, roundsRun: 1, participants: seats, entries: [user, entry({})] })
    ).toEqual({ kind: 'replied', detail: '1 of 2 seats replied.' })
    expect(
      tableOutcome({ mode: 'open', concluded: false, roundsRun: 1, participants: seats, entries: [user] })
    ).toEqual({ kind: 'failed', detail: 'No seat replied.' })
  })
})

/* ---------- turns observed in the logs (terminals, the providers' own apps) ---------- */

const FOUR_MIN = 4 * 60_000

/** What the liveness tracker reports for a session the index knows. */
function observed(h: ReturnType<typeof harness>, ev: Partial<ObservedTurn> & { type: ObservedTurn['type'] }): void {
  const base = { id: 'claude:obs', provider: 'claude' as const, cwd: CHECKOUT }
  const start = h.clock.now - FOUR_MIN
  const full =
    ev.type === 'ended'
      ? { ...base, startedAt: start, endedAt: h.clock.now, closing: '## Done\nRetried the token refresh.', ...ev }
      : ev.type === 'asks'
        ? { ...base, startedAt: start, asks: { kind: 'question' as const, detail: 'Which owner?' }, ...ev }
        : { ...base, ...ev }
  h.t.observedTurn(full as ObservedTurn)
}

describe('AttentionTracker — turns observed in the logs', () => {
  it('an observed ending lands, badges and notifies exactly like a spawned one', () => {
    const h = harness()
    h.titles.set('claude:obs', 'Fix the login flake')
    observed(h, { type: 'running' })
    expect(h.t.landings()).toEqual([])
    observed(h, { type: 'ended' })
    expect(h.t.landings()).toEqual([{ id: 'claude:obs', at: h.clock.now, kind: 'landed' }])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    const { notice, sound } = h.flush()
    expect(sound).toBe('finish')
    expect(notice).toMatchObject({
      title: 'Claude finished after 4m',
      subtitle: 'Fix the login flake',
      body: 'Done',
      target: { kind: 'session', id: 'claude:obs' }
    })
  })

  it('a session on screen in a focused window never lands from its log either', () => {
    const h = harness()
    h.t.setWindowFocused(true)
    h.t.setFocus({ kind: 'session', id: 'claude:obs', provider: 'claude', cwd: CHECKOUT })
    observed(h, { type: 'running' })
    observed(h, { type: 'ended' })
    expect(h.t.landings()).toEqual([])
    expect(h.t.flushAt()).toBeNull()
  })

  it("a turn Cockpit is running itself is its flight's business — the log's echo is skipped", () => {
    const h = harness()
    h.t.turnStarted({ turnId: 't1', provider: 'claude', cwd: CHECKOUT, prompt: 'go', resumeNativeId: 'obs' })
    observed(h, { type: 'running' })
    observed(h, { type: 'ended' })
    expect(h.t.landings()).toEqual([])
    h.clock.now += FOUR_MIN
    h.t.chatEvent({ turnId: 't1', type: 'text', text: 'All green.' })
    h.t.chatEvent({ turnId: 't1', type: 'done' })
    expect(h.t.landings().map((l) => l.id)).toEqual(['claude:obs'])
    // the ending record reaches the tracker a debounce later: the same ending, not a second
    h.clock.now += 2_000
    observed(h, { type: 'ended' })
    expect(h.t.landings()).toHaveLength(1)
    expect(h.flush().notice?.body).toBe('All green.')
    // well after, a genuinely new observed turn in that session is news again
    h.clock.now += OBSERVED_ECHO_MS
    observed(h, { type: 'running' })
    observed(h, { type: 'ended' })
    expect(h.t.flushAt()).not.toBeNull()
  })

  it('a copilot turn Cockpit spawned has no id — the same agent in the same directory is that turn', () => {
    const h = harness()
    h.t.turnStarted({ turnId: 't1', provider: 'copilot', cwd: WORKTREE, prompt: 'go' })
    observed(h, { type: 'ended', id: 'copilot:p1', provider: 'copilot', cwd: WORKTREE })
    expect(h.t.landings()).toEqual([])
    h.t.chatEvent({ turnId: 't1', type: 'done' })
    observed(h, { type: 'ended', id: 'copilot:p1', provider: 'copilot', cwd: `${WORKTREE}/` })
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    expect(h.flush().notice?.keys).toEqual(['turn:t1'])
  })

  it('the log running again means the person is at that keyboard: the landing is seen', () => {
    const h = harness()
    observed(h, { type: 'running' })
    observed(h, { type: 'ended' })
    h.flush()
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    observed(h, { type: 'running' })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.t.takeWithdrawn()).toEqual(['cockpit:claude:obs'])
  })

  it('a question lands as "asks you" with what was asked, and clicking the banner opens the session', () => {
    const h = harness()
    h.titles.set('claude:obs', 'Create the repo')
    observed(h, { type: 'asks' })
    expect(h.t.landings()).toEqual([
      { id: 'claude:obs', at: h.clock.now, kind: 'asks', asks: { kind: 'question', detail: 'Which owner?' } }
    ])
    const { notice, sound } = h.flush()
    expect(sound).toBe('finish')
    expect(notice).toMatchObject({
      id: 'cockpit:asks:claude:obs',
      title: 'Claude asks you',
      subtitle: 'Create the repo',
      body: 'Which owner?',
      target: { kind: 'session', id: 'claude:obs' }
    })
    expect(h.t.targetFor(notice!)).toEqual({ kind: 'session', id: 'claude:obs' })
  })

  it('a permission prompt reads as one, and an empty detail gets a stand-in line', () => {
    const h = harness()
    observed(h, { type: 'asks', id: 'copilot:p1', provider: 'copilot', asks: { kind: 'permission', detail: '' } })
    expect(h.flush().notice).toMatchObject({ title: 'Copilot needs permission', body: 'Approve it where the agent runs.' })
  })

  it('the same question is news once; the answer, or the ending, clears it', () => {
    const h = harness()
    observed(h, { type: 'asks' })
    h.flush()
    observed(h, { type: 'asks' })
    expect(h.t.flushAt()).toBeNull()
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    observed(h, { type: 'running' })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.t.takeWithdrawn()).toEqual(['cockpit:asks:claude:obs'])
    observed(h, { type: 'asks', asks: { kind: 'question', detail: 'And the branch name?' } })
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    observed(h, { type: 'ended' })
    expect(h.t.landings()).toEqual([{ id: 'claude:obs', at: h.clock.now, kind: 'landed' }])
  })

  it('a question in the session on screen is not news, and never becomes one later', () => {
    const h = harness()
    h.t.setWindowFocused(true)
    h.t.setFocus({ kind: 'session', id: 'claude:obs', provider: 'claude', cwd: CHECKOUT })
    observed(h, { type: 'asks' })
    expect(h.t.landings()).toEqual([])
    h.t.setWindowFocused(false)
    expect(h.t.landings()).toEqual([])
  })

  it('opening the session clears the question from the badge', () => {
    const h = harness()
    observed(h, { type: 'asks' })
    h.t.setFocus({ kind: 'session', id: 'claude:obs', provider: 'claude', cwd: CHECKOUT })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
  })
})

/* ---------- red pull requests ---------- */

const ROCKET = '/Users/dev/src/rocket'

function pr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    number: 57,
    title: 'Fix login retry flake',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'cockpit/login-retry-flake',
    headSha: 'aaa111',
    url: 'https://github.com/acme/rocket/pull/57',
    checks: 'failing',
    review: 'none',
    unresolvedThreads: 0,
    ...over
  }
}

/** The index's answer: which session is on that branch. */
const carrier = (p: PrStatus): string | null => (p.headRefName === 'cockpit/login-retry-flake' ? 'claude:abc' : null)

describe('AttentionTracker — red pull requests', () => {
  it("a red PR on a session's branch lands on that session — once per head commit, however often the badges refresh", () => {
    const h = harness()
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    expect(h.t.landings()).toEqual([
      {
        id: 'claude:abc',
        at: h.clock.now,
        kind: 'pr',
        pr: { number: 57, title: 'Fix login retry flake', url: 'https://github.com/acme/rocket/pull/57', checks: 'failing', review: 'none' }
      }
    ])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    const { notice, sound } = h.flush()
    expect(sound).toBe('fail')
    expect(notice).toMatchObject({
      title: 'PR #57 has failing checks',
      subtitle: 'Fix login retry flake',
      body: 'cockpit/login-retry-flake',
      failed: false,
      target: { kind: 'session', id: 'claude:abc' }
    })
    h.clock.now += 60_000
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    h.clock.now += 60_000
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    expect(h.t.flushAt()).toBeNull()
    expect(h.t.landings()).toHaveLength(1)
  })

  it('green again clears it; a new push that goes red is news again', () => {
    const h = harness()
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    h.flush()
    h.t.prsUpdated(ROCKET, [pr({ checks: 'passing' })], carrier)
    expect(h.t.landings()).toEqual([])
    expect(h.t.takeWithdrawn()).toEqual(['cockpit:pr:/Users/dev/src/rocket#57'])
    // the same commit failing again (a re-run) is not a new push
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    expect(h.t.flushAt()).toBeNull()
    h.t.prsUpdated(ROCKET, [pr({ headSha: 'bbb222' })], carrier)
    expect(h.t.landings().map((l) => l.kind)).toEqual(['pr'])
    expect(h.flush().notice?.title).toBe('PR #57 has failing checks')
  })

  it('changes requested is red; drafts too; merged, closed and pending are not', () => {
    expect(prIsRed(pr({ checks: 'none', review: 'changes_requested' }))).toBe(true)
    expect(prIsRed(pr({ isDraft: true }))).toBe(true)
    expect(prIsRed(pr({ state: 'MERGED' }))).toBe(false)
    expect(prIsRed(pr({ state: 'CLOSED', review: 'changes_requested' }))).toBe(false)
    expect(prIsRed(pr({ checks: 'pending' }))).toBe(false)
    const h = harness()
    h.t.prsUpdated(ROCKET, [pr({ checks: 'none', review: 'changes_requested' })], carrier)
    expect(h.flush().notice?.title).toBe('PR #57 has changes requested')
  })

  it("a PR no session is on has no row: it waits for one, and is not marked seen", () => {
    const h = harness()
    h.t.prsUpdated(ROCKET, [pr({ headRefName: 'someone/else' })], carrier)
    expect(h.t.landings()).toEqual([])
    h.t.prsUpdated(ROCKET, [pr({ headRefName: 'someone/else' })], () => 'claude:new')
    expect(h.t.landings().map((l) => l.id)).toEqual(['claude:new'])
  })

  it('opening the session clears the badge, and the same commit stays quiet afterwards', () => {
    const h = harness()
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    h.flush()
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: ROCKET })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    h.t.setFocus({ kind: 'none' })
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.t.flushAt()).toBeNull()
  })

  it('on screen in a focused window the badge already says it: seen, no notification', () => {
    const h = harness()
    h.t.setWindowFocused(true)
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: ROCKET })
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    expect(h.t.landings()).toEqual([])
    h.t.setWindowFocused(false)
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    expect(h.t.landings()).toEqual([])
    expect(h.t.seenPrEntries()).toEqual([['pr:/Users/dev/src/rocket#57', 'aaa111']])
  })

  it('a PR that leaves the list (merged, closed, gone) waits on nobody; other repos are untouched', () => {
    const h = harness()
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    h.t.prsUpdated('/Users/dev/src/atlas', [pr({ number: 12 })], () => 'codex:atlas')
    expect(h.t.landings()).toHaveLength(2)
    h.t.prsUpdated(ROCKET, [], carrier)
    expect(h.t.landings().map((l) => l.id)).toEqual(['codex:atlas'])
  })

  it('while unseen, the row follows the PR: checks passing but changes requested is still red', () => {
    const h = harness()
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    h.t.prsUpdated(ROCKET, [pr({ checks: 'passing', review: 'changes_requested' })], carrier)
    expect(h.t.landings()[0]).toMatchObject({ kind: 'pr', pr: { checks: 'passing', review: 'changes_requested' } })
    expect(h.t.flushAt()).not.toBeNull()
    expect(h.flush().notice?.title).toBe('PR #57 has failing checks')
  })
})

describe('AttentionTracker — one row per session, and mixed bursts', () => {
  it('a session with several reasons carries the most urgent: a question over a red PR over a landing', () => {
    const h = harness()
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    expect(h.t.landings().map((l) => l.kind)).toEqual(['pr'])
    observed(h, { type: 'running', id: 'claude:abc' })
    observed(h, { type: 'ended', id: 'claude:abc' })
    expect(h.t.landings().map((l) => l.kind)).toEqual(['pr'])
    observed(h, { type: 'asks', id: 'claude:abc' })
    expect(h.t.landings().map((l) => l.kind)).toEqual(['asks'])
    expect(h.t.badgeCount(ALL_ON)).toBe(2)
    // opening it takes every reason with it
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: ROCKET })
    expect(h.t.landings()).toEqual([])
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
  })

  it('a burst of different kinds is counted by kind, and sounds like the worst of them', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', resume: 'one', text: 'Done.' })
    observed(h, { type: 'asks', id: 'codex:two', provider: 'codex' })
    h.t.prsUpdated(ROCKET, [pr()], carrier)
    const { notice, sound } = h.flush()
    expect(sound).toBe('fail')
    expect(notice).toMatchObject({ title: '1 finished · 1 waiting on you · 1 PR red', target: { kind: 'home' } })
    expect(notice?.body.split('\n')).toEqual([
      'Claude finished · fix the login flake',
      'Codex asks you · Session',
      'PR #57 has failing checks · Fix login retry flake'
    ])
  })
})

describe('sanitizeUnseen — the new kinds', () => {
  const now = 1_700_000_000_000
  it('keeps well-formed questions and pull requests, drops the rest', () => {
    const asks = { key: 'asks:claude:a', kind: 'asks', id: 'claude:a', at: now, asks: { kind: 'question', detail: 'Ship it?' } }
    const red = { key: 'pr:/r#1', kind: 'pr', id: 'claude:a', at: now, sha: 'abc', pr: { number: 1, title: 'T', url: 'u', checks: 'failing', review: 'none' } }
    const out = sanitizeUnseen(
      [
        asks,
        red,
        { ...asks, key: 'asks:x', asks: { kind: 'shrug' } },
        { ...asks, key: 'asks:y', id: null },
        { ...red, key: 'pr:/r#2', pr: { number: 'two', checks: 'failing', review: 'none' } },
        { ...red, key: 'pr:/r#3', pr: { number: 3, checks: 'red', review: 'none' } },
        { key: 'x', kind: 'pull', id: 'claude:a', at: now }
      ],
      now
    )
    expect(out).toEqual([
      { ...asks, startedAt: now },
      { ...red, startedAt: now }
    ])
  })
  it('seen PRs are pairs of strings, anything else is dropped', () => {
    expect(sanitizeSeenPrs([['pr:/r#1', 'abc'], ['pr:/r#2'], 'x', null, [1, 2]])).toEqual([['pr:/r#1', 'abc']])
    expect(sanitizeSeenPrs('nope')).toEqual([])
  })
  it('a restored tracker raises nothing for a commit it already raised', () => {
    const h = harness()
    const restored = new AttentionTracker({ now: () => h.clock.now, seenPrs: [['pr:/Users/dev/src/rocket#57', 'aaa111']] })
    restored.prsUpdated(ROCKET, [pr()], carrier)
    expect(restored.landings()).toEqual([])
    expect(restored.flushAt()).toBeNull()
  })
})
