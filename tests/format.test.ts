import { describe, it, expect } from 'vitest'
import { plural, usageSpent } from '../src/renderer/src/format'

describe('plural', () => {
  it('says one of a thing, and adds an s past one — or none', () => {
    expect(plural(1, 'file')).toBe('1 file')
    expect(plural(3, 'file')).toBe('3 files')
    expect(plural(0, 'file')).toBe('0 files')
  })

  it('takes the plural a noun really has', () => {
    expect(plural(1, 'process', 'processes')).toBe('1 process')
    expect(plural(2, 'more reply', 'more replies')).toBe('2 more replies')
  })
})

describe('usageSpent', () => {
  const tokens = { input: 900, output: 400, cacheRead: 0, cacheCreate: 0 }

  it('reads a measured window as tokens, with its requests when it counts them', () => {
    expect(usageSpent({ label: '5h', tokens })).toBe('1.3k tokens')
    expect(usageSpent({ label: '5h', tokens, requests: 12 })).toBe('1.3k tokens · 12 requests')
    expect(usageSpent({ label: '5h', tokens, requests: 1 })).toBe('1.3k tokens · 1 request')
  })

  it('says a measured window with no requests in it had no activity', () => {
    expect(usageSpent({ label: '5h', tokens, requests: 0 })).toBe('no activity')
  })

  it('reads a counted window as requests, and what went beyond the plan', () => {
    expect(usageSpent({ label: 'month', requests: 310 })).toBe('310 used')
    expect(usageSpent({ label: 'month', requests: 310, requestsBilled: 4 })).toBe('310 used · 4 billed beyond plan')
  })

  it('has nothing to say for a window that reports only a percentage', () => {
    expect(usageSpent({ label: 'week', usedPercent: 42 })).toBeNull()
  })
})
