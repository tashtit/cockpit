import { describe, it, expect } from 'vitest'
import {
  AttentionTracker,
  BURST_MS,
  LANDING_MAX,
  LANDING_TTL_MS,
  elapsedLabel,
  failureSnippet,
  outcomeSnippet,
  sanitizeUnseen,
  tableOutcome,
  type Unseen
} from '../src/main/attention-core'
import type { AttentionPrefs, Roundtable, RoundtableEntry } from '../src/shared/types'

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

    expect(h.t.landings()).toEqual([{ id: 'claude:abc', at: h.clock.now }])
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
