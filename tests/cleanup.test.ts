import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteSessions, removeWorktrees, scanCleanup, type CleanupDeps } from '../src/main/cleanup'
import type { SessionMeta } from '../src/shared/types'

/**
 * Cleanup against real git repositories and real files in a tmpdir — the same
 * fixture style as indexer/repos tests. Nothing is mocked: worktrees are created
 * with `git worktree add` and removed with the code under test, so the safety
 * rules (dirty is refused, the main checkout is never offered, only merged
 * branches go) are exercised against git's own behaviour.
 */

// macOS tmpdir is a symlink (/var → /private/var) and git reports real paths —
// resolve once so fixture paths and git's output are the same strings
const root = join(realpathSync(tmpdir()), 'cockpit-cleanup-fixtures')
const mainRepo = join(root, 'app')
const cockpitWorktrees = join(root, 'userData', 'worktrees')
const sourceDir = join(root, 'sources', 'claude')

const DAY = 86_400_000
const OLD = Date.now() - 400 * DAY

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_AUTHOR_DATE: new Date(OLD).toISOString(),
      GIT_COMMITTER_DATE: new Date(OLD).toISOString()
    }
  })
}

/** Backdate a directory so the scan sees it as long-abandoned. */
function backdate(path: string): void {
  const t = OLD / 1000
  utimesSync(path, t, t)
}

function session(over: Partial<SessionMeta> & { id: string; sourcePath: string }): SessionMeta {
  return {
    provider: 'claude',
    nativeId: over.id,
    source: sourceDir,
    title: over.id,
    cwd: null,
    gitBranch: null,
    startedAt: OLD,
    updatedAt: OLD,
    messageCount: 1,
    ...over
  }
}

let sessions: SessionMeta[] = []
let busy = new Set<string>()
let rooms = new Set<string>()

const deps: CleanupDeps = {
  sessions: () => sessions,
  repoRoots: () => [mainRepo],
  cockpitWorktreeRoot: cockpitWorktrees,
  busyIds: () => busy,
  tableForCwd: (cwd) => (rooms.has(cwd) ? 'table-1' : null),
  sourceDirs: () => [sourceDir]
}

const cockpitTree = join(cockpitWorktrees, 'app', 'fix-login')
const externalTree = join(mainRepo, '.claude', 'worktrees', 'spike')
const dirtyTree = join(cockpitWorktrees, 'app', 'in-progress')

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(mainRepo, { recursive: true })
  mkdirSync(cockpitWorktrees, { recursive: true })
  mkdirSync(sourceDir, { recursive: true })

  git(mainRepo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(mainRepo, 'README.md'), '# app\n')
  git(mainRepo, ['add', '.'])
  git(mainRepo, ['commit', '-q', '-m', 'init'])

  // Cockpit's own worktree, on a branch with nothing the main branch lacks
  git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/fix-login', cockpitTree])
  // a worktree Cockpit never created — Claude Code cuts these inside the repo
  git(mainRepo, ['worktree', 'add', '-q', '-b', 'spike', externalTree])
  // one with uncommitted work, which must never be removable
  git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/in-progress', dirtyTree])
  writeFileSync(join(dirtyTree, 'scratch.txt'), 'unsaved work\n')

  for (const p of [cockpitTree, externalTree, dirtyTree, mainRepo]) backdate(p)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanCleanup — worktrees', () => {
  it('finds worktrees Cockpit never created, and says which are its own', async () => {
    const report = await scanCleanup(deps, 30)
    const byPath = new Map(report.worktrees.map((w) => [w.path, w]))
    expect(byPath.get(cockpitTree)?.origin).toBe('cockpit')
    expect(byPath.get(externalTree)?.origin).toBe('external')
  })

  it('never offers the repository’s own checkout', async () => {
    const report = await scanCleanup(deps, 30)
    expect(report.worktrees.some((w) => w.path === mainRepo)).toBe(false)
    // and it is left out of the denominator too — only linked worktrees are counted
    expect(report.totalWorktrees).toBe(3)
  })

  it('blocks a worktree with uncommitted changes', async () => {
    const report = await scanCleanup(deps, 30)
    const dirty = report.worktrees.find((w) => w.path === dirtyTree)
    expect(dirty?.blocks).toEqual(['dirty'])
  })

  it('blocks a worktree an agent is running in', async () => {
    sessions = [session({ id: 'claude:live', sourcePath: join(sourceDir, 'live.jsonl'), cwd: cockpitTree })]
    busy = new Set(['claude:live'])
    const report = await scanCleanup(deps, 30)
    expect(report.worktrees.find((w) => w.path === cockpitTree)?.blocks).toEqual(['busy'])
    sessions = []
    busy = new Set()
  })

  it('blocks a roundtable’s shared room', async () => {
    rooms = new Set([externalTree])
    const report = await scanCleanup(deps, 30)
    expect(report.worktrees.find((w) => w.path === externalTree)?.blocks).toEqual(['roundtable'])
    rooms = new Set()
  })

  it('leaves recent worktrees alone when the threshold is long', async () => {
    // everything here is backdated ~400 days; a year-long threshold still catches
    // them, a threshold longer than their age does not
    const report = await scanCleanup(deps, 3000)
    expect(report.worktrees).toEqual([])
    expect(report.staleWorktreeCount).toBe(0)
  })

  it('rides a worktree on the sessions inside it instead of listing it twice', async () => {
    sessions = [
      session({ id: 'claude:a', sourcePath: join(sourceDir, 'a.jsonl'), cwd: cockpitTree }),
      session({ id: 'claude:b', sourcePath: join(sourceDir, 'b.jsonl'), cwd: join(cockpitTree, 'src') })
    ]
    const report = await scanCleanup(deps, 30)
    // both rows carry it, and it says how many sessions have to go for it to go
    for (const row of report.sessions) {
      expect(row.worktree?.path).toBe(cockpitTree)
      expect(row.worktree?.sessionCount).toBe(2)
    }
    // and it is not also standing on its own in the leftovers
    expect(report.worktrees.some((w) => w.path === cockpitTree)).toBe(false)
    sessions = []
  })

  it('leaves a worktree unattached when it is the repo’s own checkout', async () => {
    sessions = [session({ id: 'claude:main', sourcePath: join(sourceDir, 'm.jsonl'), cwd: mainRepo })]
    const report = await scanCleanup(deps, 30)
    // deleting a session must never be able to take the user's working copy
    expect(report.sessions[0].worktree).toBeNull()
    sessions = []
  })

  it('leaves a worktree unattached when it has uncommitted work', async () => {
    sessions = [session({ id: 'claude:d', sourcePath: join(sourceDir, 'd.jsonl'), cwd: dirtyTree })]
    const report = await scanCleanup(deps, 30)
    expect(report.sessions[0].worktree).toBeNull()
    // it stays visible as a leftover, with its reason
    expect(report.worktrees.find((w) => w.path === dirtyTree)?.blocks).toEqual(['dirty'])
    sessions = []
  })
})

describe('scanCleanup — sessions', () => {
  it('lists only sessions idle past the threshold, oldest first', async () => {
    const recent = join(sourceDir, 'recent.jsonl')
    const ancient = join(sourceDir, 'ancient.jsonl')
    writeFileSync(recent, 'x'.repeat(100))
    writeFileSync(ancient, 'y'.repeat(400))
    sessions = [
      session({ id: 'claude:recent', sourcePath: recent, updatedAt: Date.now() - 2 * DAY }),
      session({ id: 'claude:ancient', sourcePath: ancient, updatedAt: OLD })
    ]
    const report = await scanCleanup(deps, 30)
    expect(report.sessions.map((s) => s.id)).toEqual(['claude:ancient'])
    expect(report.sessions[0].bytes).toBe(400)
    expect(report.staleSessionBytes).toBe(400)
    expect(report.totalSessions).toBe(2)
    sessions = []
  })

  it('sizes a copilot session by its whole state directory', async () => {
    const dir = join(sourceDir, 'session-state', 'abc')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), 'z'.repeat(50))
    writeFileSync(join(dir, 'state.json'), 'z'.repeat(25))
    sessions = [
      session({ id: 'copilot:abc', provider: 'copilot', sourcePath: join(dir, 'events.jsonl') })
    ]
    const report = await scanCleanup(deps, 30)
    expect(report.sessions[0].bytes).toBe(75)
    sessions = []
  })
})

describe('deleteSessions', () => {
  it('deletes the provider’s own log file and reports what it freed', async () => {
    const file = join(sourceDir, 'delete-me.jsonl')
    writeFileSync(file, 'q'.repeat(64))
    sessions = [session({ id: 'claude:del', sourcePath: file })]
    const res = await deleteSessions(deps, ['claude:del'], 30)
    expect(res.cleaned).toBe(1)
    expect(res.freedBytes).toBe(64)
    expect(existsSync(file)).toBe(false)
    sessions = []
  })

  it('removes a copilot session’s whole directory', async () => {
    const dir = join(sourceDir, 'session-state', 'gone')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), 'e')
    writeFileSync(join(dir, 'other.json'), 'o')
    sessions = [
      session({ id: 'copilot:gone', provider: 'copilot', sourcePath: join(dir, 'events.jsonl') })
    ]
    expect((await deleteSessions(deps, ['copilot:gone'], 30)).cleaned).toBe(1)
    expect(existsSync(dir)).toBe(false)
    sessions = []
  })

  it('refuses a file outside every configured source', async () => {
    const outside = join(root, 'not-a-source.jsonl')
    writeFileSync(outside, 'important')
    sessions = [session({ id: 'claude:outside', sourcePath: outside })]
    const res = await deleteSessions(deps, ['claude:outside'], 30)
    expect(res.cleaned).toBe(0)
    expect(res.failed[0].reason).toMatch(/outside every configured source/)
    expect(existsSync(outside)).toBe(true)
    sessions = []
  })

  it('refuses an id the indexer does not know', async () => {
    sessions = []
    const res = await deleteSessions(deps, ['claude:../../etc/passwd'], 30)
    expect(res.cleaned).toBe(0)
    expect(res.failed[0].reason).toMatch(/no longer indexed/)
  })

  it('refuses a session an agent is running in', async () => {
    const file = join(sourceDir, 'busy.jsonl')
    writeFileSync(file, 'b')
    sessions = [session({ id: 'claude:busy', sourcePath: file })]
    busy = new Set(['claude:busy'])
    const res = await deleteSessions(deps, ['claude:busy'], 30)
    expect(res.cleaned).toBe(0)
    expect(existsSync(file)).toBe(true)
    busy = new Set()
    sessions = []
  })
})

describe('removeWorktrees', () => {
  it('refuses a path that is not a worktree of any known repo', async () => {
    const res = await removeWorktrees(deps, ['/tmp/somewhere-else'])
    expect(res.cleaned).toBe(0)
    expect(res.failed[0].reason).toMatch(/not a worktree/)
  })

  it('refuses a worktree with uncommitted changes and leaves it on disk', async () => {
    const res = await removeWorktrees(deps, [dirtyTree])
    expect(res.cleaned).toBe(0)
    expect(res.failed[0].reason).toMatch(/uncommitted/)
    expect(existsSync(dirtyTree)).toBe(true)
  })

  it('refuses the repository’s own checkout', async () => {
    const res = await removeWorktrees(deps, [mainRepo])
    expect(res.cleaned).toBe(0)
    expect(existsSync(join(mainRepo, 'README.md'))).toBe(true)
  })

  it('removes a clean worktree and deletes its fully-merged branch', async () => {
    const res = await removeWorktrees(deps, [cockpitTree])
    expect(res.cleaned).toBe(1)
    expect(existsSync(cockpitTree)).toBe(false)
    expect(res.branchesDeleted).toContain('cockpit/fix-login')
    expect(git(mainRepo, ['branch', '--list'])).not.toMatch(/cockpit\/fix-login/)
  })

  it('removes the worktree but keeps a branch git will not part with', async () => {
    // an unmerged commit makes `git branch -d` refuse — the directory still goes,
    // and the work stays reachable on the branch
    writeFileSync(join(externalTree, 'spike.txt'), 'exploration\n')
    git(externalTree, ['add', '.'])
    git(externalTree, ['commit', '-q', '-m', 'spike work'])
    const res = await removeWorktrees(deps, [externalTree])
    expect(res.cleaned).toBe(1)
    expect(existsSync(externalTree)).toBe(false)
    expect(res.branchesDeleted).toEqual([])
    expect(git(mainRepo, ['branch', '--list'])).toMatch(/spike/)
  })

  it('clears a registration whose directory is already gone', async () => {
    const ghost = join(cockpitWorktrees, 'app', 'ghost')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/ghost', ghost])
    rmSync(ghost, { recursive: true, force: true })
    const before = await scanCleanup(deps, 30)
    expect(before.worktrees.find((w) => w.path === ghost)?.missing).toBe(true)
    const res = await removeWorktrees(deps, [ghost])
    expect(res.cleaned).toBe(1)
    expect(git(mainRepo, ['worktree', 'list'])).not.toMatch(/ghost/)
  })
})

describe('scan sizing', () => {
  it('measures a worktree that is still on disk', async () => {
    const tree = join(cockpitWorktrees, 'app', 'sized')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/sized', tree])
    writeFileSync(join(tree, 'payload.bin'), 'p'.repeat(20_000))
    backdate(tree)
    const report = await scanCleanup(deps, 30)
    const sized = report.worktrees.find((w) => w.path === tree)
    expect(sized?.bytes).toBeGreaterThan(0)
    expect(statSync(tree).isDirectory()).toBe(true)
  })
})

describe('deleteSessions — the worktree cascade', () => {
  /** A fresh, backdated worktree of its own so the tests above can't interfere. */
  function cutWorktree(name: string, branch: string): string {
    const path = join(cockpitWorktrees, 'app', name)
    git(mainRepo, ['worktree', 'add', '-q', '-b', branch, path])
    backdate(path)
    return path
  }

  it('takes the worktree and its merged branch with the session', async () => {
    const tree = cutWorktree('cascade-solo', 'cockpit/cascade-solo')
    const file = join(sourceDir, 'cascade-solo.jsonl')
    writeFileSync(file, 'log'.repeat(10))
    sessions = [session({ id: 'claude:solo', sourcePath: file, cwd: tree })]

    const res = await deleteSessions(deps, ['claude:solo'], 30)
    expect(res.cleaned).toBe(1)
    expect(existsSync(file)).toBe(false)
    // the checkout is what actually held the disk space — it goes too
    expect(existsSync(tree)).toBe(false)
    expect(res.branchesDeleted).toContain('cockpit/cascade-solo')
    sessions = []
  })

  it('keeps a shared worktree when one of its sessions is staying', async () => {
    const tree = cutWorktree('cascade-shared', 'cockpit/cascade-shared')
    const goes = join(sourceDir, 'shared-a.jsonl')
    const stays = join(sourceDir, 'shared-b.jsonl')
    writeFileSync(goes, 'a')
    writeFileSync(stays, 'b')
    sessions = [
      session({ id: 'claude:goes', sourcePath: goes, cwd: tree }),
      session({ id: 'claude:stays', sourcePath: stays, cwd: tree })
    ]

    const res = await deleteSessions(deps, ['claude:goes'], 30)
    expect(res.cleaned).toBe(1)
    expect(existsSync(goes)).toBe(false)
    // one survivor is reason enough to keep the checkout
    expect(existsSync(stays)).toBe(true)
    expect(existsSync(tree)).toBe(true)
    sessions = []
  })

  it('takes a shared worktree once every session in it is going', async () => {
    const tree = cutWorktree('cascade-both', 'cockpit/cascade-both')
    const a = join(sourceDir, 'both-a.jsonl')
    const b = join(sourceDir, 'both-b.jsonl')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    sessions = [
      session({ id: 'claude:both-a', sourcePath: a, cwd: tree }),
      session({ id: 'claude:both-b', sourcePath: b, cwd: join(tree, 'src') })
    ]

    const res = await deleteSessions(deps, ['claude:both-a', 'claude:both-b'], 30)
    expect(res.cleaned).toBe(2)
    expect(existsSync(tree)).toBe(false)
    sessions = []
  })

  it('never takes the repository’s own checkout', async () => {
    const file = join(sourceDir, 'in-main.jsonl')
    writeFileSync(file, 'log')
    sessions = [session({ id: 'claude:in-main', sourcePath: file, cwd: mainRepo })]

    const res = await deleteSessions(deps, ['claude:in-main'], 30)
    expect(res.cleaned).toBe(1)
    expect(existsSync(join(mainRepo, 'README.md'))).toBe(true)
    sessions = []
  })

  it('never takes a worktree with uncommitted work', async () => {
    const tree = cutWorktree('cascade-dirty', 'cockpit/cascade-dirty')
    writeFileSync(join(tree, 'scratch.txt'), 'unsaved\n')
    const file = join(sourceDir, 'cascade-dirty.jsonl')
    writeFileSync(file, 'log')
    sessions = [session({ id: 'claude:dirty', sourcePath: file, cwd: tree })]

    const res = await deleteSessions(deps, ['claude:dirty'], 30)
    expect(res.cleaned).toBe(1)
    expect(existsSync(file)).toBe(false)
    // the transcript goes, the unsaved work does not
    expect(existsSync(join(tree, 'scratch.txt'))).toBe(true)
    sessions = []
  })

  it('leaves a worktree alone when no session of its own was deleted', async () => {
    const tree = cutWorktree('cascade-orphan', 'cockpit/cascade-orphan')
    const elsewhere = join(sourceDir, 'elsewhere.jsonl')
    writeFileSync(elsewhere, 'log')
    sessions = [session({ id: 'claude:elsewhere', sourcePath: elsewhere, cwd: mainRepo })]

    await deleteSessions(deps, ['claude:elsewhere'], 30)
    // orphans are the worktree list's business, never a session delete's
    expect(existsSync(tree)).toBe(true)
    sessions = []
  })
})
