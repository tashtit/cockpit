import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionIndexer, foldThread, groupFamilies, subagentParent } from '../src/main/indexer'
import { writePagedThread, type PagedThread } from './codex-paged-thread'
import { makeFifo } from './fifo'
import type { BusySession, SessionMeta } from '../src/shared/types'
import { clearRepoCache } from '../src/main/repos'

const root = mkdtempSync(join(tmpdir(), 'cockpit-indexer-fixtures-'))
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

afterAll(() => {
  indexer?.stopWatchers()
  rmSync(root, { recursive: true, force: true })
})

describe('SessionIndexer', () => {
  it("keeps roundtable seats out of the user's own sessions, and hands them over apart", () => {
    // s3 ran in a table's room: it belongs to the table, not to the person's own work
    indexer.setRoundtableResolver((cwd) => (cwd === '/nowhere/special' ? 'rt-1' : null))
    try {
      expect(indexer.allSessions().map((s) => s.nativeId).sort()).toEqual(['s1', 's2', 's3'])
      expect(indexer.ownSessions().map((s) => s.nativeId).sort()).toEqual(['s1', 's2'])
      expect(indexer.roundtableSessions().map((s) => [s.nativeId, s.roundtableId])).toEqual([['s3', 'rt-1']])
    } finally {
      indexer.setRoundtableResolver(() => null)
    }
  })

  it("counts archived work as the user's own, but never a session its app deleted", () => {
    const any = indexer as unknown as { providerArchived: Set<string>; providerDeleted: Set<string> }
    const [s1, s2] = ['s1', 's2'].map((n) => indexer.allSessions().find((s) => s.nativeId === n)!.id)
    // s1 archived in the provider's app (as the desktop app does when its PR closes), s2 deleted there
    any.providerArchived = new Set([s1, s2])
    any.providerDeleted = new Set([s2])
    try {
      expect(indexer.allSessions().map((s) => s.nativeId)).toEqual(['s3'])
      expect(indexer.ownSessions().map((s) => s.nativeId).sort()).toEqual(['s1', 's3'])
    } finally {
      any.providerArchived = new Set()
      any.providerDeleted = new Set()
    }
  })

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

  it('settles whenScanned only after the first full scan has published', async () => {
    const fresh = new SessionIndexer(() => {}, { claudeStoreDir: null })
    let settled = false
    void fresh.whenScanned().then(() => (settled = true))
    await new Promise((r) => setImmediate(r))
    // no scan has run: an empty repo list here means "not read yet"
    expect(settled).toBe(false)
    expect(fresh.listRepos()).toEqual([])

    const scan = fresh.setSources([{ path: claudeDir, provider: 'claude', label: 'test' }])
    await fresh.whenScanned()
    expect(fresh.listRepos().map((r) => r.key)).toContain('gh:acme/repo-a')
    await scan
    fresh.stopWatchers()
  })

  it('settles whenScanned even when there is nothing to scan', async () => {
    const empty = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await empty.setSources([{ path: join(root, 'missing'), provider: 'codex', label: 'none' }])
    await expect(empty.whenScanned()).resolves.toBeUndefined()
    expect(empty.listRepos()).toEqual([])
    empty.stopWatchers()
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

describe('project order (setRepoOrder)', () => {
  const orderDir = join(root, 'claude-order')
  let idx: SessionIndexer

  function repo(name: string): string {
    const dir = join(root, 'order', name)
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/acme/${name}.git\n`)
    return dir
  }

  function writeSession(name: string, cwd: string, ts: string): void {
    const dir = join(orderDir, 'projects', 'p')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${name}.jsonl`),
      jsonl([
        { type: 'user', message: { role: 'user', content: name }, timestamp: ts, sessionId: name, cwd },
        { type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: ts }
      ])
    )
  }

  beforeAll(async () => {
    // zebra is the busiest and most recent — it must still not jump to the top
    writeSession('o-zebra-1', repo('zebra'), '2026-08-09T10:00:00Z')
    writeSession('o-zebra-2', repo('zebra'), '2026-08-08T10:00:00Z')
    writeSession('o-mango', repo('mango'), '2026-08-05T10:00:00Z')
    writeSession('o-apple', repo('apple'), '2026-08-01T10:00:00Z')
    writeSession('o-chat', '/nowhere/order', '2026-08-10T10:00:00Z')
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: orderDir, provider: 'claude', label: 'order' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('lists projects A→Z, not by activity, with general last', () => {
    expect(idx.listRepos().map((r) => r.key)).toEqual([
      'gh:acme/apple',
      'gh:acme/mango',
      'gh:acme/zebra',
      'general'
    ])
  })

  it("follows the user's order, and an empty order goes back to A→Z", () => {
    idx.setRepoOrder(['gh:acme/zebra', 'gh:acme/apple'])
    expect(idx.listRepos().map((r) => r.key)).toEqual([
      'gh:acme/zebra',
      'gh:acme/apple',
      'gh:acme/mango',
      'general'
    ])
    idx.setRepoOrder([])
    expect(idx.listRepos()[0].key).toBe('gh:acme/apple')
  })

  it('still pages sessions inside a project newest first', () => {
    expect(idx.page({ repoKey: 'gh:acme/zebra' }).items.map((s) => s.nativeId)).toEqual([
      'o-zebra-1',
      'o-zebra-2'
    ])
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

// Codex archives a thread by moving its rollout into <home>/archived_sessions/: the
// tree must never show it, and the profile must still count it — archiving is how a
// piece of work ends, not a way of throwing it away.
describe('codex archived rollouts', () => {
  const codexDir = join(root, 'codex-archive')
  const rollout = (dir: string, id: string, prompt: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `rollout-${id}.jsonl`),
      jsonl([
        { timestamp: '2026-08-09T10:00:00Z', type: 'session_meta', payload: { id, cwd: '/nowhere/x' } },
        { timestamp: '2026-08-09T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: prompt } }
      ])
    )
  }
  let idx: SessionIndexer

  beforeAll(async () => {
    rollout(join(codexDir, 'sessions', '2026', '08', '09'), 'live', 'still going')
    rollout(join(codexDir, 'archived_sessions'), 'done', 'finished and archived')
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: codexDir, provider: 'codex', label: 'cx' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('keeps an archived rollout out of every listing', () => {
    expect(idx.page({}).items.map((s) => s.nativeId)).toEqual(['live'])
    expect(idx.allSessions().map((s) => s.nativeId)).toEqual(['live'])
    expect(idx.cleanupSessions().map((s) => s.nativeId)).toEqual(['live'])
  })

  it("counts it as the user's own work", () => {
    expect(idx.ownSessions().map((s) => s.nativeId).sort()).toEqual(['done', 'live'])
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

describe('leftovers of interrupted cache saves', () => {
  it('are swept at launch once old, while a save that may still be running is left alone', () => {
    const dir = join(root, 'userdata-tmps')
    mkdirSync(dir, { recursive: true })
    const cacheFile = join(dir, 'index-cache.json')
    const hourAgo = new Date(Date.now() - 3_600_000)
    const old = join(dir, 'index-cache.json.4242.7.tmp')
    const fresh = join(dir, 'index-cache.json.4243.1.tmp')
    const unrelated = join(dir, 'index-cache.json.bak')
    for (const f of [old, fresh, unrelated]) writeFileSync(f, '{}')
    utimesSync(old, hourAgo, hourAgo)
    utimesSync(unrelated, hourAgo, hourAgo)
    const idx = new SessionIndexer(() => {}, { cacheFile, claudeStoreDir: null })
    idx.stopWatchers()
    expect(readdirSync(dir).sort()).toEqual(['index-cache.json.4243.1.tmp', 'index-cache.json.bak'])
  })
})

describe('a Codex thread renamed in session_index.jsonl', () => {
  const home = join(root, 'codex-names')
  const day = join(home, 'sessions', '2026', '09', '20')
  const rollout = (id: string, prompt: string): string => {
    mkdirSync(day, { recursive: true })
    const f = join(day, `rollout-${id}.jsonl`)
    writeFileSync(
      f,
      jsonl([
        { timestamp: '2026-09-20T10:00:00Z', type: 'session_meta', payload: { id, cwd: '/nowhere/n' } },
        { timestamp: '2026-09-20T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }
      ])
    )
    return f
  }
  const index = join(home, 'session_index.jsonl')
  let idx: SessionIndexer

  beforeAll(async () => {
    rollout('t1', 'first prompt')
    rollout('t2', 'second prompt')
    writeFileSync(index, jsonl([{ id: 't1', thread_name: 'Named first' }]))
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: home, provider: 'codex', label: 'cx' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  // every new thread names itself there: the index's mtime used to be stamped into
  // every Codex entry, so each write re-parsed every rollout after a full rescan
  it('re-titles that thread alone, without a rescan or a re-parse of the others', () => {
    const anyIdx = idx as any
    expect(idx.getSession('codex:t1')?.title).toBe('Named first')
    expect(idx.getSession('codex:t2')?.title).toBe('second prompt')
    const untouched = anyIdx.fileCache.get(join(day, 'rollout-t1.jsonl'))
    appendFileSync(index, jsonl([{ id: 't2', thread_name: 'Named second' }]))
    anyIdx.markSourceDirty({ path: home, provider: 'codex', label: 'cx' })
    expect(anyIdx.rescanTimer).toBeNull()
    anyIdx.applyDirty()
    expect(idx.getSession('codex:t2')?.title).toBe('Named second')
    expect(idx.getSession('codex:t1')?.title).toBe('Named first')
    // the other thread's entry is the very one cached before: judged, not re-read
    expect(anyIdx.fileCache.get(join(day, 'rollout-t1.jsonl'))).toBe(untouched)
  })
})

describe('files in a session root that are not regular files', () => {
  const cpDir = join(root, 'copilot-fifo')
  const clDir = join(root, 'claude-fifo')
  const stops: Array<() => void> = []
  afterAll(() => stops.forEach((stop) => stop()))

  it('are skipped by the scan and the watcher probe alike, without blocking', async () => {
    writeCopilotSession(cpDir, 'real', '/nowhere/x', 'a real session', '2026-09-20T10:00:00Z')
    mkdirSync(join(cpDir, 'session-state', 'piped'), { recursive: true })
    stops.push(makeFifo(join(cpDir, 'session-state', 'piped', 'events.jsonl')))
    // the real session's name file is a FIFO too: the title falls back to the prompt
    stops.push(makeFifo(join(cpDir, 'session-state', 'real', 'workspace.yaml')))
    mkdirSync(join(clDir, 'projects', 'p'), { recursive: true })
    const piped = join(clDir, 'projects', 'p', 'piped.jsonl')
    stops.push(makeFifo(piped))

    const started = Date.now()
    const idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([
      { path: cpDir, provider: 'copilot', label: 'cp' },
      { path: clDir, provider: 'claude', label: 'cl' }
    ])
    idx.stopWatchers()
    // a pipe announced by the watcher is probed the same way
    ;(idx as any).markDirty('change', piped)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(idx.page({}).items.map((s) => [s.id, s.title])).toEqual([['copilot:real', 'a real session']])
    expect((idx as any).rescanTimer).toBeNull()
  })
})

describe('known repo roots', () => {
  const dir = join(root, 'claude-roots')
  const projDir = join(dir, 'projects', 'p')
  function repo(name: string): string {
    const r = join(root, 'roots', name)
    mkdirSync(join(r, '.git'), { recursive: true })
    writeFileSync(join(r, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/acme/${name}.git\n`)
    return r
  }
  function session(name: string, cwd: string): string {
    mkdirSync(projDir, { recursive: true })
    const f = join(projDir, `${name}.jsonl`)
    writeFileSync(
      f,
      jsonl([{ type: 'user', message: { role: 'user', content: name }, timestamp: '2026-09-20T10:00:00Z', sessionId: name, cwd }])
    )
    return f
  }
  let idx: SessionIndexer

  beforeAll(async () => {
    session('r1', repo('one'))
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: dir, provider: 'claude', label: 'roots' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('are kept between questions and re-derived once the index changes', () => {
    const roots = idx.knownRepoRoots()
    expect([...roots]).toEqual([join(root, 'roots', 'one')])
    // asked on every IPC call that names a root: the same answer, not a fresh listRepos()
    expect(idx.knownRepoRoots()).toBe(roots)
    // a session in a repo never seen before, picked up by the watcher's probe
    const two = repo('two')
    ;(idx as any).markDirty('change', session('r2', two))
    expect(idx.knownRepoRoots().has(two)).toBe(true)
    // and one archived by the user is still a root the app may work in
    idx.setArchived(['claude:r2'])
    expect(idx.knownRepoRoots().has(two)).toBe(true)
  })
})

// Several agents writing at once is the ordinary case: the watcher's pacing must keep
// the index moving while their combined write rate never pauses.
describe('watcher pacing under parallel writers', () => {
  const dir = join(root, 'claude-parallel')
  const projDir = join(dir, 'projects', 'p')
  const names = ['w1', 'w2', 'w3']
  const file = (name: string): string => join(projDir, `${name}.jsonl`)
  const line = (name: string, text: string): string =>
    jsonl([{ type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-20T10:00:00Z', sessionId: name, cwd: '/nowhere/p' }])
  let idx: SessionIndexer

  beforeAll(async () => {
    mkdirSync(projDir, { recursive: true })
    for (const n of names) writeFileSync(file(n), line(n, `start ${n}`))
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: dir, provider: 'claude', label: 'par' }])
    idx.stopWatchers()
  })

  afterAll(() => {
    vi.useRealTimers()
    idx?.stopWatchers()
  })

  it('flushes every written file within the refresh window, however often any of them is written', () => {
    vi.useFakeTimers()
    try {
      const counts = (): number[] => names.map((n) => idx.getSession(`claude:${n}`)?.messageCount ?? 0)
      expect(counts()).toEqual([1, 1, 1])
      // three logs appended in rotation every 200ms: no 500ms of quiet, ever
      for (let i = 0; i < 9; i++) {
        const n = names[i % names.length]
        appendFileSync(file(n), line(n, `write ${i}`))
        ;(idx as any).markDirty('change', file(n))
        vi.advanceTimersByTime(200)
      }
      // by now each file was written three times, and every write had its flush
      expect(counts()).toEqual([4, 4, 4])
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a full rescan within its maximum wait while structural events keep arriving', () => {
    vi.useFakeTimers()
    const rescan = vi.spyOn(idx, 'rescan').mockResolvedValue()
    try {
      // a file not indexed yet, created and written on macOS: every append arrives as 'rename'
      for (let t = 0; t < 2750; t += 250) {
        ;(idx as any).markDirty('rename', file('fresh'))
        vi.advanceTimersByTime(250)
      }
      expect(rescan).not.toHaveBeenCalled()
      ;(idx as any).markDirty('rename', file('fresh'))
      vi.advanceTimersByTime(250)
      expect(rescan).toHaveBeenCalledTimes(1)
      // the next burst gets a fresh deadline, and a quiet one still settles first
      ;(idx as any).markDirty('rename', file('fresh'))
      vi.advanceTimersByTime(700)
      expect(rescan).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(100)
      expect(rescan).toHaveBeenCalledTimes(2)
    } finally {
      rescan.mockRestore()
      idx.stopWatchers()
      vi.useRealTimers()
    }
  })

  it('refreshes a known file on rename alone while it is still there, and rescans once it is gone', () => {
    const anyIdx = idx as any
    const rescan = vi.spyOn(idx, 'rescan').mockResolvedValue()
    try {
      const before = idx.getSession('claude:w2')?.messageCount ?? 0
      appendFileSync(file('w2'), line('w2', 'appended while fresh'))
      anyIdx.markDirty('rename', file('w2'))
      expect(anyIdx.rescanTimer).toBeNull()
      anyIdx.applyDirty()
      expect(idx.getSession('claude:w2')?.messageCount).toBe(before + 1)
      rmSync(file('w2'))
      anyIdx.markDirty('rename', file('w2'))
      expect(anyIdx.rescanTimer).not.toBeNull()
    } finally {
      rescan.mockRestore()
      idx.stopWatchers()
    }
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

describe('first tree from the stat cache', () => {
  const seedHome = join(root, 'claude-seed')
  const cacheFile = join(root, 'cache-seed', 'index-cache.json')

  /** Like writeClaudeSession, but into a config home this describe block owns. */
  function writeIn(home: string, name: string, title: string): void {
    const dir = join(home, 'projects', 'p')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${name}.jsonl`),
      jsonl([
        {
          type: 'user',
          message: { role: 'user', content: title },
          timestamp: '2026-08-01T10:00:00Z',
          sessionId: name,
          cwd: '/nowhere/seed',
          gitBranch: 'main'
        },
        { type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: '2026-08-01T10:00:00Z' }
      ])
    )
  }

  it('lists last run’s sessions before the first scan has read anything', async () => {
    writeIn(seedHome, 'seed-1', 'a session from last launch')
    const first = new SessionIndexer(() => {}, { cacheFile, claudeStoreDir: null })
    await first.setSources([{ path: seedHome, provider: 'claude', label: 'seed' }])
    first.stopWatchers()
    expect(first.page({}).items).toHaveLength(1)
    first.saveCache()

    // next launch: the tree is answerable the moment sources are set, while the
    // scan that will replace it is still running
    const second = new SessionIndexer(() => {}, { cacheFile, claudeStoreDir: null })
    const scan = second.setSources([{ path: seedHome, provider: 'claude', label: 'seed' }])
    const seeded = second.page({}).items
    expect(seeded.map((s) => s.title)).toEqual(['a session from last launch'])
    await scan
    second.stopWatchers()
    expect(second.page({}).items.map((s) => s.title)).toEqual(['a session from last launch'])
  })

  it('leaves out cached files that belong to a source no longer configured', async () => {
    const gone = join(root, 'claude-seed-gone')
    writeIn(gone, 'seed-2', 'a session from a removed source')
    const cache2 = join(root, 'cache-seed-2', 'index-cache.json')
    const first = new SessionIndexer(() => {}, { cacheFile: cache2, claudeStoreDir: null })
    await first.setSources([
      { path: seedHome, provider: 'claude', label: 'seed' },
      { path: gone, provider: 'claude', label: 'gone' }
    ])
    first.stopWatchers()
    expect(first.page({}).items).toHaveLength(2)
    first.saveCache()

    const second = new SessionIndexer(() => {}, { cacheFile: cache2, claudeStoreDir: null })
    const scan = second.setSources([{ path: seedHome, provider: 'claude', label: 'seed' }])
    expect(second.page({}).items.map((s) => s.title)).toEqual(['a session from last launch'])
    await scan
    second.stopWatchers()
  })
})

describe('cache save overlap (unique tmp file per save)', () => {
  const raceHome = join(root, 'claude-race')
  const cacheDir = join(root, 'cache-race')
  const cacheFile = join(cacheDir, 'index-cache.json')

  beforeAll(() => {
    const dir = join(raceHome, 'projects', 'p')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'race1.jsonl'),
      jsonl([
        {
          type: 'user',
          message: { role: 'user', content: 'racing saves' },
          timestamp: '2026-08-05T10:00:00Z',
          sessionId: 'race1',
          cwd: '/nowhere/race',
          gitBranch: 'main'
        },
        { type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: '2026-08-05T10:00:01Z' }
      ])
    )
  })

  async function indexerWithCache(): Promise<SessionIndexer> {
    const idx = new SessionIndexer(() => {}, { cacheFile, claudeStoreDir: null })
    await idx.setSources([{ path: raceHome, provider: 'claude', label: 'race' }])
    idx.stopWatchers()
    return idx
  }

  function saveFailures(spy: { mock: { calls: unknown[][] } }): unknown[][] {
    return spy.mock.calls.filter((c) => String(c[0]).includes('cache save failed'))
  }

  it('overlapping async flushes and a quit flush all land without ENOENT', async () => {
    const errors = vi.spyOn(console, 'error')
    try {
      const idx = await indexerWithCache()
      const anyIdx = idx as any
      // two debounced flushes overlapping plus the synchronous quit flush —
      // with a fixed tmp name the first rename consumed the shared tmp file
      // and the later renames failed with ENOENT
      anyIdx.cacheDirty = true
      const first = anyIdx.saveCacheAsync()
      anyIdx.cacheDirty = true
      const second = anyIdx.saveCacheAsync()
      idx.saveCache()
      await Promise.all([first, second])

      expect(saveFailures(errors)).toEqual([])
      const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
      expect(raw.entries.length).toBeGreaterThan(0)
      expect(readdirSync(cacheDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      errors.mockRestore()
    }
  })

  it('two indexers sharing one cache file save concurrently (two app instances)', async () => {
    const errors = vi.spyOn(console, 'error')
    try {
      const a = await indexerWithCache()
      const b = await indexerWithCache()
      ;(a as any).cacheDirty = true
      ;(b as any).cacheDirty = true
      await Promise.all([(a as any).saveCacheAsync(), (b as any).saveCacheAsync()])

      expect(saveFailures(errors)).toEqual([])
      const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
      expect(raw.entries.length).toBeGreaterThan(0)
      expect(readdirSync(cacheDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      errors.mockRestore()
    }
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

// Only Claude stamps a branch on its log lines: Copilot dropped context.branch after
// CLI 1.0.80 and most Codex rollouts carry no git block, so without this fallback
// every recent session of theirs shows no branch chip and never matches its PR.
describe('branch fallback (log first, then the checkout itself)', () => {
  const home = join(root, 'copilot-branch')
  const repo = join(root, 'repo-b')
  const worktree = join(root, 'wt-b')
  let idx: SessionIndexer

  afterAll(() => idx?.stopWatchers())

  beforeAll(async () => {
    mkdirSync(join(repo, '.git', 'worktrees', 'feat'), { recursive: true })
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/repo-b.git\n')
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(repo, '.git', 'worktrees', 'feat', 'HEAD'), 'ref: refs/heads/cockpit/feat\n')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'feat')}\n`)
    clearRepoCache()

    // what the current Copilot CLI writes: a context of { cwd } and nothing else
    const write = (id: string, cwd: string, ctx: Record<string, unknown>): void => {
      const dir = join(home, 'session-state', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'events.jsonl'),
        jsonl([
          { type: 'session.start', timestamp: '2026-08-10T10:00:00Z', data: { sessionId: id, context: { cwd, ...ctx } } },
          { type: 'user.message', timestamp: '2026-08-10T10:00:00Z', data: { content: id } }
        ])
      )
    }
    write('no-branch-logged', worktree, {})
    write('branch-logged', worktree, { branch: 'titan/what-the-log-said' })
    write('cwd-is-gone', join(root, 'deleted-worktree'), { branch: 'titan/remembered' })

    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: home, provider: 'copilot', label: 'branch-test' }])
    idx.stopWatchers()
  })

  const branchOf = (id: string): string | null | undefined =>
    idx.page({}).items.find((s) => s.nativeId === id)?.gitBranch

  it("derives the branch from the worktree's HEAD when the log records none", () => {
    expect(branchOf('no-branch-logged')).toBe('cockpit/feat')
  })

  it('keeps what the log recorded when it has one (the branch the session ran on)', () => {
    expect(branchOf('branch-logged')).toBe('titan/what-the-log-said')
  })

  it('falls back to the log for a cwd that is gone (deleted worktree)', () => {
    expect(branchOf('cwd-is-gone')).toBe('titan/remembered')
  })

  it('searches the derived branch, not just the logged one', () => {
    expect(idx.page({ search: 'cockpit/feat' }).total).toBe(1)
  })

  // a derived branch must never stick: it is recomputed from logBranch every scan,
  // so a worktree that moves — or a HEAD caught detached mid-rebase — self-corrects
  it('follows the worktree onto a new branch across rescans', async () => {
    writeFileSync(join(repo, '.git', 'worktrees', 'feat', 'HEAD'), 'ref: refs/heads/cockpit/moved\n')
    await idx.rescan()
    idx.stopWatchers()
    expect(branchOf('no-branch-logged')).toBe('cockpit/moved')
    expect(branchOf('branch-logged')).toBe('titan/what-the-log-said')
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

describe('handoff lineage (stamping + chain grouping)', () => {
  const home = join(root, 'claude-lineage')
  const cacheFile = join(root, 'cache-lineage', 'index-cache.json')
  let idx: SessionIndexer

  function writeSession(name: string, ts: string): void {
    const dir = join(home, 'projects', 'p')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${name}.jsonl`),
      jsonl([
        {
          type: 'user',
          message: { role: 'user', content: `task ${name}` },
          timestamp: ts,
          sessionId: name,
          cwd: '/nowhere/lineage',
          gitBranch: 'main'
        },
        { type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: ts }
      ])
    )
  }

  beforeAll(async () => {
    writeSession('ln-old', '2026-08-01T10:00:00Z')
    writeSession('ln-mid', '2026-08-03T10:00:00Z')
    writeSession('ln-new', '2026-08-04T10:00:00Z')
    idx = new SessionIndexer(() => {}, { cacheFile, claudeStoreDir: null })
    await idx.setSources([{ path: home, provider: 'claude', label: 'lineage' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('pulls a chain together under its newest member', () => {
    idx.setLineage({ 'claude:ln-new': 'claude:ln-old' })
    // pure recency would give [new, mid, old] — the chained ancestor moves up
    expect(idx.page({}).items.map((s) => s.nativeId)).toEqual(['ln-new', 'ln-old', 'ln-mid'])
  })

  it('stamps continuedFrom on page rows and getSession, never on unrelated rows', () => {
    idx.setLineage({ 'claude:ln-new': 'claude:ln-old' })
    const items = idx.page({}).items
    expect(items.find((s) => s.nativeId === 'ln-new')?.continuedFrom).toBe('claude:ln-old')
    expect(items.find((s) => s.nativeId === 'ln-mid')?.continuedFrom).toBeUndefined()
    expect(idx.getSession('claude:ln-new')?.continuedFrom).toBe('claude:ln-old')
    expect(idx.getSession('claude:missing')).toBeNull()
  })

  it('a chain split across page boundaries stays contiguous over the concatenation', () => {
    idx.setLineage({ 'claude:ln-new': 'claude:ln-old' })
    const first = idx.page({ limit: 2 }).items.map((s) => s.nativeId)
    const second = idx.page({ offset: 2, limit: 2 }).items.map((s) => s.nativeId)
    expect([...first, ...second]).toEqual(['ln-new', 'ln-old', 'ln-mid'])
  })

  it('lineage pointing at an unindexed session keeps the chip but not the grouping', () => {
    idx.setLineage({ 'claude:ln-new': 'claude:gone' })
    const items = idx.page({}).items
    expect(items.map((s) => s.nativeId)).toEqual(['ln-new', 'ln-mid', 'ln-old'])
    expect(items[0].continuedFrom).toBe('claude:gone')
  })

  it('a hand-edited lineage cycle neither hangs nor drops sessions', () => {
    idx.setLineage({ 'claude:ln-new': 'claude:ln-old', 'claude:ln-old': 'claude:ln-new' })
    const ids = idx.page({}).items.map((s) => s.nativeId)
    expect([...ids].sort()).toEqual(['ln-mid', 'ln-new', 'ln-old'])
  })

  it('never persists the stamp into the stat cache', () => {
    idx.setLineage({ 'claude:ln-new': 'claude:ln-old' })
    idx.page({})
    ;(idx as unknown as { cacheDirty: boolean }).cacheDirty = true
    idx.saveCache()
    const raw = readFileSync(cacheFile, 'utf8')
    expect(raw).not.toContain('continuedFrom')
  })
})

// A Copilot session another session created names its creator at kickoff; the tree
// shows such children under their parent, so the pages have to deliver them that way.
describe('child sessions (family grouping)', () => {
  const home = join(root, 'copilot-family')
  const cacheFile = join(root, 'cache-family', 'index-cache.json')
  let idx: SessionIndexer

  function writeSession(id: string, ts: string, creator?: string): void {
    const dir = join(home, 'session-state', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'events.jsonl')
    const kickoff = creator
      ? `<copilot_tauri_workspace>\ncreator_chat_session_id: ${creator}\n</copilot_tauri_workspace>\n\ntask ${id}`
      : undefined
    writeFileSync(
      file,
      jsonl([
        { type: 'session.start', timestamp: ts, data: { sessionId: id, context: { cwd: '/nowhere/family' } } },
        { type: 'user.message', timestamp: ts, data: { content: `task ${id}`, ...(kickoff ? { transformedContent: kickoff } : {}) } }
      ])
    )
    utimesSync(file, new Date(ts), new Date(ts))
  }

  beforeAll(async () => {
    writeSession('fam-parent', '2026-08-01T10:00:00Z')
    writeSession('fam-grandchild', '2026-08-02T10:00:00Z', 'fam-child-old')
    writeSession('fam-child-old', '2026-08-03T10:00:00Z', 'fam-parent')
    writeSession('fam-other', '2026-08-04T10:00:00Z')
    writeSession('fam-child-new', '2026-08-05T10:00:00Z', 'fam-parent')
    writeSession('fam-orphan', '2026-08-06T10:00:00Z', 'never-indexed')
    idx = new SessionIndexer(() => {}, { cacheFile, claudeStoreDir: null })
    await idx.setSources([{ path: home, provider: 'copilot', label: 'family' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('pulls a family under its parent, at its most recent member, children by recency', () => {
    // recency alone: orphan, child-new, other, child-old, grandchild, parent
    expect(idx.page({}).items.map((s) => s.nativeId)).toEqual([
      'fam-orphan',
      'fam-parent',
      'fam-child-new',
      'fam-child-old',
      'fam-grandchild',
      'fam-other'
    ])
  })

  it('keeps the parent on every row that has one, and getSession too', () => {
    const items = idx.page({}).items
    expect(items.find((s) => s.nativeId === 'fam-child-new')?.parentId).toBe('copilot:fam-parent')
    expect(items.find((s) => s.nativeId === 'fam-parent')?.parentId).toBeUndefined()
    expect(idx.getSession('copilot:fam-grandchild')?.parentId).toBe('copilot:fam-child-old')
  })

  it('a family split across page boundaries stays contiguous over the concatenation', () => {
    const first = idx.page({ limit: 3 }).items.map((s) => s.nativeId)
    const second = idx.page({ offset: 3, limit: 3 }).items.map((s) => s.nativeId)
    expect([...first, ...second]).toEqual(idx.page({}).items.map((s) => s.nativeId))
  })

  it('a child whose parent is filtered out stays where recency put it', () => {
    const found = idx.page({ search: 'fam-child' }).items.map((s) => s.nativeId)
    expect(found).toEqual(['fam-child-new', 'fam-child-old'])
  })
})

describe('groupFamilies', () => {
  const meta = (id: string, updatedAt: number, parentId?: string): SessionMeta => ({
    id,
    provider: 'copilot',
    nativeId: id,
    source: 'test',
    title: id,
    cwd: null,
    logBranch: null,
    startedAt: updatedAt,
    updatedAt,
    messageCount: 1,
    sourcePath: `/nowhere/${id}`,
    ...(parentId ? { parentId } : {})
  })

  it('returns the list untouched when no parent is present', () => {
    const list = [meta('a', 3), meta('b', 2, 'gone'), meta('c', 1)]
    expect(groupFamilies(list)).toBe(list)
  })

  it('a cycle in the logs neither hangs nor drops sessions', () => {
    const list = [meta('a', 4, 'b'), meta('b', 3, 'a'), meta('c', 2, 'a'), meta('d', 1, 'd')]
    const ids = groupFamilies(list).map((s) => s.id)
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

// Live status from logs: the indexer feeds every fresh parse to its liveness tracker,
// so a session mid-turn on disk is busy without any process of Cockpit's own.
describe('live status from logs', () => {
  const liveDir = join(root, 'live-claude')
  const projDir = join(liveDir, 'projects', 'p')
  // a turn that opened a moment ago: the log's own timestamps must be fresh too, since
  // the tracker trusts them over the mtime of a file that was merely just written
  const secondsAgo = (n: number): string => new Date(Date.now() - n * 1000).toISOString()
  const T0 = secondsAgo(20)
  const midTurn = (id: string): unknown[] => [
    { type: 'user', message: { role: 'user', content: 'fix it' }, timestamp: T0, sessionId: id, cwd: repoA },
    {
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      timestamp: secondsAgo(15)
    }
  ]
  const finalAnswer = {
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
    timestamp: secondsAgo(10)
  }
  let idx: SessionIndexer
  const pushes: BusySession[][] = []

  beforeAll(async () => {
    mkdirSync(projDir, { recursive: true })
    writeFileSync(join(projDir, 'running.jsonl'), jsonl(midTurn('running')))
    // the same shape, but written long ago: a CLI killed mid-turn
    const stale = join(projDir, 'stale.jsonl')
    writeFileSync(stale, jsonl(midTurn('stale')))
    utimesSync(stale, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))
    // and one just written whose records are hours old: a restore, not a turn
    const restored = join(projDir, 'restored.jsonl')
    const hoursOld = new Date(Date.now() - 5 * 3_600_000).toISOString()
    writeFileSync(
      restored,
      jsonl([{ type: 'user', message: { role: 'user', content: 'old prompt' }, timestamp: hoursOld, sessionId: 'restored', cwd: repoA }])
    )
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null, onLiveChange: (s) => pushes.push(s) })
    await idx.setSources([{ path: liveDir, provider: 'claude', label: 'live' }])
  })
  afterAll(() => idx?.stopWatchers())

  it('a fresh mid-turn log is busy after the scan, from its prompt; stale and restored ones are not', () => {
    expect(idx.page({}).total).toBe(3)
    expect(idx.liveSessions()).toEqual([
      { id: 'claude:running', startedAt: Date.parse(T0), source: 'observed' }
    ])
    expect(pushes.at(-1)).toEqual(idx.liveSessions())
  })

  it('the final answer lands through the watcher path and the session leaves the set', async () => {
    const file = join(projDir, 'running.jsonl')
    appendFileSync(file, jsonl([finalAnswer]))
    ;(idx as any).markDirty('change', file)
    await vi.waitFor(() => expect(idx.liveSessions()).toEqual([]), { timeout: 5000, interval: 50 })
    expect(pushes.at(-1)).toEqual([])
  })

  it('a new prompt makes it busy again, and a subagent write is its heartbeat', async () => {
    const file = join(projDir, 'running.jsonl')
    const T2 = secondsAgo(5)
    appendFileSync(file, jsonl([{ type: 'user', message: { role: 'user', content: 'now delegate' }, timestamp: T2 }]))
    ;(idx as any).markDirty('change', file)
    await vi.waitFor(() => expect(idx.liveSessions().map((s) => s.id)).toEqual(['claude:running']), {
      timeout: 5000,
      interval: 50
    })
    expect(idx.liveSessions()[0].startedAt).toBe(Date.parse(T2))
    // the subagent transcript is ignored by the index but routed to the tracker
    const before = pushes.length
    ;(idx as any).sessionRootEvent(join(liveDir, 'projects'), 'change', 'p/running/subagents/agent-1.jsonl')
    expect(idx.liveSessions().map((s) => s.id)).toEqual(['claude:running'])
    expect(pushes.length).toBe(before)
    expect(idx.page({}).total).toBe(3)
  })

  it('stopping the watchers clears the observed set', () => {
    idx.stopWatchers()
    expect(idx.liveSessions()).toEqual([])
    expect(pushes.at(-1)).toEqual([])
  })
})

describe('a Codex thread paginated across rollouts', () => {
  const dir = join(root, 'codex-paged')
  let t: PagedThread
  let idx: SessionIndexer

  beforeAll(async () => {
    t = writePagedThread(dir, '/nowhere/paged')
    idx = new SessionIndexer(() => {}, { claudeStoreDir: null })
    await idx.setSources([{ path: dir, provider: 'codex', label: 'cx' }])
    idx.stopWatchers()
  })

  afterAll(() => idx?.stopWatchers())

  it('is one session over its newest file, started when the thread started', () => {
    const items = idx.page({}).items.filter((s) => s.id === `codex:${t.threadId}`)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      sourcePath: t.page2,
      segments: [{ path: t.page1, endByte: t.endByte }],
      title: 'first question about pagination',
      startedAt: Date.parse('2026-09-01T10:00:00Z'),
      updatedAt: Date.parse('2026-09-02T09:00:05Z')
    })
    expect(items[0].messageCount).toBeGreaterThanOrEqual(4)
  })

  it('opens as the whole thread', () => {
    expect(idx.getMessages(`codex:${t.threadId}`).map((m) => m.text)).toEqual([
      'first question about pagination',
      'first answer',
      'second question',
      'second answer'
    ])
  })

  it('stays one thread while its newest page is written', () => {
    const anyIdx = idx as any
    appendFileSync(
      t.page2,
      JSON.stringify({
        timestamp: '2026-09-02T09:10:00Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'third question' }] }
      }) + '\n'
    )
    anyIdx.dirty.add(t.page2)
    anyIdx.applyDirty()
    const s = idx.getSession(`codex:${t.threadId}`)
    expect(s?.segments).toEqual([{ path: t.page1, endByte: t.endByte }])
    expect(s?.startedAt).toBe(Date.parse('2026-09-01T10:00:00Z'))
    expect(idx.getMessages(`codex:${t.threadId}`).at(-1)?.text).toBe('third question')
  })
})

describe('foldThread', () => {
  const meta = (over: Partial<SessionMeta>): SessionMeta => ({
    id: 'codex:t',
    provider: 'codex',
    nativeId: 't',
    source: 'cx',
    title: 't',
    cwd: null,
    logBranch: null,
    startedAt: 1,
    updatedAt: 1,
    messageCount: 1,
    sourcePath: '/a',
    ...over
  })

  it('keeps the most recently updated copy of one log found under two sources', () => {
    const older = meta({ sourcePath: '/one/a', updatedAt: 5 })
    const newer = meta({ sourcePath: '/two/a', updatedAt: 9 })
    expect(foldThread([newer, older])).toBe(newer)
    expect(foldThread([older, newer])).toBe(newer)
  })

  it('chains pages oldest first, and a copy of a page is not a page of its own', () => {
    const p1 = meta({ sourcePath: '/s/p1', startedAt: 10, updatedAt: 20, messageCount: 4, title: 'the question' })
    const p1copy = meta({ ...p1, sourcePath: '/other/p1' })
    const p2 = meta({ sourcePath: '/s/p2', startedAt: 30, updatedAt: 40, messageCount: 2, historyBase: { endByte: 100 } })
    const p3 = meta({ sourcePath: '/s/p3', startedAt: 50, updatedAt: 60, messageCount: 1, historyBase: { endByte: 7 } })
    const folded = foldThread([p3, p1, p2, p1copy])
    expect(folded).toMatchObject({
      sourcePath: '/s/p3',
      title: 'the question',
      startedAt: 10,
      updatedAt: 60,
      messageCount: 7
    })
    expect(folded.segments?.map((s) => s.endByte)).toEqual([100, 7])
    expect(folded.segments?.[1].path).toBe('/s/p2')
  })
})

describe('subagentParent', () => {
  it('names the parent session of a Claude subagent transcript, and nothing else', () => {
    expect(subagentParent('/h/.claude/projects/-Users-x-app/abc-123/subagents/agent-9f.jsonl')).toBe('claude:abc-123')
    expect(subagentParent('/h/.claude/projects/-Users-x-app/abc-123/subagents/agent-9f.meta.json')).toBeNull()
    expect(subagentParent('/h/.claude/projects/-Users-x-app/abc-123.jsonl')).toBeNull()
    expect(subagentParent('/h/.codex/sessions/2026/09/16/rollout-x.jsonl')).toBeNull()
  })
})
