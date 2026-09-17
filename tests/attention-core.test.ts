import { describe, it, expect } from 'vitest'
import {
  AttentionTracker,
  BURST_MS,
  ITEM_MAX,
  ITEM_TTL_MS,
  QUIET,
  judgeAttentionTail,
  elapsedLabel,
  failureSnippet,
  outcomeSnippet,
  sanitizeMemory,
  sanitizeUnseen,
  tableOutcome,
  type Unseen
} from '../src/main/attention-core'
import type { AttentionPrefs, PrStatus, Roundtable, RoundtableEntry, SessionMeta } from '../src/shared/types'

const ALL_ON: AttentionPrefs = { notifications: true, sound: true, badge: true }

/** The board's session rows as the old landed set read them: id and when. */
const landings = (t: AttentionTracker): Array<{ id: string; at: number }> =>
  t.items(() => null).flatMap((i) => (i.kind === 'session' ? [{ id: i.id, at: i.at }] : []))
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

    expect(landings(h.t)).toEqual([{ id: 'claude:abc', at: h.clock.now }])
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

    expect(landings(h.t)).toEqual([])
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
    expect(landings(h.t).map((l) => l.id)).toEqual(['codex:old'])
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
    expect(landings(h.t).map((l) => l.id)).toEqual(['claude:a'])
    h.flush()

    runTurn(h, { turnId: 't2', resume: 'a', announce: 'b', text: 'second' })
    expect(landings(h.t).map((l) => l.id)).toEqual(['claude:b'])
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
    expect(landings(h.t)).toEqual([])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    const { notice } = h.flush()
    // nothing to open yet but the board
    expect(notice?.subtitle).toBe('fix the login flake')
    expect(notice?.target).toEqual({ kind: 'home' })

    h.t.resolve((u) => (u.provider === 'copilot' && u.cwd === WORKTREE ? 'copilot:s1' : null))
    expect(landings(h.t).map((l) => l.id)).toEqual(['copilot:s1'])
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
    expect(landings(h.t)).toEqual([])
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
    const old: Unseen = { key: 'claude:old', kind: 'session', reason: 'landed', id: 'claude:old', startedAt: 0, at: now - ITEM_TTL_MS - 1, detail: '' }
    const many: Unseen[] = Array.from({ length: ITEM_MAX + 5 }, (_, i) => ({
      key: `claude:s${i}`,
      kind: 'session',
      reason: 'landed',
      id: `claude:s${i}`,
      startedAt: now - 1000 + i,
      at: now - 1000 + i,
      detail: ''
    }))
    const h = harness([old, ...many])
    expect(h.t.badgeCount(ALL_ON)).toBe(ITEM_MAX)
    expect(landings(h.t).some((l) => l.id === 'claude:old')).toBe(false)
    expect(landings(h.t)[0].id).toBe(`claude:s${ITEM_MAX + 4}`)
    expect(landings(h.t).some((l) => l.id === 'claude:s0')).toBe(false)
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
          { key: 'stale', kind: 'session', at: now - ITEM_TTL_MS - 1 },
          { key: 'nan', kind: 'session', at: 'soon' }
        ],
        now
      )
    ).toEqual([
      { key: 'table:rt', kind: 'roundtable', reason: 'landed', id: 'rt', startedAt: now - 2, at: now - 2, detail: '' },
      { key: 'claude:a', kind: 'session', reason: 'landed', id: 'claude:a', provider: 'claude', cwd: CHECKOUT, startedAt: now - 5, at: now - 1, detail: '' }
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

/* ---------- what a log's tail says ---------- */

const T = '2026-09-16T10:00:00.000Z'

describe('judgeAttentionTail — claude', () => {
  const ask = {
    type: 'assistant',
    timestamp: T,
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Two ways to go here.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Which owner should the repo live under?', header: 'Owner', options: [] }] }
        }
      ]
    }
  }
  const answer = {
    type: 'user',
    timestamp: T,
    toolUseResult: { answers: {} },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Owner: ciqol' }] }
  }
  const bookkeeping = [{ type: 'attachment', attachment: { type: 'total_tokens_reminder' } }, { type: 'last-prompt' }]

  it('an AskUserQuestion with nothing after it is a question — bookkeeping lines do not answer it', () => {
    expect(judgeAttentionTail('claude', [ask, ...bookkeeping])).toEqual({
      waiting: { reason: 'question', detail: 'Which owner should the repo live under?', signature: 'ask:toolu_1', at: Date.parse(T) },
      failed: null,
      closing: '',
      ended: false
    })
  })

  it('the answer arrives as a tool result, and the turn is quiet again', () => {
    expect(judgeAttentionTail('claude', [ask, answer])).toEqual(QUIET)
  })

  it('leaving plan mode waits on approval; any other tool call is just a turn at work', () => {
    const plan = { ...ask, message: { ...ask.message, content: [{ type: 'tool_use', id: 't2', name: 'ExitPlanMode', input: { plan: '# Plan' } }] } }
    expect(judgeAttentionTail('claude', [plan])?.waiting).toMatchObject({ reason: 'permission', detail: 'approve the plan', signature: 'plan:t2' })
    const bash = { ...ask, message: { ...ask.message, content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }] } }
    expect(judgeAttentionTail('claude', [bash])).toEqual(QUIET)
  })

  it('a text-only answer is the closing word; the CLI\'s API-error message is a failure', () => {
    const done = { type: 'assistant', timestamp: T, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '## Done\nAll green.' }] } }
    expect(judgeAttentionTail('claude', [done, { type: 'system', subtype: 'stop_hook_summary' }])).toEqual({
      waiting: null, failed: null, closing: '## Done\nAll green.', ended: true
    })
    const dead = { type: 'assistant', timestamp: T, uuid: 'u9', isApiErrorMessage: true, error: 'server_error', message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: Your computer went to sleep mid-response.' }] } }
    expect(judgeAttentionTail('claude', [dead])).toEqual({
      waiting: null,
      failed: { detail: 'API Error: Your computer went to sleep mid-response.', signature: 'api:u9', at: Date.parse(T) },
      closing: '',
      ended: true
    })
  })

  it('a subagent\'s ask is the subagent\'s business; a tail with no message record says nothing', () => {
    expect(judgeAttentionTail('claude', [{ ...ask, isSidechain: true }, ...bookkeeping])).toBeNull()
    expect(judgeAttentionTail('claude', bookkeeping)).toBeNull()
  })
})

describe('judgeAttentionTail — codex', () => {
  const ev = (payload: Record<string, unknown>): unknown => ({ timestamp: T, type: 'event_msg', payload })

  it('an exec approval request with nothing after it waits; the tool output after it is the turn moving on', () => {
    const request = ev({ type: 'exec_approval_request', call_id: 'c1', command: ['bash', '-lc', 'rm -rf dist && npm run build'], cwd: '/x' })
    expect(judgeAttentionTail('codex', [request, ev({ type: 'token_count' })])).toEqual({
      waiting: { reason: 'permission', detail: 'rm -rf dist && npm run build', signature: 'exec_approval_request:c1', at: Date.parse(T) },
      failed: null,
      closing: '',
      ended: false
    })
    const output = { timestamp: T, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' } }
    expect(judgeAttentionTail('codex', [request, output])).toEqual(QUIET)
  })

  it('a patch approval names the files; an input request is a question', () => {
    const patch = ev({ type: 'apply_patch_approval_request', call_id: 'c2', changes: { '/x/src/a.ts': {}, '/x/README.md': {} } })
    expect(judgeAttentionTail('codex', [patch])?.waiting).toMatchObject({ reason: 'permission', detail: 'apply_patch a.ts, README.md' })
    const input = ev({ type: 'request_user_input', id: 'q1', questions: [{ question: 'Ship behind a flag?' }] })
    expect(judgeAttentionTail('codex', [input])?.waiting).toMatchObject({ reason: 'question', detail: 'Ship behind a flag?', signature: 'request_user_input:q1' })
  })

  it('task_complete carries the closing words, error the failure, and a started turn is quiet', () => {
    expect(judgeAttentionTail('codex', [ev({ type: 'task_complete', turn_id: 't', last_agent_message: 'Pushed the branch.' })])).toEqual({
      waiting: null, failed: null, closing: 'Pushed the branch.', ended: true
    })
    expect(judgeAttentionTail('codex', [ev({ type: 'error', message: 'stream disconnected' })])?.failed).toMatchObject({ detail: 'stream disconnected' })
    expect(judgeAttentionTail('codex', [ev({ type: 'task_started', turn_id: 't' })])).toEqual(QUIET)
    expect(judgeAttentionTail('codex', [ev({ type: 'token_count' })])).toBeNull()
  })
})

describe('judgeAttentionTail — copilot', () => {
  const rec = (type: string, data: Record<string, unknown>, id = 'e1'): unknown => ({ type, data, id, timestamp: T })
  const requested = rec('permission.requested', {
    requestId: 'r1',
    permissionRequest: { kind: 'shell', fullCommandText: 'find . -name "*.env"\necho done', intention: 'List env files' }
  })

  it('a permission request waits until its completion arrives, whatever the answer was', () => {
    expect(judgeAttentionTail('copilot', [requested, rec('hook.end', {})])).toEqual({
      waiting: { reason: 'permission', detail: 'List env files', signature: 'permission:r1', at: Date.parse(T) },
      failed: null,
      closing: '',
      ended: false
    })
    const completed = rec('permission.completed', { requestId: 'r1', result: { kind: 'denied' } }, 'e2')
    expect(judgeAttentionTail('copilot', [requested, completed])).toBeNull()
    expect(judgeAttentionTail('copilot', [requested, completed, rec('assistant.message', { content: 'Skipping that.' })])).toEqual({
      waiting: null, failed: null, closing: 'Skipping that.', ended: true
    })
  })

  it('without an intention the command\'s first line stands in', () => {
    const bare = rec('permission.requested', { requestId: 'r2', permissionRequest: { kind: 'shell', fullCommandText: 'git push\n' } })
    expect(judgeAttentionTail('copilot', [bare])?.waiting?.detail).toBe('git push')
  })

  it('session.error is a failure, task_complete the closing summary, a prompt quiet', () => {
    expect(judgeAttentionTail('copilot', [rec('session.error', { errorType: 'query', message: 'Failed to get response from the AI model; retried 5 times' }, 'e3'), rec('assistant.turn_end', {})])).toEqual({
      waiting: null,
      failed: { detail: 'Failed to get response from the AI model; retried 5 times', signature: 'error:e3', at: Date.parse(T) },
      closing: '',
      ended: true
    })
    expect(judgeAttentionTail('copilot', [rec('session.task_complete', { summary: 'Opened PR #438.' })])?.closing).toBe('Opened PR #438.')
    expect(judgeAttentionTail('copilot', [rec('user.message', { content: 'go' })])).toEqual(QUIET)
  })
})

/* ---------- observed sessions and pull requests ---------- */

const waitingOn = (detail: string, signature = 'ask:1'): ReturnType<typeof judgeAttentionTail> => ({
  waiting: { reason: 'question', detail, signature, at: null },
  failed: null,
  closing: '',
  ended: false
})

describe('AttentionTracker — an agent waiting in a terminal', () => {
  it('a question raises the session, counts on the badge, and asks with its own sound', () => {
    const h = harness()
    h.titles.set('claude:abc', 'Fix the login flake')
    h.t.observed('claude:abc', 'claude', waitingOn('Which owner?')!)
    expect(h.t.items(() => null)).toEqual([
      expect.objectContaining({ kind: 'session', id: 'claude:abc', reason: 'question', detail: 'Which owner?' })
    ])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    const { notice, sound } = h.flush()
    expect(sound).toBe('ask')
    expect(notice).toMatchObject({ title: 'Claude is asking', subtitle: 'Fix the login flake', body: 'Which owner?', failed: false, target: { kind: 'session', id: 'claude:abc' } })
  })

  it('the log moving on resolves it and withdraws the banner; the same ask never speaks twice', () => {
    const h = harness()
    h.t.observed('claude:abc', 'claude', waitingOn('Which owner?')!)
    const id = h.flush().notice?.id
    // the same write judged again (a bookkeeping line landed): nothing new
    h.t.observed('claude:abc', 'claude', waitingOn('Which owner?')!)
    expect(h.t.flushAt()).toBeNull()
    h.t.observed('claude:abc', 'claude', QUIET)
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.t.takeWithdrawn()).toEqual([id])
  })

  it('never about the session on screen — but leaving it with the question still open raises it', () => {
    const h = harness()
    h.t.setWindowFocused(true)
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    h.t.observed('claude:abc', 'claude', waitingOn('Which owner?')!)
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    h.t.setFocus({ kind: 'none' })
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    // opening it is looking at it: gone, and coming and going again does not bring it back
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    h.t.setFocus({ kind: 'none' })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    // a different question is news again
    h.t.observed('claude:abc', 'claude', waitingOn('Ship behind a flag?', 'ask:2')!)
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
  })

  it('an observed turn ending lands with its closing words, unless Cockpit ran that turn itself', () => {
    const h = harness()
    h.titles.set('codex:x1', 'Add pagination')
    h.t.observed('codex:x1', 'codex', { waiting: null, failed: null, closing: '**Pushed** the branch.', ended: true })
    h.t.observedEnd({ id: 'codex:x1', provider: 'codex', startedAt: h.clock.now - 3 * 60_000 })
    expect(landings(h.t).map((l) => l.id)).toEqual(['codex:x1'])
    expect(h.flush().notice).toMatchObject({ title: 'Codex finished after 3m', subtitle: 'Add pagination', body: 'Pushed the branch.' })

    // a spawned turn's own ending was the news; the log saying so a moment later is not
    runTurn(h, { turnId: 't1', resume: 'abc', text: 'Done.', minutes: 0 })
    h.flush()
    h.t.observedEnd({ id: 'claude:abc', provider: 'claude', startedAt: h.clock.now })
    expect(h.t.flushAt()).toBeNull()
  })

  it('an observed failure lands as one, with the error the log records', () => {
    const h = harness()
    h.t.observed('copilot:p1', 'copilot', {
      waiting: null,
      failed: { detail: 'Failed to get response from the AI model', signature: 'error:e3', at: null },
      closing: '',
      ended: true
    })
    h.t.observedEnd({ id: 'copilot:p1', provider: 'copilot', startedAt: h.clock.now })
    expect(h.t.items(() => null)[0]).toMatchObject({ reason: 'failed', detail: 'Failed to get response from the AI model' })
    expect(h.flush()).toMatchObject({ sound: 'fail', notice: { title: 'Copilot failed', failed: true } })
  })

  it('a new turn in the terminal clears a landing nobody opened — the user drove past it', () => {
    const h = harness()
    h.t.observed('codex:x1', 'codex', { waiting: null, failed: null, closing: 'Done.', ended: true })
    h.t.observedEnd({ id: 'codex:x1', provider: 'codex', startedAt: h.clock.now })
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    h.t.observed('codex:x1', 'codex', QUIET)
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
  })
})

function pr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    number: 57,
    title: 'Fix login retry flake',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'cockpit/login-retry-flake',
    url: 'https://github.com/acme/rocket/pull/57',
    checks: 'failing',
    review: 'none',
    unresolvedThreads: 0,
    ...over
  }
}

function sessionOn(id: string, branch: string): SessionMeta {
  return {
    id,
    provider: 'claude',
    nativeId: id.split(':')[1],
    source: 'claude-default',
    title: 'Fix the login flake',
    cwd: CHECKOUT,
    logBranch: branch,
    gitBranch: branch,
    startedAt: 0,
    updatedAt: 0,
    messageCount: 1,
    sourcePath: '/x.jsonl',
    repo: { key: 'gh:acme/rocket', name: 'rocket', fullName: 'acme/rocket', root: CHECKOUT }
  }
}

describe('AttentionTracker — pull requests gone red', () => {
  const signal = (p: PrStatus) => ({ pr: p, repoRoot: CHECKOUT, session: sessionOn('claude:abc', p.headRefName) })

  it('failing checks raise the PR once, name the session on its branch, and clear when it recovers', () => {
    const h = harness()
    h.t.setPrs([signal(pr())])
    expect(h.t.items(() => null)).toEqual([
      expect.objectContaining({ kind: 'pr', reason: 'checks', sessionId: 'claude:abc', repo: 'rocket', provider: 'claude' })
    ])
    const { notice, sound } = h.flush()
    expect(sound).toBe('fail')
    expect(notice).toMatchObject({
      title: 'Checks failing on #57',
      subtitle: 'Fix login retry flake',
      body: 'rocket · cockpit/login-retry-flake',
      target: { kind: 'session', id: 'claude:abc' }
    })
    // the next sweep, same condition: no second banner
    h.t.setPrs([signal(pr())])
    expect(h.t.flushAt()).toBeNull()
    h.t.setPrs([signal(pr({ checks: 'passing' }))])
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    expect(h.t.takeWithdrawn()).toEqual([notice?.id])
  })

  it('changes requested asks; a PR with no session opens on GitHub; a green or merged PR is nobody\'s', () => {
    const h = harness()
    const orphan = { pr: pr({ number: 58, url: 'https://github.com/acme/rocket/pull/58', checks: 'none' as const, review: 'changes_requested' as const }), repoRoot: CHECKOUT, session: null }
    h.t.setPrs([orphan, signal(pr({ number: 59, url: 'u59', checks: 'passing' })), signal(pr({ number: 60, url: 'u60', state: 'MERGED' }))])
    expect(h.t.items(() => null).map((i) => i.key)).toEqual(['pr:https://github.com/acme/rocket/pull/58'])
    const { notice, sound } = h.flush()
    expect(sound).toBe('ask')
    expect(notice).toMatchObject({ title: 'Changes requested on #58', target: { kind: 'url', url: 'https://github.com/acme/rocket/pull/58' } })
  })

  it('opening the session on the branch is looking at the PR; a recovery and a new failure raise it again', () => {
    const h = harness()
    h.t.setPrs([signal(pr())])
    h.flush()
    h.t.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    h.t.setPrs([signal(pr())])
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    h.t.setPrs([signal(pr({ checks: 'passing' }))])
    h.t.setPrs([signal(pr())])
    expect(h.t.badgeCount(ALL_ON)).toBe(1)
    expect(h.flush().notice?.title).toBe('Checks failing on #57')
  })

  it('markSeen takes a PR off the list the way a click on its link does', () => {
    const h = harness()
    h.t.setPrs([signal(pr())])
    h.t.markSeen('pr:https://github.com/acme/rocket/pull/57')
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
    h.t.setPrs([signal(pr())])
    expect(h.t.badgeCount(ALL_ON)).toBe(0)
  })

  it('a burst that is not only endings says how many need you', () => {
    const h = harness()
    h.titles.set('claude:abc', 'Fix the login flake')
    runTurn(h, { turnId: 't1', resume: 'abc', text: 'Done.', minutes: 0 })
    h.t.observed('codex:x1', 'codex', waitingOn('Ship it?')!)
    h.t.setPrs([signal(pr())])
    expect(h.flush().notice).toMatchObject({
      title: '3 need you',
      body: 'Claude finished · Fix the login flake\nCodex is asking · New session\nChecks failing on #57 · Fix login retry flake',
      target: { kind: 'home' }
    })
  })
})

describe('AttentionTracker — the list the board shows', () => {
  it('names session rows from the index when it has them, and waits for it otherwise', () => {
    const h = harness()
    runTurn(h, { turnId: 't1', resume: 'abc', text: 'Done.' })
    const named = h.t.items((id) => (id === 'claude:abc' ? sessionOn(id, 'cockpit/login-flake') : null))
    expect(named).toEqual([
      { kind: 'session', key: 'claude:abc', id: 'claude:abc', provider: 'claude', reason: 'landed', title: 'Fix the login flake', branch: 'cockpit/login-flake', repo: 'rocket', detail: 'Done.', at: h.clock.now }
    ])
    // a copilot landing with no session yet is on the badge but not on the board
    runTurn(h, { turnId: 't2', provider: 'copilot', cwd: WORKTREE, text: 'Done.' })
    expect(h.t.badgeCount(ALL_ON)).toBe(2)
    expect(h.t.items(() => null)).toHaveLength(1)
  })

  it('reads persisted asks, PRs and memories as untrusted input', () => {
    const now = 1_700_000_000_000
    const good = pr()
    expect(
      sanitizeUnseen(
        [
          { key: 'claude:q', kind: 'session', reason: 'question', id: 'claude:q', at: now - 1, detail: 'Which?', signature: 'ask:1' },
          { key: 'claude:old-q', kind: 'session', reason: 'question', id: 'claude:old-q', at: now - 13 * 3_600_000 },
          { key: 'pr:u', kind: 'pr', reason: 'checks', at: now - 2, pr: good, repoRoot: CHECKOUT, sessionId: 'claude:abc', signature: 'checks:failing:none' },
          { key: 'pr:bad', kind: 'pr', reason: 'checks', at: now - 2, pr: { number: 'x' }, repoRoot: CHECKOUT },
          { key: 'pr:why', kind: 'pr', reason: 'landed', at: now - 2, pr: good, repoRoot: CHECKOUT },
          { key: 'claude:r', kind: 'session', reason: 'review', id: 'claude:r', at: now - 3 }
        ],
        now
      ).map((u) => u.key)
    ).toEqual(['pr:u', 'claude:q'])
    expect(sanitizeMemory([['k', 's'], ['bad'], 'nope', [1, 2]])).toEqual([['k', 's']])
  })
})
