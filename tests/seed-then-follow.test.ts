import { describe, it, expect } from 'vitest'
import { seedThenFollow } from '../src/renderer/src/seed-then-follow'

/** A push channel the test drives, and a seed it answers when it chooses. */
function channel(): {
  follow: (on: (v: string) => void) => () => void
  push: (v: string) => void
  subscribed: () => boolean
} {
  let listener: ((v: string) => void) | null = null
  return {
    follow: (on) => {
      listener = on
      return () => {
        listener = null
      }
    },
    push: (v) => listener?.(v),
    subscribed: () => listener !== null
  }
}

function seed(): { load: () => Promise<string>; answer: (v: string) => Promise<void>; refuse: () => Promise<void> } {
  let resolve!: (v: string) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  const settle = async (): Promise<void> => {
    await promise.catch(() => {})
    await Promise.resolve()
  }
  return {
    load: () => promise,
    answer: (v) => (resolve(v), settle()),
    refuse: () => (reject(new Error('main refused')), settle())
  }
}

describe('seedThenFollow', () => {
  it('seeds with the current value, then follows every push', async () => {
    const ch = channel()
    const s = seed()
    const seen: string[] = []
    seedThenFollow(s.load, ch.follow, (v) => seen.push(v))
    await s.answer('now')
    ch.push('next')
    expect(seen).toEqual(['now', 'next'])
  })

  it('lets a push that beats the seed stand — the seed is older', async () => {
    const ch = channel()
    const s = seed()
    const seen: string[] = []
    seedThenFollow(s.load, ch.follow, (v) => seen.push(v))
    ch.push('newer')
    await s.answer('older')
    expect(seen).toEqual(['newer'])
  })

  it('drops a refused seed and lands nothing once stopped', async () => {
    const ch = channel()
    const refused = seed()
    const seen: string[] = []
    seedThenFollow(refused.load, ch.follow, (v) => seen.push(v))
    await refused.refuse()
    expect(seen).toEqual([])

    const late = seed()
    const stop = seedThenFollow(late.load, ch.follow, (v) => seen.push(v))
    stop()
    await late.answer('late')
    expect(ch.subscribed()).toBe(false)
    expect(seen).toEqual([])
  })
})
