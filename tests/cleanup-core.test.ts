import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STALE_DAYS,
  MAX_STALE_DAYS,
  MIN_STALE_DAYS,
  clampStaleDays,
  isStale,
  isUnder,
  judgeProcesses,
  lastWorktreeActivity,
  ownProcessTree,
  parseElapsed,
  parseLsofCwds,
  parsePs,
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
  const clean = {
    isMain: false,
    locked: false,
    dirty: false,
    busy: false,
    roundtable: false,
    processes: false
  }

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
    expect(worktreeBlocks({ ...clean, processes: true })).toEqual(['process'])
  })

  it('orders several blocks most-fundamental first', () => {
    expect(
      worktreeBlocks({
        isMain: true,
        locked: true,
        dirty: true,
        busy: true,
        roundtable: true,
        processes: true
      })
    ).toEqual(['main', 'roundtable', 'busy', 'process', 'dirty', 'locked'])
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

describe('parseLsofCwds', () => {
  it('pairs each pid with its working directory', () => {
    const out = 'p10\nfcwd\nn/repos/app\np22\nfcwd\nn/wt/app/fix login\n'
    expect(parseLsofCwds(out)).toEqual(
      new Map([
        [10, '/repos/app'],
        [22, '/wt/app/fix login']
      ])
    )
  })

  it('drops the marker Linux puts on a deleted directory', () => {
    expect(parseLsofCwds('p7\nn/wt/gone (deleted)\n').get(7)).toBe('/wt/gone')
  })

  it('ignores names that belong to no readable pid', () => {
    expect(parseLsofCwds('n/orphan\npabc\nn/also\n').size).toBe(0)
  })
})

describe('parseElapsed', () => {
  it('reads every shape ps prints', () => {
    expect(parseElapsed('00:05')).toBe(5)
    expect(parseElapsed('12:34')).toBe(754)
    expect(parseElapsed('01:00:00')).toBe(3600)
    expect(parseElapsed('3-02:00:01')).toBe(3 * 86_400 + 7201)
  })

  it('refuses anything else', () => {
    expect(parseElapsed('yesterday')).toBeNull()
  })
})

describe('parsePs', () => {
  it('keeps the whole command line, spaces included', () => {
    const now = 1_000_000_000
    const rows = parsePs('  501     1   01:40 node /wt/app/node_modules/.bin/vite --port 5173\n', now)
    expect(rows).toEqual([
      {
        pid: 501,
        ppid: 1,
        startedAt: now - 100_000,
        command: 'node /wt/app/node_modules/.bin/vite --port 5173'
      }
    ])
  })
})

describe('ownProcessTree', () => {
  const rows = [
    { pid: 1, ppid: 0, startedAt: 0, command: 'launchd' },
    { pid: 10, ppid: 1, startedAt: 0, command: 'zsh' },
    { pid: 11, ppid: 10, startedAt: 0, command: 'npm run dev' },
    { pid: 12, ppid: 11, startedAt: 0, command: 'electron' },
    { pid: 13, ppid: 12, startedAt: 0, command: 'claude -p' },
    { pid: 14, ppid: 13, startedAt: 0, command: 'git status' },
    { pid: 20, ppid: 1, startedAt: 0, command: 'vite' }
  ]

  it('covers what launched the app and everything it spawned, never init or strangers', () => {
    expect([...ownProcessTree(rows, 12)].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14])
  })
})

describe('judgeProcesses', () => {
  const proc = (pid: number, cwd: string) => ({
    pid,
    ppid: 1,
    command: 'node server.js',
    startedAt: pid,
    cwd
  })
  const tree = {
    repoName: 'app',
    branch: 'cockpit/fix',
    isMain: false,
    stale: true,
    missing: false
  }
  const worktrees = [
    { ...tree, path: '/repos/app', isMain: true, branch: 'main', stale: true },
    { ...tree, path: '/wt/app/fix' },
    { ...tree, path: '/wt/app/fresh', stale: false },
    { ...tree, path: '/repos/app/.claude/worktrees/spike', branch: 'spike' }
  ]
  const homes = [
    { path: '/wt', repoName: null },
    { path: '/repos/app/.claude/worktrees', repoName: 'app' }
  ]
  const onDisk = new Set(['/repos/app', '/repos/app/src', '/wt', '/wt/app', '/wt/app/fix', '/wt/app/fresh', '/repos/app/.claude/worktrees', '/repos/app/.claude/worktrees/spike'])
  const judge = (processes: ReturnType<typeof proc>[]) =>
    judgeProcesses({ processes, worktrees, homes, exists: (p) => onDisk.has(p) })

  it('finds a process in a stale worktree', () => {
    const [p] = judge([proc(1, '/wt/app/fix')])
    expect(p).toMatchObject({ worktreePath: '/wt/app/fix', branch: 'cockpit/fix', directoryGone: false })
  })

  it('leaves the repository’s own checkout and worktrees still in use alone', () => {
    expect(judge([proc(1, '/repos/app/src'), proc(2, '/wt/app/fresh')])).toEqual([])
  })

  it('credits a nested worktree, not the checkout holding it', () => {
    const [p] = judge([proc(1, '/repos/app/.claude/worktrees/spike')])
    expect(p?.branch).toBe('spike')
  })

  it('finds a process whose worktree was removed from under it', () => {
    const [a, b] = judge([
      proc(1, '/wt/app/removed/packages/web'),
      proc(2, '/repos/app/.claude/worktrees/old')
    ])
    expect(a).toMatchObject({ worktreePath: '/wt/app/removed', repoName: null, directoryGone: true })
    expect(b).toMatchObject({ worktreePath: '/repos/app/.claude/worktrees/old', repoName: 'app' })
  })

  it('ignores a deleted directory that never was a worktree', () => {
    expect(judge([proc(1, '/tmp/scratch'), proc(2, '/repos/app/build')])).toEqual([])
  })

  it('lists the longest-running first', () => {
    expect(judge([proc(9, '/wt/app/fix'), proc(3, '/wt/app/fix')]).map((p) => p.pid)).toEqual([3, 9])
  })
})
