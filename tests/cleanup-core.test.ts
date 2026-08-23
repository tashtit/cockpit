import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STALE_DAYS,
  MAX_STALE_DAYS,
  MIN_STALE_DAYS,
  clampStaleDays,
  isStale,
  isUnder,
  lastWorktreeActivity,
  parseWorktreeList,
  staleCutoff,
  sumBytes,
  worktreeBlocks,
  worktreeOrigin
} from '../src/main/cleanup-core'

const DAY = 86_400_000

describe('clampStaleDays', () => {
  it('keeps a sane value', () => {
    expect(clampStaleDays(90)).toBe(90)
  })

  it('floors renderer input below the guard rail', () => {
    expect(clampStaleDays(1)).toBe(MIN_STALE_DAYS)
    expect(clampStaleDays(0)).toBe(MIN_STALE_DAYS)
    expect(clampStaleDays(-5000)).toBe(MIN_STALE_DAYS)
  })

  it('caps absurd values', () => {
    expect(clampStaleDays(1e9)).toBe(MAX_STALE_DAYS)
  })

  it('falls back to the default for junk', () => {
    expect(clampStaleDays('nonsense')).toBe(DEFAULT_STALE_DAYS)
    expect(clampStaleDays(undefined)).toBe(DEFAULT_STALE_DAYS)
    expect(clampStaleDays(NaN)).toBe(DEFAULT_STALE_DAYS)
  })

  it('truncates fractions rather than rejecting them', () => {
    expect(clampStaleDays(30.9)).toBe(30)
  })
})

describe('staleCutoff / isStale', () => {
  const now = 1_700_000_000_000

  it('puts the cutoff N clamped days back', () => {
    expect(staleCutoff(30, now)).toBe(now - 30 * DAY)
    // the floor applies here too — a 1-day threshold can never reach the cutoff
    expect(staleCutoff(1, now)).toBe(now - MIN_STALE_DAYS * DAY)
  })

  it('calls anything older than the cutoff stale', () => {
    const cutoff = staleCutoff(30, now)
    expect(isStale(now - 31 * DAY, cutoff)).toBe(true)
    expect(isStale(now - 29 * DAY, cutoff)).toBe(false)
    // no evidence of activity at all reads as maximally stale
    expect(isStale(0, cutoff)).toBe(true)
  })
})

describe('parseWorktreeList', () => {
  const porcelain = [
    'worktree /repos/app',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /userData/worktrees/app/fix-login',
    'HEAD def456',
    'branch refs/heads/cockpit/fix-login',
    '',
    'worktree /repos/app/.claude/worktrees/spike',
    'HEAD 999aaa',
    'detached',
    '',
    'worktree /repos/app/gone',
    'HEAD 111bbb',
    'branch refs/heads/old',
    'prunable gitdir file points to non-existent location',
    '',
    'worktree /repos/app/held',
    'HEAD 222ccc',
    'branch refs/heads/held',
    'locked under review',
    ''
  ].join('\n')

  it('reads every record, main first', () => {
    const list = parseWorktreeList(porcelain)
    expect(list.map((w) => w.path)).toEqual([
      '/repos/app',
      '/userData/worktrees/app/fix-login',
      '/repos/app/.claude/worktrees/spike',
      '/repos/app/gone',
      '/repos/app/held'
    ])
  })

  it('strips the refs/heads/ prefix off branches', () => {
    expect(parseWorktreeList(porcelain)[1].branch).toBe('cockpit/fix-login')
  })

  it('carries detached, prunable and locked through', () => {
    const [, , detached, prunable, locked] = parseWorktreeList(porcelain)
    expect(detached.detached).toBe(true)
    expect(detached.branch).toBeNull()
    expect(prunable.prunable).toBe(true)
    expect(locked.locked).toBe(true)
  })

  it('handles a bare repository record', () => {
    const [w] = parseWorktreeList('worktree /repos/bare\nbare\n')
    expect(w.bare).toBe(true)
    expect(w.branch).toBeNull()
  })

  it('ignores attribute lines it does not know', () => {
    const [w] = parseWorktreeList('worktree /repos/app\nHEAD abc\nsomething-new yes\n')
    expect(w.path).toBe('/repos/app')
    expect(w.head).toBe('abc')
  })

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([])
    expect(parseWorktreeList('\n\n')).toEqual([])
  })
})

describe('isUnder / worktreeOrigin', () => {
  it('treats a directory as under itself', () => {
    expect(isUnder('/a/b', '/a/b')).toBe(true)
  })

  it('does not match a sibling with a shared prefix', () => {
    expect(isUnder('/a/bcd', '/a/b')).toBe(false)
  })

  it('calls Cockpit-owned worktrees cockpit and everything else external', () => {
    const root = '/userData/worktrees'
    expect(worktreeOrigin('/userData/worktrees/app/fix', root)).toBe('cockpit')
    // Claude Code cuts its own worktrees inside the repo — found, but never ours
    expect(worktreeOrigin('/repos/app/.claude/worktrees/spike', root)).toBe('external')
    expect(worktreeOrigin('/userData/worktrees-old/app', root)).toBe('external')
  })
})

describe('worktreeBlocks', () => {
  const clean = { isMain: false, locked: false, dirty: false, busy: false, roundtable: false }

  it('clears a quiet, clean worktree', () => {
    expect(worktreeBlocks(clean)).toEqual([])
  })

  it('never offers the repository’s own checkout', () => {
    expect(worktreeBlocks({ ...clean, isMain: true })).toEqual(['main'])
  })

  it('protects uncommitted work, live agents, rooms and locks', () => {
    expect(worktreeBlocks({ ...clean, dirty: true })).toEqual(['dirty'])
    expect(worktreeBlocks({ ...clean, busy: true })).toEqual(['busy'])
    expect(worktreeBlocks({ ...clean, roundtable: true })).toEqual(['roundtable'])
    expect(worktreeBlocks({ ...clean, locked: true })).toEqual(['locked'])
  })

  it('orders several blocks most-fundamental first', () => {
    expect(worktreeBlocks({ isMain: true, locked: true, dirty: true, busy: true, roundtable: true }))
      .toEqual(['main', 'roundtable', 'busy', 'dirty', 'locked'])
  })
})

describe('lastWorktreeActivity', () => {
  it('takes the newest signal it was given', () => {
    expect(lastWorktreeActivity([100, 900, 400])).toBe(900)
  })

  it('drops missing signals rather than counting them as recent', () => {
    expect(lastWorktreeActivity([null, undefined, 500])).toBe(500)
  })

  it('reports no evidence as 0', () => {
    expect(lastWorktreeActivity([null, undefined, 0])).toBe(0)
  })
})

describe('sumBytes', () => {
  it('adds sizes and treats unmeasurable ones as zero', () => {
    expect(sumBytes([{ bytes: 10 }, { bytes: null }, { bytes: 5 }])).toBe(15)
  })
})
