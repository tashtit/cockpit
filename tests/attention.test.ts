import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttentionDesk, type AttentionSurface } from '../src/main/attention'
import type { Notice } from '../src/main/attention-core'
import type { AttentionPrefs, AttentionTarget, Landing, NotificationDelivery } from '../src/shared/types'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const ALL_ON: AttentionPrefs = { notifications: true, sound: true, badge: true }
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
  opened: Array<AttentionTarget | null>
} {
  const { surface, seen } = fakeSurface(opts.delivery)
  const pushed: Landing[][] = []
  const opened: Array<AttentionTarget | null> = []
  const desk = new AttentionDesk({
    file,
    surface,
    prefs: opts.prefs ?? ALL_ON,
    titleFor: (u) => (u.id === 'claude:abc' ? 'Fix the login flake' : null),
    onLandings: (l) => pushed.push(l),
    onOpen: (t) => opened.push(t)
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
      prefs: { notifications: false, sound: false, badge: false }
    })
    finish(desk, 't1', 'abc')
    await vi.runAllTimersAsync()
    expect(seen).toMatchObject({ badges: [], sounds: [], banners: [], bounces: 0 })
    expect(pushed.at(-1)?.map((l) => l.id)).toEqual(['claude:abc'])

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
