import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttentionDesk, readTailAttention, type AttentionDeskDeps, type AttentionSurface } from '../src/main/attention'
import type { Notice } from '../src/main/attention-core'
import type { AttentionItem, AttentionPrefs, AttentionTarget, NotificationDelivery, PrStatus, SessionMeta } from '../src/shared/types'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const ALL_ON: AttentionPrefs = { notifications: true, sound: true, badge: true }
const CHECKOUT = '/Users/dev/src/rocket'

/** The index's row for a session, as the desk asks for it. */
function sessionMeta(id: string, title: string, over: Partial<SessionMeta> = {}): SessionMeta {
  const [provider, nativeId] = id.split(':') as [SessionMeta['provider'], string]
  return {
    id,
    provider,
    nativeId,
    source: `${provider}-default`,
    title,
    cwd: CHECKOUT,
    logBranch: 'cockpit/login-flake',
    gitBranch: 'cockpit/login-flake',
    startedAt: 0,
    updatedAt: Date.now(),
    messageCount: 1,
    sourcePath: `/tmp/${nativeId}.jsonl`,
    repo: { key: 'gh:acme/rocket', name: 'rocket', fullName: 'acme/rocket', root: CHECKOUT },
    ...over
  }
}

/** What the desk asked of the OS, in order — the test stands in for macOS. */
type Recorded = {
  banners: Notice[]
  clicks: Array<() => void>
  withdrawn: string[][]
  badges: number[]
  sounds: string[]
  bounces: number
}

function fakeSurface(delivery: NotificationDelivery = { status: 'shown' }): {
  surface: AttentionSurface
  seen: Recorded
} {
  const seen: Recorded = { banners: [], clicks: [], withdrawn: [], badges: [], sounds: [], bounces: 0 }
  const surface: AttentionSurface = {
    notify: async (notice, onClick) => {
      seen.banners.push(notice)
      seen.clicks.push(onClick)
      return delivery
    },
    withdraw: (ids) => seen.withdrawn.push([...ids]),
    setBadge: (n) => seen.badges.push(n),
    play: (s) => seen.sounds.push(s),
    bounce: () => {
      seen.bounces++
    }
  }
  return { surface, seen }
}

function makeDesk(
  file: string,
  opts: {
    prefs?: AttentionPrefs
    delivery?: NotificationDelivery
    sessions?: Record<string, SessionMeta>
    prs?: AttentionDeskDeps['prs']
  } = {}
): {
  desk: AttentionDesk
  seen: Recorded
  pushed: AttentionItem[][]
  opened: Array<AttentionTarget | null>
} {
  const { surface, seen } = fakeSurface(opts.delivery)
  const pushed: AttentionItem[][] = []
  const opened: Array<AttentionTarget | null> = []
  const sessions = opts.sessions ?? { 'claude:abc': sessionMeta('claude:abc', 'Fix the login flake') }
  const desk = new AttentionDesk({
    file,
    surface,
    prefs: opts.prefs ?? ALL_ON,
    sessionFor: (id) => sessions[id] ?? null,
    onItems: (l) => pushed.push(l),
    onOpen: (t) => opened.push(t),
    ...(opts.prs ? { prs: opts.prs, prSweepMs: 60_000 } : {})
  })
  return { desk, seen, pushed, opened }
}

/** A resumed claude turn that finishes (or fails) without anyone watching. */
function finish(desk: AttentionDesk, turnId: string, native: string, error?: string): void {
  desk.turnStarted({ turnId, provider: 'claude', cwd: CHECKOUT, prompt: 'go', resumeNativeId: native })
  desk.chatEvent({ turnId, type: 'text', text: 'All green now.' })
  if (error) desk.chatEvent({ turnId, type: 'error', message: error })
  desk.chatEvent({ turnId, type: 'done' })
}

let file: string

beforeEach(() => {
  vi.useFakeTimers()
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-attention-'))
  dirs.push(dir)
  file = join(dir, 'attention.json')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AttentionDesk', () => {
  it('a landing badges the Dock and reaches the renderer at once; the banner and sound wait out the burst', async () => {
    const { desk, seen, pushed } = makeDesk(file)
    finish(desk, 't1', 'abc')

    expect(seen.badges).toEqual([1])
    expect(pushed.at(-1)?.map((l) => l.key)).toEqual(['claude:abc'])
    expect(seen.banners).toEqual([])

    await vi.runAllTimersAsync()
    expect(seen.sounds).toEqual(['finish'])
    expect(seen.banners.map((b) => [b.title, b.subtitle, b.body])).toEqual([
      ['Claude finished', 'Fix the login flake', 'All green now.']
    ])
    expect(seen.bounces).toBe(0)
    desk.dispose()
  })

  it('opening the session clears the badge, tells the renderer, and withdraws the banner', async () => {
    const { desk, seen, pushed } = makeDesk(file)
    finish(desk, 't1', 'abc')
    await vi.runAllTimersAsync()

    desk.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    expect(seen.badges).toEqual([1, 0])
    expect(pushed.at(-1)).toEqual([])
    expect(seen.withdrawn).toEqual([['cockpit:claude:abc']])
    desk.dispose()
  })

  it('a banner macOS refuses bounces the Dock icon instead; the sound still plays', async () => {
    const refused = { status: 'refused', message: 'UNErrorDomain error 1' } as const
    const { desk, seen } = makeDesk(file, { delivery: refused })
    finish(desk, 't1', 'abc', 'claude exited with code 1')
    await vi.runAllTimersAsync()
    expect(seen.sounds).toEqual(['fail'])
    expect(seen.bounces).toBe(1)
    desk.dispose()
  })

  it('a clicked banner opens its target', async () => {
    const { desk, seen, opened } = makeDesk(file)
    finish(desk, 't1', 'abc')
    await vi.runAllTimersAsync()
    seen.clicks[0]()
    expect(opened).toEqual([{ kind: 'session', id: 'claude:abc' }])
    desk.dispose()
  })

  it('every switch off: nothing on the Dock, no sound, no banner — the landing still reaches the board', async () => {
    const { desk, seen, pushed } = makeDesk(file, {
      prefs: { notifications: false, sound: false, badge: false }
    })
    finish(desk, 't1', 'abc')
    await vi.runAllTimersAsync()
    expect(seen).toMatchObject({ badges: [], sounds: [], banners: [], bounces: 0 })
    expect(pushed.at(-1)?.map((l) => l.key)).toEqual(['claude:abc'])

    // turning the badge on shows what is already waiting
    desk.setPrefs({ notifications: false, sound: false, badge: true })
    expect(seen.badges).toEqual([1])
    desk.dispose()
  })

  it('landings survive a restart, and a hand-mangled file is a clean start rather than a crash', () => {
    const first = makeDesk(file)
    finish(first.desk, 't1', 'abc')
    first.desk.dispose()
    expect(JSON.parse(readFileSync(file, 'utf8')).unseen).toHaveLength(1)

    const second = makeDesk(file)
    expect(second.desk.items().map((i) => i.key)).toEqual(['claude:abc'])
    // the Dock picks the count back up on launch
    expect(second.seen.badges).toEqual([1])
    second.desk.dispose()

    writeFileSync(file, '{"unseen": "nope"')
    const third = makeDesk(file)
    expect(third.desk.items()).toEqual([])
    expect(third.seen.badges).toEqual([])
    third.desk.dispose()
  })

  it('stream chunks never touch the file or the renderer — only endings do', () => {
    const { desk, pushed } = makeDesk(file)
    desk.turnStarted({ turnId: 't1', provider: 'claude', cwd: CHECKOUT, prompt: 'go' })
    for (let i = 0; i < 50; i++) desk.chatEvent({ turnId: 't1', type: 'text', text: `chunk ${i} ` })
    expect(pushed).toEqual([])
    expect(existsSync(file)).toBe(false)
    desk.dispose()
  })

  it('the Settings test posts a sample whatever the notification switch says, with the sound only when that is on', async () => {
    const { desk, seen, opened } = makeDesk(file, {
      prefs: { notifications: false, sound: false, badge: false }
    })
    await expect(desk.test()).resolves.toEqual({ status: 'shown' })
    expect(seen.banners).toHaveLength(1)
    expect(seen.sounds).toEqual([])
    desk.setPrefs({ notifications: false, sound: true, badge: false })
    await desk.test()
    expect(seen.sounds).toEqual(['finish'])
    // clicking the sample brings the window forward without leaving Settings
    seen.clicks[0]()
    expect(opened).toEqual([null])
    desk.dispose()
  })
})

/* ---------- what the logs say: real files, bounded reads ---------- */

const T = () => new Date().toISOString()

function claudeLog(dir: string, native: string, records: unknown[]): string {
  const file = join(dir, `${native}.jsonl`)
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

const askRecord = (): unknown => ({
  type: 'assistant',
  timestamp: T(),
  message: {
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which owner?' }] } }]
  }
})
const answerRecord = (): unknown => ({
  type: 'user',
  timestamp: T(),
  toolUseResult: {},
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ciqol' }] }
})
const closingRecord = (text: string): unknown => ({
  type: 'assistant',
  timestamp: T(),
  message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
})

describe('AttentionDesk — reading the logs', () => {
  it('readTailAttention judges the newest records and stays quiet on an empty or legacy file', () => {
    const dir = join(file, '..')
    const asking = claudeLog(dir, 'ask', [{ type: 'user', message: { role: 'user', content: 'go' }, timestamp: T() }, askRecord()])
    expect(readTailAttention(asking, 'claude')?.waiting).toMatchObject({ reason: 'question', detail: 'Which owner?' })
    expect(readTailAttention(join(dir, 'missing.jsonl'), 'claude')).toEqual({ waiting: null, failed: null, closing: '', ended: false })
    expect(readTailAttention(join(dir, 'legacy.json'), 'copilot')).toEqual({ waiting: null, failed: null, closing: '', ended: false })
  })

  it('a question in a fresh log reaches the board, the badge and a banner; the answer takes it back', async () => {
    const dir = join(file, '..')
    const log = claudeLog(dir, 'abc', [{ type: 'user', message: { role: 'user', content: 'go' }, timestamp: T() }, askRecord()])
    const meta = sessionMeta('claude:abc', 'Fix the login flake', { sourcePath: log })
    const { desk, seen, pushed } = makeDesk(file, { sessions: { 'claude:abc': meta } })

    desk.observeLog(log, meta, Date.now())
    expect(pushed.at(-1)).toEqual([
      expect.objectContaining({ kind: 'session', id: 'claude:abc', reason: 'question', detail: 'Which owner?', title: 'Fix the login flake', branch: 'cockpit/login-flake', repo: 'rocket' })
    ])
    expect(seen.badges).toEqual([1])
    await vi.runAllTimersAsync()
    expect(seen.sounds).toEqual(['ask'])
    expect(seen.banners.map((b) => [b.title, b.subtitle, b.body])).toEqual([['Claude is asking', 'Fix the login flake', 'Which owner?']])

    writeFileSync(log, [askRecord(), answerRecord()].map((r) => JSON.stringify(r)).join('\n') + '\n')
    desk.observeLog(log, meta, Date.now())
    expect(pushed.at(-1)).toEqual([])
    expect(seen.badges).toEqual([1, 0])
    expect(seen.withdrawn).toEqual([['cockpit:claude:abc']])
    desk.dispose()
  })

  it('an old log is never read, and a session Cockpit is running itself is never read for asks', () => {
    const dir = join(file, '..')
    const log = claudeLog(dir, 'abc', [askRecord()])
    const meta = sessionMeta('claude:abc', 'x', { sourcePath: log })
    const { desk, pushed } = makeDesk(file, { sessions: { 'claude:abc': meta } })
    desk.observeLog(log, { ...meta, updatedAt: Date.now() - 3_600_000 }, Date.now() - 3_600_000)
    expect(pushed).toEqual([])

    desk.turnStarted({ turnId: 't1', provider: 'claude', cwd: CHECKOUT, prompt: 'go', resumeNativeId: 'abc' })
    desk.observeLog(log, meta, Date.now())
    expect(pushed).toEqual([])
    desk.dispose()
  })

  it('a turn the log ended lands with the closing words the desk read at that write', async () => {
    const dir = join(file, '..')
    const log = claudeLog(dir, 'abc', [{ type: 'user', message: { role: 'user', content: 'go' }, timestamp: T() }, closingRecord('## Done\nAll green now.')])
    const meta = sessionMeta('claude:abc', 'Fix the login flake', { sourcePath: log })
    const { desk, seen, pushed } = makeDesk(file, { sessions: { 'claude:abc': meta } })
    desk.observeLog(log, meta, Date.now())
    expect(pushed).toEqual([])
    desk.observedEnd({ id: 'claude:abc', startedAt: Date.now() - 4 * 60_000 })
    expect(pushed.at(-1)).toEqual([expect.objectContaining({ reason: 'landed', detail: 'Done' })])
    await vi.runAllTimersAsync()
    expect(seen.banners.map((b) => [b.title, b.body])).toEqual([['Claude finished after 4m', 'Done']])
    desk.dispose()
  })

  it('an ask persisted across a restart is checked against its log once the index is back', () => {
    const dir = join(file, '..')
    const log = claudeLog(dir, 'abc', [askRecord()])
    const meta = sessionMeta('claude:abc', 'x', { sourcePath: log })
    const first = makeDesk(file, { sessions: { 'claude:abc': meta } })
    first.desk.observeLog(log, meta, Date.now())
    first.desk.dispose()

    // answered while Cockpit was closed
    writeFileSync(log, [askRecord(), answerRecord()].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const second = makeDesk(file, { sessions: { 'claude:abc': meta } })
    expect(second.seen.badges).toEqual([1])
    second.desk.resolve(() => null)
    expect(second.seen.badges).toEqual([1, 0])
    second.desk.dispose()
  })
})

/* ---------- pull requests: the sweep ---------- */

function redPr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    number: 57,
    title: 'Fix login retry flake',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'cockpit/login-flake',
    url: 'https://github.com/acme/rocket/pull/57',
    checks: 'failing',
    review: 'none',
    unresolvedThreads: 0,
    ...over
  }
}

describe('AttentionDesk — pull requests', () => {
  it('the first index update runs a sweep; a red PR on the user\'s branch is raised and clicks through to the session', async () => {
    const lists: string[] = []
    let status = redPr()
    const { desk, seen, pushed, opened } = makeDesk(file, {
      prs: {
        roots: () => [CHECKOUT],
        list: async (root) => {
          lists.push(root)
          return [status, redPr({ number: 99, url: 'u99', headRefName: 'someone-elses' })]
        },
        sessionOnBranch: (_root, branch) => (branch === 'cockpit/login-flake' ? sessionMeta('claude:abc', 'Fix the login flake') : null)
      }
    })
    expect(lists).toEqual([])
    desk.resolve(() => null)
    // the sweep's gh answers on a microtask; the banner waits out the burst window
    await vi.advanceTimersByTimeAsync(2_000)
    expect(lists).toEqual([CHECKOUT])
    expect(pushed.at(-1)).toEqual([
      expect.objectContaining({ kind: 'pr', reason: 'checks', sessionId: 'claude:abc', repo: 'rocket', pr: expect.objectContaining({ number: 57 }) })
    ])
    expect(seen.banners.map((b) => [b.title, b.subtitle, b.body])).toEqual([['Checks failing on #57', 'Fix login retry flake', 'rocket · cockpit/login-flake']])
    seen.clicks[0]()
    expect(opened).toEqual([{ kind: 'session', id: 'claude:abc' }])

    // the timer's sweep sees it green: off the list, banner withdrawn, no sound
    status = redPr({ checks: 'passing' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(lists).toHaveLength(2)
    expect(pushed.at(-1)).toEqual([])
    expect(seen.withdrawn).toEqual([['cockpit:pr:https://github.com/acme/rocket/pull/57']])
    expect(seen.sounds).toEqual(['fail'])
    desk.dispose()
  })

  it('a repo whose gh call throws is skipped, and a click on a PR row marks it seen', async () => {
    const { desk, pushed, seen } = makeDesk(file, {
      prs: {
        roots: () => ['/gone', CHECKOUT],
        list: async (root) => {
          if (root === '/gone') throw new Error('no gh')
          return [redPr({ review: 'changes_requested', checks: 'none' })]
        },
        sessionOnBranch: () => sessionMeta('claude:abc', 'x')
      }
    })
    desk.resolve(() => null)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(pushed.at(-1)?.map((i) => i.key)).toEqual(['pr:https://github.com/acme/rocket/pull/57'])
    expect(seen.sounds).toEqual(['ask'])
    desk.markSeen('pr:https://github.com/acme/rocket/pull/57')
    expect(pushed.at(-1)).toEqual([])
    expect(seen.badges).toEqual([1, 0])
    desk.dispose()
  })
})
