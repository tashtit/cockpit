import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionIndexer } from '../src/main/indexer'
import { clearRepoCache } from '../src/main/repos'
import { TranscriptSearcher } from '../src/main/transcript-search'

const root = join(tmpdir(), 'cockpit-transcript-search-fixtures')
const claudeDir = join(root, 'claude')
const codexDir = join(root, 'codex')
const copilotDir = join(root, 'copilot')
const repoA = join(root, 'repo-a')
const repoB = join(root, 'repo-b')

const TS = '2026-09-01T10:00:00Z'

function jsonl(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

function gitRepo(dir: string, fullName: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/${fullName}.git\n`)
}

function claudeLine(id: string, cwd: string, type: 'user' | 'assistant', content: unknown): object {
  return { type, message: { role: type, content }, timestamp: TS, sessionId: id, cwd, gitBranch: 'main' }
}

function writeClaude(id: string, cwd: string, lines: object[]): void {
  const dir = join(claudeDir, 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.jsonl`), jsonl(lines))
}

function writeCodex(cwd: string): void {
  const dir = join(codexDir, 'sessions', '2026', '09', '01')
  mkdirSync(dir, { recursive: true })
  const item = (payload: object): object => ({ timestamp: TS, type: 'response_item', payload })
  writeFileSync(
    join(dir, 'rollout-2026-09-01T10-00-00-thr-1.jsonl'),
    jsonl([
      { timestamp: TS, type: 'session_meta', payload: { id: 'thr-1', cwd, timestamp: TS } },
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'How do I set up Kubernetes secrets?' }] }),
      // the event_msg echo of the same turn — must not double the hit
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'How do I set up Kubernetes secrets?' } },
      item({ type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","echo SECRETTOKEN"]}' }),
      item({ type: 'function_call_output', output: 'SECRETTOKEN printed' }),
      item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Use a sealed secret.' }] })
    ])
  )
}

function writeCopilot(id: string, cwd: string): void {
  const dir = join(copilotDir, 'session-state', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'events.jsonl'),
    jsonl([
      { type: 'session.start', timestamp: TS, data: { sessionId: id, context: { cwd, branch: 'main' } } },
      { type: 'user.message', timestamp: TS, data: { content: 'Deploy the api to the kubernetes cluster' } },
      { type: 'tool.execution_start', timestamp: TS, data: { toolName: 'bash', arguments: { command: 'cat SECRETTOKEN' } } },
      { type: 'assistant.message', timestamp: TS, data: { content: 'Deployed.' } }
    ])
  )
}

let indexer: SessionIndexer
let searcher: TranscriptSearcher

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true })
  clearRepoCache()
  gitRepo(repoA, 'acme/repo-a')
  gitRepo(repoB, 'acme/repo-b')

  // c1: the conversation mentions kubernetes twice; the tool payloads carry the token
  writeClaude('c1', repoA, [
    claudeLine('c1', repoA, 'user', "Let's plan the Kubernetes migration for the ingress"),
    claudeLine('c1', repoA, 'assistant', [
      { type: 'text', text: 'The kubernetes ingress needs a cert first.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'echo SECRETTOKEN' } }
    ]),
    claudeLine('c1', repoA, 'user', [{ type: 'tool_result', content: 'SECRETTOKEN in output' }]),
    claudeLine('c1', repoA, 'assistant', 'Done.')
  ])
  // c2: nothing relevant, other repo
  writeClaude('c2', repoB, [
    claudeLine('c2', repoB, 'user', 'unrelated question'),
    claudeLine('c2', repoB, 'assistant', 'nothing to see here')
  ])
  // c3: five messages all about pagination — the per-session cap's target
  writeClaude(
    'c3',
    repoA,
    [1, 2, 3, 4, 5].map((n) =>
      claudeLine('c3', repoA, n % 2 ? 'user' : 'assistant', `pagination note number ${n}`)
    )
  )
  // c4: a large preamble puts the only match past a small per-file cap
  writeClaude('c4', repoB, [
    claudeLine('c4', repoB, 'user', 'filler '.repeat(600)),
    claudeLine('c4', repoB, 'assistant', 'still filler'),
    claudeLine('c4', repoB, 'user', 'the needleXYZ sits at the very end')
  ])
  writeCodex(repoA)
  writeCopilot('cp-1', repoB)

  indexer = new SessionIndexer(() => {}, { claudeStoreDir: null })
  await indexer.setSources([
    { path: claudeDir, provider: 'claude', label: 'claude' },
    { path: codexDir, provider: 'codex', label: 'codex' },
    { path: copilotDir, provider: 'copilot', label: 'copilot' }
  ])
  indexer.stopWatchers()
  searcher = new TranscriptSearcher(indexer)
})

afterAll(() => indexer?.stopWatchers())

describe('transcriptCandidates', () => {
  it('lists every visible session newest first, scoped by repo and provider', () => {
    const all = indexer.transcriptCandidates({})
    expect(all.map((s) => s.id).sort()).toEqual(
      ['claude:c1', 'claude:c2', 'claude:c3', 'claude:c4', 'codex:thr-1', 'copilot:cp-1'].sort()
    )
    for (let i = 1; i < all.length; i++) expect(all[i - 1].updatedAt).toBeGreaterThanOrEqual(all[i].updatedAt)
    expect(indexer.transcriptCandidates({ repoKey: 'gh:acme/repo-a' }).map((s) => s.id).sort()).toEqual(
      ['claude:c1', 'claude:c3', 'codex:thr-1']
    )
    expect(indexer.transcriptCandidates({ providers: ['copilot'] }).map((s) => s.id)).toEqual(['copilot:cp-1'])
  })

  it('leaves archived sessions out, and hidden repos out of unscoped queries only', () => {
    indexer.setArchived(['claude:c1'])
    expect(indexer.transcriptCandidates({}).some((s) => s.id === 'claude:c1')).toBe(false)
    indexer.setArchived([])
    indexer.setHiddenRepos(['gh:acme/repo-b'])
    expect(indexer.transcriptCandidates({}).some((s) => s.repo?.key === 'gh:acme/repo-b')).toBe(false)
    expect(indexer.transcriptCandidates({ repoKey: 'gh:acme/repo-b' }).length).toBeGreaterThan(0)
    indexer.setHiddenRepos([])
  })
})

describe('TranscriptSearcher', () => {
  it('finds user and assistant text across all three agents, marked in a snippet', async () => {
    const res = await searcher.search({ text: 'kubernetes' })
    expect(res.stoppedBy).toBe('complete')
    expect(res.candidates).toBe(6)
    expect(res.scanned).toBe(6)
    const bySession = new Map<string, string[]>()
    for (const h of res.hits) bySession.set(h.sessionId, [...(bySession.get(h.sessionId) ?? []), h.role])
    expect(bySession.get('claude:c1')).toEqual(['user', 'assistant'])
    // the codex turn is persisted twice (item + echo) and counts once
    expect(bySession.get('codex:thr-1')).toEqual(['user'])
    expect(bySession.get('copilot:cp-1')).toEqual(['user'])
    expect(res.hits).toHaveLength(4)
    for (const h of res.hits) {
      expect(h.snippet.slice(h.matchStart, h.matchEnd).toLowerCase()).toBe('kubernetes')
      expect(h.timestamp).toBe(Date.parse(TS))
    }
    // the sessions come back stamped so the UI can open them directly
    expect(res.sessions.map((s) => s.id).sort()).toEqual(['claude:c1', 'codex:thr-1', 'copilot:cp-1'])
    expect(res.sessions.every((s) => s.archived === false)).toBe(true)
  })

  it('leaves tool calls and results out unless the query opts in', async () => {
    const quiet = await searcher.search({ text: 'SECRETTOKEN' })
    expect(quiet.hits).toEqual([])
    const loud = await searcher.search({ text: 'SECRETTOKEN', includeTools: true })
    expect(loud.hits.every((h) => h.role === 'tool')).toBe(true)
    const ids = new Set(loud.hits.map((h) => h.sessionId))
    expect([...ids].sort()).toEqual(['claude:c1', 'codex:thr-1', 'copilot:cp-1'])
    // claude: tool_use input + tool_result; codex: call + output; copilot: the call
    expect(loud.hits).toHaveLength(5)
  })

  it('reads a transcript only up to the per-file cap, and says so', async () => {
    const small = new TranscriptSearcher(indexer, { maxBytesPerFile: 2048 })
    const capped = await small.search({ text: 'needlexyz' })
    expect(capped.hits).toEqual([])
    expect(capped.truncated).toBe(1)
    const full = await searcher.search({ text: 'needlexyz' })
    expect(full.hits.map((h) => h.sessionId)).toEqual(['claude:c4'])
    expect(full.truncated).toBe(0)
  })

  it('a newer query cancels the one in flight', async () => {
    const first = searcher.search({ text: 'kubernetes' })
    const second = searcher.search({ text: 'pagination' })
    const [a, b] = await Promise.all([first, second])
    expect(a.stoppedBy).toBe('cancelled')
    expect(a.scanned).toBeLessThan(a.candidates)
    expect(b.stoppedBy).toBe('complete')
    expect(b.hits.length).toBeGreaterThan(0)
  })

  it('cancel() stops the in-flight search on its own', async () => {
    const pending = searcher.search({ text: 'kubernetes' })
    searcher.cancel()
    const res = await pending
    expect(res.stoppedBy).toBe('cancelled')
    expect(res.hits).toEqual([])
  })

  it('scopes to one repository and to providers', async () => {
    const scoped = await searcher.search({ text: 'kubernetes', repoKey: 'gh:acme/repo-a' })
    expect(new Set(scoped.hits.map((h) => h.sessionId))).toEqual(new Set(['claude:c1', 'codex:thr-1']))
    expect(scoped.candidates).toBe(3)
    const copilotOnly = await searcher.search({ text: 'kubernetes', providers: ['copilot'] })
    expect(copilotOnly.hits.map((h) => h.sessionId)).toEqual(['copilot:cp-1'])
    // an unknown provider name from the renderer is dropped, not trusted
    const junk = await searcher.search({ text: 'kubernetes', providers: ['nope' as never] })
    expect(junk.candidates).toBe(6)
  })

  it('caps hits per session and in total', async () => {
    const two = await searcher.search({ text: 'pagination', perSession: 2 })
    expect(two.hits).toHaveLength(2)
    expect(two.stoppedBy).toBe('complete')
    const one = await searcher.search({ text: 'kubernetes', limit: 1 })
    expect(one.hits).toHaveLength(1)
    expect(one.stoppedBy).toBe('hit-cap')
    expect(one.scanned).toBeLessThan(one.candidates)
  })

  it('a query under two characters reads nothing', async () => {
    const res = await searcher.search({ text: ' k ' })
    expect(res).toMatchObject({ query: 'k', hits: [], candidates: 0, scanned: 0, stoppedBy: 'complete' })
  })

  it('matches across collapsed whitespace, case-insensitively', async () => {
    const res = await searcher.search({ text: '  KUBERNETES   MIGRATION ' })
    expect(res.query).toBe('KUBERNETES MIGRATION')
    expect(res.hits.map((h) => h.sessionId)).toEqual(['claude:c1'])
    expect(res.hits[0].snippet.slice(res.hits[0].matchStart, res.hits[0].matchEnd)).toBe('Kubernetes migration')
  })

  it('returns partial results when the time budget runs out', async () => {
    const hurried = new TranscriptSearcher(indexer, { timeBudgetMs: 0 })
    const res = await hurried.search({ text: 'kubernetes' })
    expect(res.stoppedBy).toBe('time')
    expect(res.scanned).toBe(0)
    expect(res.candidates).toBe(6)
  })
})
