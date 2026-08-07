import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionIndexer } from '../src/main/indexer'
import { clearRepoCache } from '../src/main/repos'

const root = join(tmpdir(), 'cockpit-indexer-fixtures')
const claudeDir = join(root, 'claude')
const repoA = join(root, 'repo-a')

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

  indexer = new SessionIndexer(() => {})
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
})
