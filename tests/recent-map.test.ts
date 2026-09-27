import { describe, expect, it } from 'vitest'
import { capRecent, isLatest, withRecent } from '../src/main/recent-map'

describe('recency maps', () => {
  const map = { 'claude:a': 'e1', 'claude:b': 'e2' }

  it('re-inserts an entry last, so key order stays recency, and keeps the newest past the cap', () => {
    expect(Object.keys(withRecent(map, { id: 'claude:a', value: 'e1', cap: 10 }))).toEqual(['claude:b', 'claude:a'])
    expect(withRecent(map, { id: 'claude:c', value: 'e3', cap: 2 })).toEqual({ 'claude:b': 'e2', 'claude:c': 'e3' })
    expect(capRecent(map, 1)).toEqual({ 'claude:b': 'e2' })
    expect(capRecent(map, 0)).toEqual({})
  })

  it('knows a write that would change nothing: the newest entry already says it', () => {
    expect(isLatest(map, 'claude:b', 'e2')).toBe(true)
    // older, or a different value, is a write — the recency moves
    expect(isLatest(map, 'claude:a', 'e1')).toBe(false)
    expect(isLatest(map, 'claude:b', 'e9')).toBe(false)
    expect(isLatest({}, 'claude:b', 'e2')).toBe(false)
  })
})
