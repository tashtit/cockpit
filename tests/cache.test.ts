import { describe, expect, it } from 'vitest'
import { throttled, throttledBy } from '../src/main/cache'

describe('throttled', () => {
  it('remembers a result for the TTL and coalesces concurrent calls into one run', async () => {
    let now = 1_000
    let runs = 0
    const get = throttled(
      60_000,
      async () => {
        runs++
        return { runs }
      },
      { now: () => now }
    )
    const [a, b] = await Promise.all([get(), get()])
    expect(runs).toBe(1)
    expect(a).toBe(b)
    now += 59_999
    expect(await get()).toBe(a)
    expect(runs).toBe(1)
    now += 1
    const c = await get()
    expect(runs).toBe(2)
    expect(c).not.toBe(a)
  })

  it('does not remember a failed run — the next call tries again', async () => {
    let fail = true
    let runs = 0
    const get = throttled(60_000, async () => {
      runs++
      if (fail) throw new Error('gh failed')
      return 'ok'
    })
    await expect(get()).rejects.toThrow('gh failed')
    fail = false
    expect(await get()).toBe('ok')
    expect(await get()).toBe('ok')
    expect(runs).toBe(2)
  })

  it('asks again once forgotten', async () => {
    let runs = 0
    const get = throttled(60_000, async () => ++runs)
    expect(await get()).toBe(1)
    expect(await get()).toBe(1)
    get.forget()
    expect(await get()).toBe(2)
  })
})

describe('throttledBy', () => {
  it('keeps one answer per key, and shares the run in flight for a key', async () => {
    const asked: string[] = []
    const get = throttledBy(60_000, async (key: string) => {
      asked.push(key)
      return key.toUpperCase()
    })
    const first = get('a')
    expect(get('a')).toBe(first)
    expect(await Promise.all([first, get('b')])).toEqual(['A', 'B'])
    expect(await get('a')).toBe('A')
    expect(asked).toEqual(['a', 'b'])
  })

  it('tells record keys apart by keyOf', async () => {
    let runs = 0
    const get = throttledBy(
      60_000,
      async ({ provider, home }: { provider: string; home: string }) => `${provider}@${home}#${++runs}`,
      { keyOf: ({ provider, home }) => `${provider}|${home}` }
    )
    expect(await get({ provider: 'codex', home: '/a' })).toBe('codex@/a#1')
    expect(await get({ provider: 'codex', home: '/a' })).toBe('codex@/a#1')
    expect(await get({ provider: 'codex', home: '/b' })).toBe('codex@/b#2')
  })

  it('a forced call runs again, and an older run landing after it is not what is kept', async () => {
    const release: Array<(v: string) => void> = []
    const get = throttledBy(60_000, () => new Promise<string>((r) => release.push(r)))
    const slow = get('k')
    const forced = get('k', { force: true })
    expect(forced).not.toBe(slow)
    release[1]!('new')
    expect(await forced).toBe('new')
    release[0]!('old')
    expect(await slow).toBe('old')
    expect(await get('k')).toBe('new')
  })

  it('remembers a resolved null, and forgets a rejection', async () => {
    let runs = 0
    const get = throttledBy(60_000, async (key: string) => {
      runs++
      if (key === 'bad' && runs < 3) throw new Error('offline')
      return null
    })
    expect(await get('none')).toBeNull()
    expect(await get('none')).toBeNull()
    await expect(get('bad')).rejects.toThrow('offline')
    expect(await get('bad')).toBeNull()
    expect(runs).toBe(3)
  })

  it('forgets what it remembered, for one key or for all of them', async () => {
    let runs = 0
    const get = throttledBy(60_000, async (key: string) => `${key}#${++runs}`)
    expect(await get('a')).toBe('a#1')
    expect(await get('b')).toBe('b#2')
    get.forget('a')
    expect(await get('a')).toBe('a#3')
    expect(await get('b')).toBe('b#2')
    get.forget()
    expect(await get('b')).toBe('b#4')
  })

  // a write settled while a gathering is under way makes that gathering's answer stale:
  // it still reaches the callers that asked, but must not be kept for the next one
  it('answers a run forgotten mid-flight, and keeps nothing it found', async () => {
    const release: Array<(v: string) => void> = []
    const get = throttledBy(60_000, () => new Promise<string>((r) => release.push(r)))
    const before = get('k')
    get.forget('k')
    // a call after the forget does not ride on the stale run
    const after = get('k')
    expect(after).not.toBe(before)
    release[0]!('pre-write')
    expect(await before).toBe('pre-write')
    release[1]!('post-write')
    expect(await after).toBe('post-write')
    expect(await get('k')).toBe('post-write')
    expect(release).toHaveLength(2)
  })

  it('does not keep a run forgotten mid-flight, even when nothing asked after it', async () => {
    const release: Array<(v: string) => void> = []
    const get = throttledBy(60_000, () => new Promise<string>((r) => release.push(r)))
    const stale = get('k')
    get.forget()
    release[0]!('pre-write')
    expect(await stale).toBe('pre-write')
    const fresh = get('k')
    release[1]!('post-write')
    expect(await fresh).toBe('post-write')
  })

  // a plain call made while a forced one runs shares it; an older plain run landing
  // after the forced one neither clears it nor replaces what it kept
  it('lets a forced run win over a plain one, whichever lands last', async () => {
    const release: Array<(v: string) => void> = []
    const get = throttledBy(60_000, () => new Promise<string>((r) => release.push(r)))
    const plain = get('k')
    const forced = get('k', { force: true })
    const rider = get('k')
    expect(rider).toBe(forced)
    release[0]!('plain')
    expect(await plain).toBe('plain')
    // the older run landing did not clear the forced one out of flight
    expect(get('k')).toBe(forced)
    release[1]!('forced')
    expect(await forced).toBe('forced')
    expect(await get('k')).toBe('forced')
    expect(release).toHaveLength(2)
  })

  it('turns a compute that throws before its promise into a rejection', async () => {
    const get = throttledBy(60_000, (key: string): Promise<string> => {
      throw new Error(`no ${key}`)
    })
    await expect(get('x')).rejects.toThrow('no x')
  })
})
