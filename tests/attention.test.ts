import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttentionDesk, type AttentionSurface } from '../src/main/attention'
import type { Notice } from '../src/main/attention-core'
import type {
  AttentionPrefs,
  AttentionTarget,
  CleanupNotice,
  Landing,
  NotificationDelivery,
  Provider
} from '../src/shared/types'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const ALL_ON: AttentionPrefs = { notifications: true, sound: true, badge: true, cleanup: true }
const CHECKOUT = '/Users/dev/src/rocket'

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
  opts: { prefs?: AttentionPrefs; delivery?: NotificationDelivery } = {}
): {
  desk: AttentionDesk
  seen: Recorded
  pushed: Landing[][]
  cleanups: Array<CleanupNotice | null>
  opened: Array<AttentionTarget | null>
} {
  const { surface, seen } = fakeSurface(opts.delivery)
  const pushed: Landing[][] = []
  const cleanups: Array<CleanupNotice | null> = []
  const opened: Array<AttentionTarget | null> = []
  const desk = new AttentionDesk({
    file,
    surface,
    prefs: opts.prefs ?? ALL_ON,
    titleFor: (u) => (u.id === 'claude:abc' ? 'Fix the login flake' : null),
    onLandings: (l) => pushed.push(l),
    onCleanup: (c) => cleanups.push(c),
    onOpen: (t) => opened.push(t)
  })
  return { desk, seen, pushed, cleanups, opened }
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
    expect(pushed.at(-1)?.map((l) => l.id)).toEqual(['claude:abc'])
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
      prefs: { notifications: false, sound: false, badge: false, cleanup: false }
    })
    finish(desk, 't1', 'abc')
    await vi.runAllTimersAsync()
    expect(seen).toMatchObject({ badges: [], sounds: [], banners: [], bounces: 0 })
    expect(pushed.at(-1)?.map((l) => l.id)).toEqual(['claude:abc'])

    // turning the badge on shows what is already waiting
    desk.setPrefs({ notifications: false, sound: false, badge: true, cleanup: true })
    expect(seen.badges).toEqual([1])
    desk.dispose()
  })

  it('landings survive a restart, and a hand-mangled file is a clean start rather than a crash', () => {
    const first = makeDesk(file)
    finish(first.desk, 't1', 'abc')
    first.desk.dispose()
    expect(JSON.parse(readFileSync(file, 'utf8')).unseen).toHaveLength(1)

    const second = makeDesk(file)
    expect(second.desk.landings().map((l) => l.id)).toEqual(['claude:abc'])
    // the Dock picks the count back up on launch
    expect(second.seen.badges).toEqual([1])
    second.desk.dispose()

    writeFileSync(file, '{"unseen": "nope"')
    const third = makeDesk(file)
    expect(third.desk.landings()).toEqual([])
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
      prefs: { notifications: false, sound: false, badge: false, cleanup: false }
    })
    await expect(desk.test()).resolves.toEqual({ status: 'shown' })
    expect(seen.banners).toHaveLength(1)
    expect(seen.sounds).toEqual([])
    desk.setPrefs({ notifications: false, sound: true, badge: false, cleanup: false })
    await desk.test()
    expect(seen.sounds).toEqual(['finish'])
    // clicking the sample brings the window forward without leaving Settings
    seen.clicks[0]()
    expect(opened).toEqual([null])
    desk.dispose()
  })
})

describe('AttentionDesk — observed turns and pull requests', () => {
  const RED = {
    number: 57,
    title: 'Fix login retry flake',
    state: 'OPEN' as const,
    isDraft: false,
    headRefName: 'cockpit/login-retry-flake',
    headSha: 'aaa111',
    url: 'https://github.com/acme/rocket/pull/57',
    checks: 'failing' as const,
    review: 'none' as const,
    unresolvedThreads: 0
  }

  it('an ending observed in a log lands like a spawned one, and reaches the renderer with its kind', async () => {
    const { desk, seen, pushed } = makeDesk(file)
    desk.observedTurn({ type: 'running', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    expect(pushed).toEqual([])
    desk.observedTurn({ type: 'ended', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT, startedAt: 0, endedAt: 300_000, closing: 'All green now.' })
    expect(pushed.at(-1)).toEqual([{ id: 'claude:abc', at: expect.any(Number), kind: 'landed' }])
    await vi.runAllTimersAsync()
    expect(seen.banners.map((b) => [b.title, b.subtitle, b.body])).toEqual([
      ['Claude finished after 5m', 'Fix the login flake', 'All green now.']
    ])
    desk.dispose()
  })

  it('a question reaches the board as "asks", with what was asked', async () => {
    const { desk, seen, pushed } = makeDesk(file)
    desk.observedTurn({ type: 'asks', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT, startedAt: 0, asks: { kind: 'question', detail: 'Ship it?' } })
    expect(pushed.at(-1)).toEqual([{ id: 'claude:abc', at: expect.any(Number), kind: 'asks', asks: { kind: 'question', detail: 'Ship it?' } }])
    await vi.runAllTimersAsync()
    expect(seen.banners.map((b) => b.title)).toEqual(['Claude asks you'])
    desk.dispose()
  })

  it('a red PR is raised once per head commit, and a restart remembers that', async () => {
    const first = makeDesk(file)
    first.desk.prsUpdated(CHECKOUT, [RED], () => 'claude:abc')
    await vi.runAllTimersAsync()
    expect(first.seen.banners.map((b) => b.title)).toEqual(['PR #57 has failing checks'])
    expect(first.seen.sounds).toEqual(['fail'])
    expect(first.pushed.at(-1)?.[0]).toMatchObject({ id: 'claude:abc', kind: 'pr', pr: { number: 57, checks: 'failing' } })
    first.desk.setFocus({ kind: 'session', id: 'claude:abc', provider: 'claude', cwd: CHECKOUT })
    first.desk.dispose()
    expect(JSON.parse(readFileSync(file, 'utf8')).prs).toEqual([[`pr:${CHECKOUT}#57`, 'aaa111']])

    const second = makeDesk(file)
    second.desk.prsUpdated(CHECKOUT, [RED], () => 'claude:abc')
    await vi.runAllTimersAsync()
    expect(second.seen.banners).toEqual([])
    second.desk.prsUpdated(CHECKOUT, [{ ...RED, headSha: 'bbb222' }], () => 'claude:abc')
    await vi.runAllTimersAsync()
    expect(second.seen.banners.map((b) => b.title)).toEqual(['PR #57 has failing checks'])
    second.desk.dispose()
  })

  it('after the first scan, a saved question is re-read from its log: answered while closed is dropped, still open is kept', async () => {
    const dir = join(file, '..')
    const jsonl = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    const prompt = { type: 'user', message: { role: 'user', content: 'create the repo' }, timestamp: '2026-09-16T10:00:00.000Z' }
    const question = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'Which owner?' }] } }] },
      timestamp: '2026-09-16T10:00:05.000Z'
    }
    const answer = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'acme' }] }, timestamp: '2026-09-16T10:09:00.000Z' }
    const ask = (id: string): void =>
      first.desk.observedTurn({ type: 'asks', id, provider: 'claude', cwd: CHECKOUT, startedAt: 0, asks: { kind: 'question', detail: 'Which owner?' } })

    const first = makeDesk(file)
    ask('claude:answered')
    ask('claude:open')
    ask('claude:gone')
    first.desk.dispose()

    // while Cockpit was closed, one question was answered and the turn went on
    writeFileSync(join(dir, 'answered.jsonl'), jsonl([prompt, question, answer]))
    writeFileSync(join(dir, 'open.jsonl'), jsonl([prompt, question]))
    const index: Record<string, { provider: Provider; sourcePath: string }> = {
      'claude:answered': { provider: 'claude', sourcePath: join(dir, 'answered.jsonl') },
      'claude:open': { provider: 'claude', sourcePath: join(dir, 'open.jsonl') }
    }

    const second = makeDesk(file)
    expect(second.desk.landings()).toHaveLength(3)
    second.desk.recheckAsks((id) => index[id] ?? null)
    expect(second.desk.landings().map((l) => [l.id, l.kind])).toEqual([['claude:open', 'asks']])
    expect(second.pushed.at(-1)?.map((l) => l.id)).toEqual(['claude:open'])
    expect(second.seen.badges.at(-1)).toBe(1)
    expect(JSON.parse(readFileSync(file, 'utf8')).unseen.map((u: { key: string }) => u.key)).toEqual(['asks:claude:open'])
    second.desk.dispose()
  })
})

describe('AttentionDesk — cleanup reminders', () => {
  const READY: CleanupNotice = {
    at: 0,
    staleDays: 30,
    sessions: 12,
    worktrees: 3,
    tables: 0,
    processes: 1,
    bytes: 2_100_000_000
  }

  it('a reminder marks Cleanup and posts one quiet banner — no sound, nothing on the Dock', async () => {
    const { desk, seen, cleanups, pushed } = makeDesk(file)
    desk.cleanupReady(READY)
    expect(cleanups).toEqual([READY])
    // it is not a session row, and nothing an agent waits on
    expect(pushed).toEqual([])
    expect(seen.badges).toEqual([])

    await vi.runAllTimersAsync()
    expect(seen.banners.map((b) => [b.title, b.subtitle, b.body])).toEqual([
      [
        'Cleanup can free 2.1 GB',
        '12 sessions · 3 worktrees · 1 process still running',
        'Idle over 30 days. Nothing goes until you pick it.'
      ]
    ])
    expect(seen.sounds).toEqual([])
    desk.dispose()
  })

  it('a click opens Cleanup, and opening it clears the mark and withdraws the banner', async () => {
    const { desk, seen, cleanups, opened } = makeDesk(file)
    desk.cleanupReady(READY)
    await vi.runAllTimersAsync()
    seen.clicks[0]()
    expect(opened).toEqual([{ kind: 'cleanup' }])

    desk.setFocus({ kind: 'cleanup' })
    expect(cleanups.at(-1)).toBeNull()
    expect(seen.withdrawn).toEqual([['cockpit:cleanup']])
    desk.dispose()
  })

  it('with Cleanup already in front of a focused window, it is not news', async () => {
    const { desk, seen, cleanups } = makeDesk(file)
    desk.setFocus({ kind: 'cleanup' })
    desk.setWindowFocused(true)
    desk.cleanupReady(READY)
    await vi.runAllTimersAsync()
    expect(cleanups).toEqual([])
    expect(seen.banners).toEqual([])
    desk.dispose()
  })

  it('an unopened reminder survives a restart', () => {
    const first = makeDesk(file)
    first.desk.cleanupReady(READY)
    first.desk.dispose()

    const second = makeDesk(file)
    expect(second.desk.cleanupNotice()).toEqual(READY)
    expect(second.seen.badges).toEqual([])
    second.desk.dispose()
  })

  it('with notifications off it still marks Cleanup, but posts nothing', async () => {
    const { desk, seen, cleanups } = makeDesk(file, {
      prefs: { notifications: false, sound: true, badge: true, cleanup: true }
    })
    desk.cleanupReady(READY)
    await vi.runAllTimersAsync()
    expect(cleanups).toEqual([READY])
    expect(seen).toMatchObject({ banners: [], sounds: [], badges: [], bounces: 0 })
    desk.dispose()
  })
})
