import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionIndexer } from '../src/main/indexer'
import { clearRepoCache } from '../src/main/repos'

const root = join(tmpdir(), 'cockpit-indexer-fixtures')
const claudeDir = join(root, 'claude')
const copilotDir = join(root, 'copilot')
const repoA = join(root, 'repo-a')

function hasSqlite3(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function jsonl(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)) .join('\n') + '\n'
}

function writeCopilotSession(base: string, id: string, cwd: string, title: string, ts: string): void {
  const dir = join(base, 'session-state', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'events.jsonl')
  writeFileSync(
    file,
    jsonl([
      {
        type: 'session.start',
        timestamp: ts,
        data: { sessionId: id, context: { cwd, branch: 'main' } }
      },
      { type: 'user.message', timestamp: ts, data: { content: title } }
    ])
  )
  // deletion detection compares events.jsonl mtimes — pin them to the fixture timestamp
  utimesSync(file, new Date(ts), new Date(ts))
}

function writeClaudeSession(name: string, cwd: string, title: string, ts: string): void {
  const dir = join(claudeDir, 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.jsonl`),
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: title },
        timestamp: ts,
        sessionId: name,
        cwd,
        gitBranch: 'main'
      },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: ts }
    ])
  )
}

let indexer: SessionIndexer

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true })
  clearRepoCache()

  mkdirSync(join(repoA, '.git'), { recursive: true })
  writeFileSync(
    join(repoA, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/acme/repo-a.git\n'
  )

  writeClaudeSession('s1', repoA, 'fix the login bug', '2026-08-01T10:00:00Z')
  writeClaudeSession('s2', repoA, 'add pagination', '2026-08-02T10:00:00Z')
  writeClaudeSession('s3', '/nowhere/special', 'random chat', '2026-08-03T10:00:00Z')

  indexer = new SessionIndexer(() => {}, { claudeStoreDir: null })
  await indexer.setSources([{ path: claudeDir, provider: 'claude', label: 'test' }])
  indexer.stopWatchers()
})

afterAll(() => indexer?.stopWatchers())

describe('SessionIndexer', () => {
  it('groups sessions by GitHub fullName, general bucket last', () => {
    const repos = indexer.listRepos()
    expect(repos.map((r) => r.key)).toEqual(['gh:acme/repo-a', 'general'])
    expect(repos[0].fullName).toBe('acme/repo-a')
    expect(repos[0].root).toBe(repoA)
    expect(repos[0].sessionCount).toBe(2)
    expect(repos[1].sessionCount).toBe(1)
  })

  it('pages sessions scoped to a repo, newest first', () => {
    const page = indexer.page({ repoKey: 'gh:acme/repo-a', limit: 1 })
    expect(page.total).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.items[0].title).toBe('add pagination')
    const page2 = indexer.page({ repoKey: 'gh:acme/repo-a', offset: 1, limit: 1 })
    expect(page2.items[0].title).toBe('fix the login bug')
  })

  it('filters by search and provider', () => {
    expect(indexer.page({ search: 'login' }).total).toBe(1)
    expect(indexer.page({ providers: ['codex'] }).total).toBe(0)
  })

  it('picks up changed files on rescan (stat cache invalidation)', async () => {
    writeClaudeSession('s2', repoA, 'add pagination — updated', '2026-08-04T10:00:00Z')
    await indexer.rescan()
    const page = indexer.page({ repoKey: 'gh:acme/repo-a', limit: 1 })
    expect(page.items[0].title).toBe('add pagination — updated')
  })

  it('reports per-source health stats keyed on the config source list', () => {
    const src = { path: claudeDir, provider: 'claude' as const, label: 'test' }
    const dead = { path: join(root, 'gone'), provider: 'codex' as const, label: 'dead' }
    const stats = indexer.sourceStats([src, dead])
    expect(stats).toHaveLength(2)
    expect(stats[0]).toMatchObject({ label: 'test', count: 3, missing: false })
    expect(stats[0].lastUpdatedAt).toBeGreaterThan(0)
    expect(stats[1]).toMatchObject({ label: 'dead', count: 0, lastUpdatedAt: null, missing: true })
  })

  it('hides unselected projects from global queries but keeps them listed', () => {
    indexer.setHiddenRepos(['gh:acme/repo-a'])
    const repos = indexer.listRepos()
    expect(repos.find((r) => r.key === 'gh:acme/repo-a')?.hidden).toBe(true)
    expect(repos.find((r) => r.key === 'general')?.hidden).toBe(false)
    // global search skips hidden repos; an explicit repoKey still works
    expect(indexer.page({ search: 'login' }).total).toBe(0)
    expect(indexer.page({ repoKey: 'gh:acme/repo-a' }).total).toBe(2)
    indexer.setHiddenRepos([])
    expect(indexer.page({ search: 'login' }).total).toBe(1)
  })
})

describe('history window (setHistoryDays)', () => {
  // fixture timestamps are relative to now — the cutoff compares against Date.now()
  const histDir = join(root, 'claude-history')
  const day = 86_400_000
  let idx: SessionIndexer

  function writeSession(name: string, cwd: string, title: string, agoMs: number): void {
    const dir = join(histDir, 'projects', 'p')
    mkdirSync(dir, { recursive: true })
    const ts = new Date(Date.now() - agoMs).toISOString()
    writeFileSync(
      join(dir, `${name}.jsonl`),
      jsonl([
        {
          type: 'user',
          message: { role: 'user', content: title },
          timestamp: ts,
          sessionId: name,
          cwd,
          gitBranch: 'main'
        },
        { type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: ts }
      ])
    )
  }

  beforeAll(async () => {
    writeSession('h-recent', repoA, 'recent work', 2 * day)
    writeSession('h-old', '/nowhere/ancient', 'ancient chat', 40 * day)
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: histDir, provider: 'claude', label: 'hist' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('hides sessions idle longer than the window from pages and repo groups', () => {
    idx.setHistoryDays(30)
    expect(idx.page({}).items.map((s) => s.nativeId)).toEqual(['h-recent'])
    // a repo whose only sessions aged out disappears entirely
    expect(idx.listRepos().map((r) => r.key)).toEqual(['gh:acme/repo-a'])
  })

  it('0 restores all history (nothing was dropped from the index)', () => {
    idx.setHistoryDays(0)
    expect(idx.page({}).items.map((s) => s.nativeId).sort()).toEqual(['h-old', 'h-recent'])
    expect(idx.listRepos().map((r) => r.key)).toEqual(['gh:acme/repo-a', 'general'])
  })

  it('leaves source health stats unfiltered — they report what is indexed', () => {
    idx.setHistoryDays(30)
    const src = { path: histDir, provider: 'claude' as const, label: 'hist' }
    expect(idx.sourceStats([src])[0].count).toBe(2)
    idx.setHistoryDays(0)
  })
})

describe.skipIf(!hasSqlite3())('provider-archived sessions (copilot data.db)', () => {
  let idx: SessionIndexer

  beforeAll(async () => {
    writeCopilotSession(copilotDir, 'c1', '/nowhere/one', 'active session', '2026-08-01T10:00:00Z')
    writeCopilotSession(copilotDir, 'c2', '/nowhere/two', 'archived in the copilot app', '2026-08-02T10:00:00Z')
    execFileSync('sqlite3', [
      join(copilotDir, 'data.db'),
      "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, archived_at TEXT);" +
        "INSERT INTO sessions VALUES ('c1', NULL), ('c2', '2026-08-02T11:00:00Z');"
    ])
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: copilotDir, provider: 'copilot', label: 'cp' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('never shows sessions archived in the provider app', () => {
    const active = idx.page({})
    expect(active.items.map((s) => s.nativeId)).toContain('c1')
    expect(active.items.map((s) => s.nativeId)).not.toContain('c2')
    // not surfaced under Cockpit's own archived view either
    expect(idx.page({ archived: true }).total).toBe(0)
    // and excluded from repo-group session counts
    const total = idx.listRepos().reduce((n, r) => n + r.sessionCount + r.archivedCount, 0)
    expect(total).toBe(1)
  })
})

describe('provider-archived sessions (claude desktop store)', () => {
  const storeDir = join(root, 'claude-store')

  function writeStoreRecord(name: string, rec: unknown): void {
    // real layout: <store>/<install-uuid>/<workspace-uuid>/<session>.json
    const dir = join(storeDir, 'install-1', 'workspace-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), typeof rec === 'string' ? rec : JSON.stringify(rec))
  }

  let idx: SessionIndexer

  beforeAll(async () => {
    // s1 archived in the Claude app, s2 untouched; a corrupt record must not break the sweep
    writeStoreRecord('local_a.json', { cliSessionId: 's1', isArchived: true, title: 'x' })
    writeStoreRecord('local_b.json', { cliSessionId: 's2', isArchived: false, title: 'y' })
    writeStoreRecord('broken.json', '{ not json')
    idx = new SessionIndexer(() => {}, { claudeStoreDir: storeDir })
    await idx.setSources([{ path: claudeDir, provider: 'claude', label: 'test' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('hides sessions archived in the claude desktop app', () => {
    const active = idx.page({ repoKey: 'gh:acme/repo-a' })
    expect(active.items.map((s) => s.nativeId)).toContain('s2')
    expect(active.items.map((s) => s.nativeId)).not.toContain('s1')
    // not under Cockpit's own archived toggle either
    expect(idx.page({ repoKey: 'gh:acme/repo-a', archived: true }).total).toBe(0)
    // and excluded from the repo group count
    const repoA = idx.listRepos().find((r) => r.key === 'gh:acme/repo-a')
    expect((repoA?.sessionCount ?? 0) + (repoA?.archivedCount ?? 0)).toBe(1)
  })
})

// Watcher 'change' events are driven through markDirty directly — real fs.watch
// delivery timing is OS-dependent and would make these tests flaky.
describe('watcher-event probing (codex subagent rollouts)', () => {
  const codexDir = join(root, 'codex')
  const dayDir = join(codexDir, 'sessions', '2026', '08', '09')

  function writeRollout(name: string, objs: unknown[]): string {
    mkdirSync(dayDir, { recursive: true })
    const p = join(dayDir, name)
    writeFileSync(p, jsonl(objs))
    return p
  }

  // subagent rollouts carry session_meta but no user/agent messages — parseCodexMeta
  // returns null for them, and they live in the same YYYY/MM/DD dirs as real rollouts
  const subagentLines = [
    {
      timestamp: '2026-08-09T10:00:02Z',
      type: 'session_meta',
      payload: { id: 'sub1', cwd: '/nowhere/x' }
    },
    {
      timestamp: '2026-08-09T10:00:03Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'Bash', arguments: '{}' }
    }
  ]

  let idx: SessionIndexer

  beforeAll(async () => {
    writeRollout('rollout-main.jsonl', [
      {
        timestamp: '2026-08-09T10:00:00Z',
        type: 'session_meta',
        payload: { id: 'm1', cwd: '/nowhere/x' }
      },
      {
        timestamp: '2026-08-09T10:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'hello' }
      }
    ])
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: codexDir, provider: 'codex', label: 'cx' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('probes an unknown file on change and remembers a null parse instead of rescanning', () => {
    const anyIdx = idx as any
    const sub = writeRollout('rollout-sub.jsonl', subagentLines)
    anyIdx.markDirty('change', sub)
    expect(anyIdx.rescanTimer).toBeNull() // no full rescan was scheduled
    expect(anyIdx.knownNonSessions.has(sub)).toBe(true)
    // the streamed appends short-circuit on the remembered verdict
    writeFileSync(
      sub,
      jsonl([
        ...subagentLines,
        {
          timestamp: '2026-08-09T10:00:04Z',
          type: 'response_item',
          payload: { type: 'function_call_output', output: 'ok' }
        }
      ])
    )
    anyIdx.markDirty('change', sub)
    expect(anyIdx.rescanTimer).toBeNull()
    expect(idx.page({}).items.map((s) => s.nativeId)).not.toContain('sub1')
  })

  it('indexes a real session discovered by the change probe without a rescan', () => {
    const anyIdx = idx as any
    const p = writeRollout('rollout-second.jsonl', [
      {
        timestamp: '2026-08-09T11:00:00Z',
        type: 'session_meta',
        payload: { id: 'm2', cwd: '/nowhere/x' }
      },
      {
        timestamp: '2026-08-09T11:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'second session' }
      }
    ])
    anyIdx.markDirty('change', p)
    expect(anyIdx.rescanTimer).toBeNull()
    expect(idx.page({}).items.map((s) => s.nativeId)).toContain('m2')
  })

  it('re-derives probe verdicts on the next full rescan', async () => {
    await idx.rescan()
    expect((idx as any).knownNonSessions.size).toBe(0)
    const ids = idx.page({}).items.map((s) => s.nativeId)
    expect(ids).toContain('m1')
    expect(ids).toContain('m2')
    expect(ids).not.toContain('sub1')
  })

  it('does not let a change on a known file cancel a pending full rescan', () => {
    const anyIdx = idx as any
    anyIdx.scheduleRescan()
    expect(anyIdx.rescanTimer).not.toBeNull()
    anyIdx.markDirty('change', join(dayDir, 'rollout-main.jsonl'))
    expect(anyIdx.rescanTimer).not.toBeNull()
    expect(anyIdx.dirtyTimer).toBeNull()
    idx.stopWatchers() // clear the pending timer before the suite ends
  })
})

describe.skipIf(!hasSqlite3())('provider-archived persistence across launches', () => {
  const cpDir = join(root, 'copilot-persist')
  const cacheFile = join(root, 'cache', 'stat-cache.json')

  function writeCpSession(id: string, title: string, ts: string): void {
    const dir = join(cpDir, 'session-state', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'events.jsonl'),
      jsonl([
        {
          type: 'session.start',
          timestamp: ts,
          data: { sessionId: id, context: { cwd: '/nowhere/persist', branch: 'main' } }
        },
        { type: 'user.message', timestamp: ts, data: { content: title } }
      ])
    )
  }

  it('seeds the archived set from the cache when the first sweep fails', async () => {
    writeCpSession('p1', 'active session', '2026-08-01T10:00:00Z')
    writeCpSession('p2', 'archived in the copilot app', '2026-08-02T10:00:00Z')
    execFileSync('sqlite3', [
      join(cpDir, 'data.db'),
      "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, archived_at TEXT);" +
        "INSERT INTO sessions VALUES ('p1', NULL), ('p2', '2026-08-02T11:00:00Z');"
    ])

    const first = new SessionIndexer(() => {}, { cacheFile, claudeStoreDir: null })
    await first.setSources([{ path: cpDir, provider: 'copilot', label: 'cp' }])
    first.stopWatchers()
    expect(first.page({}).items.map((s) => s.nativeId)).not.toContain('p2')
    first.saveCache()

    // next launch: the db read fails (stands in for a locked db / missing sqlite3)
    writeFileSync(join(cpDir, 'data.db'), 'not a sqlite database')
    const second = new SessionIndexer(() => {}, { cacheFile, claudeStoreDir: null })
    await second.setSources([{ path: cpDir, provider: 'copilot', label: 'cp' }])
    second.stopWatchers()
    const ids = second.page({}).items.map((s) => s.nativeId)
    expect(ids).toContain('p1')
    expect(ids).not.toContain('p2')
  })
})

describe('lazy watcher install (source root appears after setSources)', () => {
  const lateHome = join(root, 'claude-late')
  let idx: SessionIndexer

  afterAll(() => idx?.stopWatchers())

  it('keeps a missing source, then watches and indexes it once the dir appears', async () => {
    idx = new SessionIndexer(() => {}, { watchRetryMs: 50, claudeStoreDir: null })
    // lateHome does not exist yet — the desktop-store-installed-later scenario
    await idx.setSources([{ path: lateHome, provider: 'claude', label: 'late' }])
    expect(idx.page({}).total).toBe(0)
    expect((idx as any).pendingWatches).toHaveLength(1)

    const dir = join(lateHome, 'projects', 'p')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'late1.jsonl'),
      jsonl([
        {
          type: 'user',
          message: { role: 'user', content: 'born after setSources' },
          timestamp: '2026-08-09T12:00:00Z',
          sessionId: 'late1',
          cwd: '/nowhere/late',
          gitBranch: 'main'
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: 'ok' },
          timestamp: '2026-08-09T12:00:01Z'
        }
      ])
    )

    await vi.waitFor(() => expect(idx.page({}).total).toBe(1), { timeout: 5000, interval: 100 })
    expect((idx as any).pendingWatches).toHaveLength(0)
    expect((idx as any).watchers.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!hasSqlite3())('provider-deleted sessions (copilot data.db)', () => {
  // Deletion removes the sessions row but leaves session-state/<id>/events.jsonl on disk.
  // A row-less dir is hidden only when its mtime falls inside the mtime span of the dirs
  // the db does know (here 08-02 … 08-06).
  const dir = join(root, 'copilot-deleted')
  let idx: SessionIndexer

  const visible = (): string[] => idx.page({}).items.map((s) => s.nativeId).sort()

  beforeAll(async () => {
    writeCopilotSession(dir, 'k-old', '/nowhere/a', 'oldest kept session', '2026-08-02T10:00:00Z')
    writeCopilotSession(dir, 'k-new', '/nowhere/b', 'newest kept session', '2026-08-06T10:00:00Z')
    writeCopilotSession(dir, 'pre-db', '/nowhere/c', 'history from before the db', '2026-07-01T10:00:00Z')
    writeCopilotSession(dir, 'gone', '/nowhere/d', 'deleted in the copilot app', '2026-08-04T10:00:00Z')
    writeCopilotSession(dir, 'unrecorded', '/nowhere/e', 'newer than anything in the db', '2026-08-08T10:00:00Z')
    execFileSync('sqlite3', [
      join(dir, 'data.db'),
      "CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, archived_at TEXT);" +
        "INSERT INTO sessions VALUES ('k-old', NULL), ('k-new', NULL);"
    ])
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: dir, provider: 'copilot', label: 'cp' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('hides row-less dirs inside the db era, keeps pre-db history and unrecorded new dirs', () => {
    expect(visible()).toEqual(['k-new', 'k-old', 'pre-db', 'unrecorded'])
    // deleted sessions are not surfaced under Cockpit's own archived view either
    expect(idx.page({ archived: true }).total).toBe(0)
    const total = idx.listRepos().reduce((n, r) => n + r.sessionCount + r.archivedCount, 0)
    expect(total).toBe(4)
  })

  it('keeps the previous hidden set when the db read fails (no flapping)', async () => {
    writeFileSync(join(dir, 'data.db'), 'this is not a sqlite database')
    await idx.rescan()
    expect(visible()).toEqual(['k-new', 'k-old', 'pre-db', 'unrecorded'])
  })
})

describe.skipIf(!hasSqlite3())('copilot data.db with an empty sessions table', () => {
  // An empty table carries no evidence of deletion (and no date range) — hide nothing.
  const dir = join(root, 'copilot-empty')
  let idx: SessionIndexer

  beforeAll(async () => {
    writeCopilotSession(dir, 'e1', '/nowhere/f', 'first session', '2026-08-01T10:00:00Z')
    writeCopilotSession(dir, 'e2', '/nowhere/g', 'second session', '2026-08-02T10:00:00Z')
    execFileSync('sqlite3', [
      join(dir, 'data.db'),
      'CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, archived_at TEXT);'
    ])
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: dir, provider: 'copilot', label: 'cp' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('hides nothing', () => {
    expect(idx.page({}).items.map((s) => s.nativeId).sort()).toEqual(['e1', 'e2'])
  })
})
