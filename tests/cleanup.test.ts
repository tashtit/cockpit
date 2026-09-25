import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteRoundtables,
  deleteSessions,
  removeWorktrees,
  scanCleanup,
  stopProcesses,
  surveyCleanup,
  type CleanupDeps,
  type CleanupTable
} from '../src/main/cleanup'
import type { OrphanProcess, SessionMeta } from '../src/shared/types'

/**
 * Cleanup against real git repositories and real files in a tmpdir — the same
 * fixture style as indexer/repos tests. Nothing is mocked: worktrees are created
 * with `git worktree add` and removed with the code under test, so the safety
 * rules (dirty is refused, the main checkout is never offered, only merged
 * branches go) are exercised against git's own behaviour.
 */

// a fresh dir per run: parallel checkouts on one machine share tmpdir. macOS tmpdir is
// a symlink (/var → /private/var) and git reports real paths —
// resolve once so fixture paths and git's output are the same strings
const root = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-cleanup-fixtures-'))
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
    logBranch: null,
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
let tables: CleanupTable[] = []
let seats: SessionMeta[] = []
const forgotten: string[] = []

const roundtableRoot = join(root, 'userData', 'roundtables')

const deps: CleanupDeps = {
  sessions: () => sessions,
  repoRoots: () => [mainRepo],
  cockpitWorktreeRoot: cockpitWorktrees,
  busyIds: () => busy,
  tableForCwd: (cwd) => (rooms.has(cwd) ? 'table-1' : null),
  sourceDirs: () => [sourceDir],
  worktreeHomes: () => [],
  // not this test process: the processes these tests spawn are its children, and
  // Cockpit's own process tree is never offered for stopping
  selfPid: -1,
  tables: () => tables,
  seatSessions: () => seats,
  roundtableRoot,
  forgetTable: (id) => forgotten.push(id)
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

  it('blocks a worktree whose status git cannot read, rather than calling it clean', async () => {
    // a status that failed or timed out used to read as clean — and the report, and
    // the daily reminder, then called the worktree ready to go
    const broken = join(cockpitWorktrees, 'app', 'unreadable')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/unreadable', broken])
    const dotGit = join(broken, '.git')
    const pointer = readFileSync(dotGit, 'utf8')
    writeFileSync(dotGit, `gitdir: ${join(root, 'nowhere')}\n`)
    backdate(broken)
    try {
      const { report, ready } = await surveyCleanup(deps, 30)
      expect(report.worktrees.find((w) => w.path === broken)?.blocks).toEqual(['dirty'])
      expect(ready.worktrees).not.toContain(broken)
    } finally {
      writeFileSync(dotGit, pointer)
      git(mainRepo, ['worktree', 'remove', broken])
    }
  })

  it('reads a worktree without writing its index', async () => {
    // `git status` refreshes a stale index and writes it back under index.lock — in a
    // worktree an agent is working in, the agent's own `git commit` then fails on it
    const tree = join(cockpitWorktrees, 'app', 'quiet-read')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/quiet-read', tree])
    const index = git(tree, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim()
    // the same content with a new mtime: the stat data the index holds no longer matches
    const t = (OLD - DAY) / 1000
    utimesSync(join(tree, 'README.md'), t, t)
    backdate(tree)
    const before = readFileSync(index)
    const mtime = statSync(index).mtimeMs
    try {
      const report = await scanCleanup(deps, 30)
      // it was looked at: stale, clean, listed
      expect(report.worktrees.find((w) => w.path === tree)?.blocks).toEqual([])
      expect(statSync(index).mtimeMs).toBe(mtime)
      expect(readFileSync(index).equals(before)).toBe(true)
    } finally {
      git(mainRepo, ['worktree', 'remove', tree])
    }
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

  it('counts a link in a copilot session as itself, never what it points at', async () => {
    // deleting takes the link, not its target — and a link back up the tree used to be
    // walked until the path grew too long, counting the log again at every level
    const dir = join(sourceDir, 'session-state', 'linked')
    const elsewhere = join(root, 'big-elsewhere')
    mkdirSync(dir, { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), 'z'.repeat(50))
    writeFileSync(join(elsewhere, 'blob.bin'), 'b'.repeat(100_000))
    symlinkSync(elsewhere, join(dir, 'out'))
    symlinkSync('.', join(dir, 'loop'))
    const links = lstatSync(join(dir, 'out')).size + lstatSync(join(dir, 'loop')).size
    sessions = [
      session({ id: 'copilot:linked', provider: 'copilot', sourcePath: join(dir, 'events.jsonl') })
    ]
    const report = await scanCleanup(deps, 30)
    expect(report.sessions[0].bytes).toBe(50 + links)
    sessions = []
    rmSync(dir, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  })
})

describe('surveyCleanup — what could go right now', () => {
  it('keys what is ready — a session with the worktree it takes, the leftovers — and never a blocked row', async () => {
    const log = join(sourceDir, 'ready.jsonl')
    writeFileSync(log, 'r'.repeat(300))
    sessions = [
      session({ id: 'claude:ready', sourcePath: log, cwd: cockpitTree }),
      session({ id: 'claude:live', sourcePath: join(sourceDir, 'live-now.jsonl') })
    ]
    busy = new Set(['claude:live'])
    const { report, ready } = await surveyCleanup(deps, 30)
    expect(ready.sessions).toEqual(['claude:ready'])
    // the session's worktree goes with it; the dirty one is the person's to resolve first
    expect(ready.worktrees).toEqual([externalTree])
    expect(ready.processes).toEqual([])
    // each worktree sized once, whichever row carries it
    const carried = report.sessions.find((s) => s.id === 'claude:ready')?.worktree?.bytes ?? 0
    const leftover = report.worktrees.find((w) => w.path === externalTree)?.bytes ?? 0
    expect(ready.bytes).toBe(300 + carried + leftover)
    sessions = []
    busy = new Set()
  })
})

describe('surveyCleanup — one at a time', () => {
  it('hands a second ask the survey already running, and only that', async () => {
    // the view's scan and the daily reminder landing together ran two full surveys
    const first = surveyCleanup(deps, 30)
    expect(surveyCleanup(deps, 30)).toBe(first)
    // another threshold is another question
    const other = surveyCleanup(deps, 90)
    expect(other).not.toBe(first)
    await Promise.all([first, other])
    // once it has answered, the next ask runs its own
    const next = surveyCleanup(deps, 30)
    expect(next).not.toBe(first)
    await next
  })

  it('never hands out a survey begun before a cleanup action ended', async () => {
    // it could list what the action just removed — and the view rescans right after
    const before = surveyCleanup(deps, 30)
    await deleteSessions(deps, [], 30)
    const after = surveyCleanup(deps, 30)
    expect(after).not.toBe(before)
    await Promise.all([before, after])
  })
})

describe('roundtables — the table is the unit', () => {
  const room = join(roundtableRoot, 'rt-old', 'room')

  function table(over: Partial<CleanupTable> = {}): CleanupTable {
    return {
      id: 'rt-old',
      title: 'adopt biome?',
      updatedAt: OLD,
      providers: ['claude', 'codex'],
      entryCount: 4,
      archived: false,
      running: false,
      cwd: room,
      repoRoot: null,
      repoName: null,
      branch: null,
      ...over
    }
  }

  /** A seat session's log inside the table's room, as the indexer would report it. */
  function seat(id: string): SessionMeta {
    const file = join(sourceDir, `${id}.jsonl`)
    writeFileSync(file, '{"type":"user"}\n')
    return session({ id: `claude:${id}`, sourcePath: file, cwd: room, roundtableId: 'rt-old' })
  }

  beforeEach(() => {
    mkdirSync(room, { recursive: true })
    writeFileSync(join(room, 'notes.md'), 'scratch\n')
    backdate(room)
    tables = [table()]
    seats = []
    forgotten.length = 0
  })

  afterEach(() => {
    tables = []
    seats = []
    rmSync(join(roundtableRoot, 'rt-old'), { recursive: true, force: true })
  })

  it('lists a table idle past the threshold, with its seats and what it occupies', async () => {
    seats = [seat('seat-a'), seat('seat-b')]
    const report = await scanCleanup(deps, 30)
    const row = report.tables.find((t) => t.id === 'rt-old')
    expect(row).toMatchObject({ title: 'adopt biome?', seatCount: 2, entryCount: 4, blocks: [] })
    expect(row?.bytes).toBeGreaterThan(0)
    expect(report.totalTables).toBe(1)
    // recent tables stay out of it entirely
    tables = [table({ updatedAt: Date.now() })]
    expect((await scanCleanup(deps, 30)).tables).toEqual([])
  })

  it('lists an archived table at once, however recent it is', async () => {
    // archiving is already the decision — a table need not also go quiet for 30 days
    tables = [table({ updatedAt: Date.now(), archived: true })]
    const report = await scanCleanup(deps, 30)
    expect(report.tables.map((t) => t.id)).toEqual(['rt-old'])
    expect(report.tables[0]?.archived).toBe(true)
    // and a recent table nobody archived still stays out
    tables = [table({ updatedAt: Date.now() })]
    expect((await scanCleanup(deps, 30)).tables).toEqual([])
  })

  it('blocks a table that is mid-round, and refuses to delete it', async () => {
    tables = [table({ running: true })]
    const report = await scanCleanup(deps, 30)
    expect(report.tables[0]?.blocks).toEqual(['busy'])

    const result = await deleteRoundtables(deps, ['rt-old'], 30)
    expect(result.cleaned).toBe(0)
    expect(result.failed[0]?.reason).toMatch(/stop it first/)
    expect(existsSync(room)).toBe(true)
    expect(forgotten).toEqual([])
  })

  it('takes the room, the seat logs and the record together', async () => {
    const a = seat('seat-a')
    seats = [a]
    const result = await deleteRoundtables(deps, ['rt-old'], 30)
    expect(result.cleaned).toBe(1)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(existsSync(room)).toBe(false)
    expect(existsSync(a.sourcePath)).toBe(false)
    expect(forgotten).toEqual(['rt-old'])
  })

  it('never removes a room that sits outside the roundtable directory', async () => {
    const outside = join(root, 'not-a-room')
    mkdirSync(outside, { recursive: true })
    tables = [table({ cwd: outside })]
    const result = await deleteRoundtables(deps, ['rt-old'], 30)
    expect(result.failed[0]?.reason).toMatch(/outside the roundtable directory/)
    expect(existsSync(outside)).toBe(true)
    expect(forgotten).toEqual([])
    rmSync(outside, { recursive: true, force: true })
  })

  it('a repo-backed table gives up its worktree and its merged branch', async () => {
    const tree = join(cockpitWorktrees, 'app', 'rt-layout')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/rt-layout', tree])
    backdate(tree)
    tables = [table({ cwd: tree, repoRoot: mainRepo, repoName: 'app', branch: 'cockpit/rt-layout' })]

    // the worktrees list leaves it alone: it rides on the table's own row
    rooms = new Set([tree])
    const report = await scanCleanup(deps, 30)
    expect(report.worktrees.some((w) => w.path === tree)).toBe(false)
    expect(report.tables[0]?.worktree?.path).toBe(tree)

    const result = await deleteRoundtables(deps, ['rt-old'], 30)
    expect(result.cleaned).toBe(1)
    expect(existsSync(tree)).toBe(false)
    expect(result.branchesDeleted).toEqual(['cockpit/rt-layout'])
    rooms = new Set()
  })

  it('refuses a table whose worktree git would refuse, before any seat log goes', async () => {
    // the seat logs used to be unlinked first: the dirty worktree then kept the table,
    // and its seats had lost the transcripts they resume from
    const tree = join(cockpitWorktrees, 'app', 'rt-dirty')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/rt-dirty', tree])
    writeFileSync(join(tree, 'draft.md'), 'a seat was mid-edit\n')
    const a = seat('seat-a')
    seats = [a]
    tables = [table({ cwd: tree, repoRoot: mainRepo, repoName: 'app', branch: 'cockpit/rt-dirty' })]
    const result = await deleteRoundtables(deps, ['rt-old'], 30)
    expect(result.cleaned).toBe(0)
    expect(result.failed[0]?.reason).toMatch(/uncommitted/)
    expect(existsSync(a.sourcePath)).toBe(true)
    expect(existsSync(tree)).toBe(true)
    expect(forgotten).toEqual([])
  })

  it('refuses a table used again since the scan', async () => {
    tables = [table({ updatedAt: Date.now() - 60_000 })]
    const result = await deleteRoundtables(deps, ['rt-old'], 30)
    expect(result.cleaned).toBe(0)
    expect(result.failed[0]?.reason).toMatch(/used again/)
    expect(existsSync(room)).toBe(true)
  })

  it('refuses a table Cockpit no longer keeps', async () => {
    tables = []
    const result = await deleteRoundtables(deps, ['rt-gone'], 30)
    expect(result.cleaned).toBe(0)
    expect(result.failed[0]?.reason).toMatch(/no longer a roundtable/)
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

  it('deletes every page of a thread kept across several files, and counts them all', async () => {
    const page1 = join(sourceDir, 'rollout-thr.jsonl')
    const page2 = join(sourceDir, 'rollout-thr_next.jsonl')
    writeFileSync(page1, 'a'.repeat(40))
    writeFileSync(page2, 'b'.repeat(24))
    sessions = [
      session({
        id: 'codex:thr',
        provider: 'codex',
        sourcePath: page2,
        segments: [{ path: page1, endByte: 30 }]
      })
    ]
    const res = await deleteSessions(deps, ['codex:thr'], 30)
    expect(res.cleaned).toBe(1)
    expect(res.freedBytes).toBe(64)
    // an earlier page left behind would be listed as the whole thread on the next scan
    expect(existsSync(page1)).toBe(false)
    expect(existsSync(page2)).toBe(false)
    sessions = []
  })

  it('refuses the whole thread when any page of it is outside every configured source', async () => {
    const outside = join(root, 'not-a-source-page.jsonl')
    const inside = join(sourceDir, 'rollout-thr2.jsonl')
    writeFileSync(outside, 'important')
    writeFileSync(inside, 'x')
    sessions = [
      session({ id: 'codex:thr2', provider: 'codex', sourcePath: inside, segments: [{ path: outside, endByte: 3 }] })
    ]
    const res = await deleteSessions(deps, ['codex:thr2'], 30)
    expect(res.cleaned).toBe(0)
    expect(res.failed[0].reason).toMatch(/outside every configured source/)
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(inside)).toBe(true)
    sessions = []
  })

  it('refuses an id the indexer does not know', async () => {
    sessions = []
    const res = await deleteSessions(deps, ['claude:../../etc/passwd'], 30)
    expect(res.cleaned).toBe(0)
    expect(res.failed[0].reason).toMatch(/no longer indexed/)
  })

  it('refuses a session used again since the scan', async () => {
    // resumed in a terminal and sitting at its prompt: not busy, but not stale either,
    // and its transcript is no longer the one the user chose to delete
    const file = join(sourceDir, 'resumed.jsonl')
    writeFileSync(file, 'r')
    sessions = [session({ id: 'claude:resumed', sourcePath: file, updatedAt: Date.now() - 60_000 })]
    const res = await deleteSessions(deps, ['claude:resumed'], 30)
    expect(res.cleaned).toBe(0)
    expect(res.deletedIds).toEqual([])
    expect(res.failed[0].reason).toMatch(/used again/)
    expect(existsSync(file)).toBe(true)
    sessions = []
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

  it('deletes a merged branch whose name starts with a dash as a name, never an option', async () => {
    // plumbing makes such a ref; as a bare argument git read it as switches
    const tree = join(cockpitWorktrees, 'app', 'dashed')
    git(mainRepo, ['worktree', 'add', '-q', '--detach', tree])
    git(mainRepo, ['update-ref', 'refs/heads/-oops', 'HEAD'])
    git(tree, ['symbolic-ref', 'HEAD', 'refs/heads/-oops'])
    backdate(tree)
    const res = await removeWorktrees(deps, [tree])
    expect(res.cleaned).toBe(1)
    expect(res.branchesDeleted).toEqual(['-oops'])
    expect(git(mainRepo, ['branch', '--list'])).not.toMatch(/-oops/)
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

  it('refuses a detached worktree whose commits no branch holds, and removes one whose commits are safe', async () => {
    // no branch to leave behind: `git worktree remove` would take the only ref to
    // this commit with it (the worktree's own reflog), and gc would prune it
    const detached = join(cockpitWorktrees, 'app', 'bisecting')
    git(mainRepo, ['worktree', 'add', '-q', '--detach', detached])
    writeFileSync(join(detached, 'found.txt'), 'the bad commit\n')
    git(detached, ['add', '.'])
    git(detached, ['commit', '-q', '-m', 'only here'])
    backdate(detached)
    const report = await scanCleanup(deps, 30)
    expect(report.worktrees.find((w) => w.path === detached)?.blocks).toEqual(['detached'])
    const res = await removeWorktrees(deps, [detached])
    expect(res.cleaned).toBe(0)
    expect(res.failed[0].reason).toMatch(/detached HEAD/)
    expect(existsSync(detached)).toBe(true)
    // once a branch holds the commit, nothing is lost by removing the directory
    git(detached, ['branch', 'keep-bisect'])
    expect((await removeWorktrees(deps, [detached])).cleaned).toBe(1)
    expect(git(mainRepo, ['log', '-1', '--format=%s', 'keep-bisect']).trim()).toBe('only here')
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

  it('clears only the missing registration it was asked to, never every missing one', async () => {
    // a worktree on a drive that is only unmounted reads as missing too — `git worktree
    // prune` used to take it along with the one picked
    const picked = join(cockpitWorktrees, 'app', 'gone-picked')
    const unmounted = join(cockpitWorktrees, 'app', 'gone-unmounted')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/gone-picked', picked])
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/gone-unmounted', unmounted])
    rmSync(picked, { recursive: true, force: true })
    rmSync(unmounted, { recursive: true, force: true })
    const res = await removeWorktrees(deps, [picked])
    expect(res).toMatchObject({ cleaned: 1, failed: [] })
    const listing = git(mainRepo, ['worktree', 'list', '--porcelain'])
    expect(listing).not.toContain(`worktree ${picked}\n`)
    expect(listing).toContain(`worktree ${unmounted}\n`)
    // and it goes the same way once it is the one picked
    expect((await removeWorktrees(deps, [unmounted])).cleaned).toBe(1)
    expect(git(mainRepo, ['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${unmounted}\n`)
  })

  it('keeps a missing registration git has locked, and says so', async () => {
    // a lock is how a worktree on a removable drive says it will be back
    const away = join(cockpitWorktrees, 'app', 'on-a-drive')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/on-a-drive', away])
    git(mainRepo, ['worktree', 'lock', away])
    rmSync(away, { recursive: true, force: true })
    const report = await scanCleanup(deps, 30)
    expect(report.worktrees.find((w) => w.path === away)?.blocks).toEqual(['locked'])
    const res = await removeWorktrees(deps, [away])
    expect(res.cleaned).toBe(0)
    expect(res.failed[0]?.reason).toMatch(/locked/)
    expect(git(mainRepo, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${away}\n`)
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

describe('processes left in old worktrees', () => {
  // lsof is how a process's cwd is read; without it there is nothing to find
  const hasLsof = (() => {
    try {
      execFileSync('lsof', ['-v'], { stdio: 'ignore' })
      return true
    } catch (err) {
      return (err as { status?: number }).status !== undefined
    }
  })()
  const children: ChildProcess[] = []
  // each scan reads every process's cwd on top of the git walk — slower than the rest
  const PROCESS_TIMEOUT_MS = 30_000

  /** A long-running process with its cwd in `dir` — the dev server nobody stopped. */
  async function runIn(dir: string): Promise<ChildProcess> {
    const child = spawn('sleep', ['300'], { cwd: dir, stdio: 'ignore' })
    children.push(child)
    await new Promise<void>((r) => child.once('spawn', () => r()))
    return child
  }

  const exited = (child: ChildProcess): Promise<void> =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((r) => child.once('exit', () => r()))

  afterAll(() => {
    for (const c of children) c.kill('SIGKILL')
  }, PROCESS_TIMEOUT_MS)

  it.runIf(hasLsof)('lists it and blocks removing the worktree until it is gone', async () => {
    const tree = join(cockpitWorktrees, 'app', 'dev-server')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/dev-server', tree])
    backdate(tree)
    const child = await runIn(tree)

    const report = await scanCleanup(deps, 30)
    const listed = report.processes.find((p) => p.pid === child.pid)
    expect(listed).toMatchObject({
      worktreePath: tree,
      branch: 'cockpit/dev-server',
      worktreeGone: false
    })
    expect(report.worktrees.find((w) => w.path === tree)?.blocks).toEqual(['process'])
    const refused = await removeWorktrees(deps, [tree])
    expect(refused.failed[0]?.reason).toMatch(/process is still running/)
    expect(existsSync(tree)).toBe(true)

    const stopped = await stopProcesses(deps, [listed as OrphanProcess], 30)
    expect(stopped).toMatchObject({ cleaned: 1, failed: [] })
    await exited(child)
    expect(child.signalCode).toBe('SIGTERM')

    const after = await removeWorktrees(deps, [tree])
    expect(after.cleaned).toBe(1)
  }, PROCESS_TIMEOUT_MS)

  it.runIf(hasLsof)('finds one whose worktree was removed from under it', async () => {
    const gone = join(cockpitWorktrees, 'app', 'removed')
    mkdirSync(join(gone, 'web'), { recursive: true })
    const child = await runIn(join(gone, 'web'))
    rmSync(gone, { recursive: true, force: true })

    const report = await scanCleanup(deps, 30)
    const listed = report.processes.find((p) => p.pid === child.pid)
    expect(listed).toMatchObject({ worktreePath: gone, worktreeGone: true })
    const stopped = await stopProcesses(deps, [listed as OrphanProcess], 30)
    expect(stopped.cleaned).toBe(1)
    await exited(child)
  }, PROCESS_TIMEOUT_MS)

  it.runIf(hasLsof)('refuses a pid whose start time no longer matches the one picked', async () => {
    const tree = join(cockpitWorktrees, 'app', 'reused-pid')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/reused-pid', tree])
    backdate(tree)
    const child = await runIn(tree)
    const listed = (await scanCleanup(deps, 30)).processes.find((p) => p.pid === child.pid)
    expect(listed).toBeDefined()
    // the same pid, but as if another process had been handed it since the scan
    const reused = { ...(listed as OrphanProcess), startedAt: (listed?.startedAt ?? 0) - 60_000 }
    const refused = await stopProcesses(deps, [reused], 30)
    expect(refused.cleaned).toBe(0)
    expect(refused.failed[0]?.reason).toMatch(/different process/)
    expect(child.exitCode === null && child.signalCode === null).toBe(true)
    child.kill('SIGKILL')
    await exited(child)
  }, PROCESS_TIMEOUT_MS)

  it.runIf(hasLsof)('never offers Cockpit’s own process tree', async () => {
    const tree = join(cockpitWorktrees, 'app', 'own')
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'cockpit/own', tree])
    backdate(tree)
    const child = await runIn(tree)
    // this test process spawned it, exactly as Cockpit spawns its agent turns
    const own: CleanupDeps = { ...deps, selfPid: process.pid }
    const report = await scanCleanup(own, 30)
    expect(report.processes.some((p) => p.pid === child.pid)).toBe(false)
    // the very row a scan outside that tree would show, so only the tree refuses it
    const seen = (await scanCleanup(deps, 30)).processes.find((p) => p.pid === child.pid)
    const refused = await stopProcesses(own, [seen as OrphanProcess], 30)
    expect(refused.cleaned).toBe(0)
    expect(refused.failed).toHaveLength(1)
    child.kill('SIGKILL')
    await exited(child)
  }, PROCESS_TIMEOUT_MS)

  it.runIf(hasLsof)('refuses a pid that is not left in an old worktree', async () => {
    const res = await stopProcesses(
      deps,
      [{ pid: process.pid, command: 'node', startedAt: Date.now() }],
      30
    )
    expect(res.cleaned).toBe(0)
    expect(res.failed[0]?.reason).toMatch(/no longer a process left/)
  }, PROCESS_TIMEOUT_MS)
})
