import { describe, it, expect, vi, afterEach } from 'vitest'
import { storedValue } from '../../src/renderer/src/stored-value'

const KEY = 'cockpit:test-pref'

/** A set of ids, the shape that needs its identity held between reads. */
const ids = (): ReturnType<typeof storedValue<ReadonlySet<string>>> =>
  storedValue<ReadonlySet<string>>(KEY, {
    parse: (raw) => new Set(JSON.parse(raw) as string[]),
    serialize: (set) => (set.size === 0 ? null : JSON.stringify([...set])),
    fallback: new Set()
  })

afterEach(() => vi.restoreAllMocks())

describe('storedValue', () => {
  it('reads what storage holds, and the fallback for anything it cannot parse', () => {
    const pref = ids()
    expect(pref.get().size).toBe(0)
    window.localStorage.setItem(KEY, '["a"]')
    expect([...pref.get()]).toEqual(['a'])
    window.localStorage.setItem(KEY, '{not json')
    expect(pref.get().size).toBe(0)
  })

  it('keeps one identity while the stored text is the same', () => {
    const pref = ids()
    pref.set(new Set(['a', 'b']))
    expect(pref.get()).toBe(pref.get())
    expect(window.localStorage.getItem(KEY)).toBe('["a","b"]')
    // null from serialize removes the key
    pref.set(new Set())
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('holds a value storage refused for this run, until a reload drops it', () => {
    const pref = ids()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    pref.set(new Set(['kept']))
    expect([...pref.get()]).toEqual(['kept'])
    expect(window.localStorage.getItem(KEY)).toBeNull()
    pref.reload()
    expect(pref.get().size).toBe(0)
  })

  it('falls back when storage refuses to be read at all', () => {
    const pref = ids()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(pref.get().size).toBe(0)
  })
})
