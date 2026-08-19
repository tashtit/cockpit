import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionIndexer } from '../src/main/indexer'
import { clearRepoCache } from '../src/main/repos'
import { getHandoffBriefing } from '../src/main/handoff'

/**
 * Deterministic briefing path over real fixtures: a claude session log indexed by
 * the real indexer, whose cwd is a real (tiny) git repository. The AI-improve path
 * shells out to provider CLIs and stays untested, like ChatManager itself.
 */

const root = join(tmpdir(), 'cockpit-handoff-fixtures')
const home = join(root, 'claude')
const repo = join(root, 'repo')
const goneCwd = join(root, 'gone-away')
const plainDir = join(root, 'no-git')

function git(args: string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], {
    stdio: 'ignore'
  })
}

function writeSession(name: string, cwd: string, title: string): void {
  const dir = join(home, 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.jsonl`),
    [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: title },
        timestamp: '2026-08-10T10:00:00Z',
        sessionId: name,
        cwd,
        gitBranch: 'main'
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'On it — starting with the parser.' },
        timestamp: '2026-08-10T10:00:01Z'
      })
    ].join('\n') + '\n'
  )
}

let indexer: SessionIndexer

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true })
  clearRepoCache()

  mkdirSync(repo, { recursive: true })
  git(['init', '-b', 'main'])
  writeFileSync(join(repo, 'app.ts'), 'export const one = 1\n')
  git(['add', '.'])
  git(['commit', '-m', 'feat: initial commit'])
  writeFileSync(join(repo, 'app.ts'), 'export const one = 2\n')
  writeFileSync(join(repo, 'notes.md'), 'scratch\n')

  mkdirSync(goneCwd, { recursive: true })
  mkdirSync(plainDir, { recursive: true })

  writeSession('h1', repo, 'teach the parser about new codex events')
  writeSession('h2', goneCwd, 'session whose worktree was deleted')
  writeSession('h3', plainDir, 'session outside any git repo')

  indexer = new SessionIndexer(() => {}, { claudeStoreDir: null })
  await indexer.setSources([{ path: home, provider: 'claude', label: 'test' }])
  indexer.stopWatchers()
  rmSync(goneCwd, { recursive: true, force: true })
})

afterAll(() => indexer?.stopWatchers())

describe('getHandoffBriefing', () => {
  it('builds a briefing whose git section matches the real repository', async () => {
    const res = await getHandoffBriefing(indexer, 'claude:h1')
    expect(res.cwdExists).toBe(true)
    expect(res.briefing).toContain('teach the parser about new codex events')
    expect(res.briefing).toContain('On it — starting with the parser.')
    expect(res.briefing).toContain(' M app.ts')
    expect(res.briefing).toContain('?? notes.md')
    expect(res.briefing).toContain('feat: initial commit')
    expect(res.briefing).toContain('- Branch: main')
    expect(res.warnings).toBeUndefined()
  })

  it('flags a deleted working directory and still returns the transcript digest', async () => {
    const res = await getHandoffBriefing(indexer, 'claude:h2')
    expect(res.cwdExists).toBe(false)
    expect(res.briefing).toContain('session whose worktree was deleted')
    expect(res.briefing).toContain('(unavailable — the working directory no longer exists)')
    expect(res.warnings?.some((w) => w.includes('no longer exists'))).toBe(true)
  })

  it('a cwd outside any git repo yields the git-unavailable warning', async () => {
    const res = await getHandoffBriefing(indexer, 'claude:h3')
    expect(res.cwdExists).toBe(true)
    expect(res.briefing).toContain('not a git repository')
    expect(res.warnings?.some((w) => w.includes('could not be read'))).toBe(true)
  })

  it('throws on an unknown session id', async () => {
    await expect(getHandoffBriefing(indexer, 'claude:nope')).rejects.toThrow('Unknown session')
  })
})
