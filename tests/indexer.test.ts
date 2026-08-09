import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

describe.skipIf(!hasSqlite3())('provider-archived sessions (copilot data.db)', () => {
  function writeCopilotSession(id: string, cwd: string, title: string, ts: string): void {
    const dir = join(copilotDir, 'session-state', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'events.jsonl'),
      jsonl([
        {
          type: 'session.start',
          timestamp: ts,
          data: { sessionId: id, context: { cwd, branch: 'main' } }
        },
        { type: 'user.message', timestamp: ts, data: { content: title } }
      ])
    )
  }

  let idx: SessionIndexer

  beforeAll(async () => {
    writeCopilotSession('c1', '/nowhere/one', 'active session', '2026-08-01T10:00:00Z')
    writeCopilotSession('c2', '/nowhere/two', 'archived in the copilot app', '2026-08-02T10:00:00Z')
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
