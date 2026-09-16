import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BusySession, Provider, SessionMeta } from '../src/shared/types'
import { LIVE_TAIL_STEPS, LivenessTracker, readTurnState } from '../src/main/liveness'

const root = join(tmpdir(), 'cockpit-liveness-fixtures')

function jsonl(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

/** What the parsers would say about a log active right now (updatedAt is its last timestamp). */
function meta(provider: Provider, nativeId: string, file: string, updatedAt = Date.now()): SessionMeta {
  return {
    id: `${provider}:${nativeId}`,
    provider,
    nativeId,
    source: 'test',
    title: 't',
    cwd: '/x',
    logBranch: null,
    startedAt: 0,
    updatedAt,
    messageCount: 1,
    sourcePath: file
  }
}

/** Set a file's mtime this many ms in the past. */
function age(file: string, ms: number): void {
  const t = new Date(Date.now() - ms)
  utimesSync(file, t, t)
}

const mtime = (file: string): number => statSync(file).mtimeMs
const isLive = (file: string, provider: Provider): boolean => readTurnState(file, provider)?.live === true

/** Bookkeeping records worth about `bytes` in total — what buries a decisive record. */
function padding(bytes: number): unknown[] {
  const bulk = { type: 'attachment', content: 'x'.repeat(4096) }
  return Array.from({ length: Math.ceil(bytes / 4096) }, () => bulk)
}

const T0 = '2026-09-16T10:00:00.000Z'
const T1 = '2026-09-16T10:00:05.000Z'

/** Per provider: a log ending mid-turn, and the record that ends the turn. */
const FIXTURES: Record<Provider, { file: string; midTurn: unknown[]; final: unknown; startedAt: number }> = {
  claude: {
    file: 'claude/projects/p/c1.jsonl',
    midTurn: [
      { type: 'user', message: { role: 'user', content: 'fix it' }, timestamp: T0, sessionId: 'c1', cwd: '/x' },
      {
        type: 'assistant',
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
        timestamp: T1
      }
    ],
    final: {
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      timestamp: T1
    },
    startedAt: Date.parse(T0)
  },
  codex: {
    file: 'codex/sessions/2026/09/16/rollout-x1.jsonl',
    midTurn: [
      { timestamp: T0, type: 'session_meta', payload: { id: 'x1', cwd: '/x' } },
      { timestamp: T0, type: 'event_msg', payload: { type: 'task_started', turn_id: 't', started_at: 1789556848 } },
      { timestamp: T1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } }
    ],
    final: { timestamp: T1, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } },
    startedAt: 1789556848000
  },
  copilot: {
    file: 'copilot/session-state/p1/events.jsonl',
    midTurn: [
      { type: 'session.start', data: { sessionId: 'p1', context: { cwd: '/x' } }, timestamp: T0 },
      { type: 'user.message', data: { content: 'go' }, timestamp: T0 },
      { type: 'assistant.turn_start', data: { turnId: '0' }, timestamp: T1 }
    ],
    final: { type: 'assistant.turn_end', data: { turnId: '0' }, timestamp: T1 },
    startedAt: Date.parse(T0)
  }
}

function writeFixture(provider: Provider, records: unknown[]): string {
  const file = join(root, FIXTURES[provider].file)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, jsonl(records))
  return file
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

const trackers: LivenessTracker[] = []
function tracker(onChange: (s: BusySession[]) => void = () => {}, opts = {}): LivenessTracker {
  const t = new LivenessTracker(onChange, opts)
  trackers.push(t)
  return t
}
afterEach(() => {
  for (const t of trackers.splice(0)) t.stop()
})

describe('readTurnState', () => {
  for (const provider of ['claude', 'codex', 'copilot'] as const) {
    const fx = FIXTURES[provider]
    it(`${provider}: a log ending mid-turn is live, from the turn's opening record`, () => {
      const file = writeFixture(provider, fx.midTurn)
      expect(readTurnState(file, provider)).toEqual({ live: true, startedAt: fx.startedAt })
    })
    it(`${provider}: the record that ends the turn makes it idle`, () => {
      const file = writeFixture(provider, [...fx.midTurn, fx.final])
      expect(readTurnState(file, provider)).toEqual({ live: false, startedAt: null })
    })
    it(`${provider}: an unreadable tail is not live, never an error`, () => {
      expect(isLive(join(root, provider, 'missing.jsonl'), provider)).toBe(false)
      const garbage = writeFixture(provider, [])
      writeFileSync(garbage, 'not json at all\n{"type":\n')
      expect(isLive(garbage, provider)).toBe(false)
      writeFileSync(garbage, '')
      expect(isLive(garbage, provider)).toBe(false)
    })
  }

  it('reads a bounded tail: a prompt that scrolled out leaves the start unknown', () => {
    const fx = FIXTURES.claude
    const [prompt, toolUse] = fx.midTurn
    const file = writeFixture('claude', [prompt, ...padding(LIVE_TAIL_STEPS[0] * 2), toolUse])
    expect(readTurnState(file, 'claude')).toEqual({ live: true, startedAt: null })
    appendFileSync(file, jsonl([fx.final]))
    expect(isLive(file, 'claude')).toBe(false)
  })

  it('looks further back when the first window holds nothing decisive', () => {
    const fx = FIXTURES.claude
    const file = writeFixture('claude', [...fx.midTurn, ...padding(LIVE_TAIL_STEPS[0] * 2)])
    expect(readTurnState(file, 'claude')).toEqual({ live: true, startedAt: fx.startedAt })
    appendFileSync(file, jsonl([fx.final, ...padding(LIVE_TAIL_STEPS[0] * 2)]))
    expect(readTurnState(file, 'claude')).toEqual({ live: false, startedAt: null })
  })

  it('declares the tail silent past the last window rather than reading the file', () => {
    const fx = FIXTURES.claude
    const file = writeFixture('claude', [...fx.midTurn, ...padding(LIVE_TAIL_STEPS[LIVE_TAIL_STEPS.length - 1] + 64 * 1024)])
    expect(readTurnState(file, 'claude')).toBeNull()
  })

  it('a partially written last line is ignored, not misjudged', () => {
    const fx = FIXTURES.claude
    const file = writeFixture('claude', fx.midTurn)
    appendFileSync(file, JSON.stringify(fx.final).slice(0, 40))
    expect(isLive(file, 'claude')).toBe(true)
  })

  it("copilot's legacy JSON snapshots are never live", () => {
    const file = join(root, 'copilot', 'history-session-state', 'old.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ sessionId: 'old', timeline: [{ role: 'user', content: 'hi' }] }))
    expect(isLive(file, 'copilot')).toBe(false)
  })
})

describe('LivenessTracker', () => {
  for (const provider of ['claude', 'codex', 'copilot'] as const) {
    const fx = FIXTURES[provider]
    const id = `${provider}:${provider === 'claude' ? 'c1' : provider === 'codex' ? 'x1' : 'p1'}`

    it(`${provider}: a fresh mid-turn log is live; the final record ends it; each transition pushes once`, () => {
      const pushes: BusySession[][] = []
      const t = tracker((s) => pushes.push(s))
      const file = writeFixture(provider, fx.midTurn)
      t.observe(file, meta(provider, id.split(':')[1], file), mtime(file))
      expect(t.sessions()).toEqual([{ id, startedAt: fx.startedAt, source: 'observed' }])
      expect(pushes).toEqual([[{ id, startedAt: fx.startedAt, source: 'observed' }]])

      // more of the same turn: no new push, the start is kept
      appendFileSync(file, jsonl([{ type: 'attachment' }]))
      t.observe(file, meta(provider, id.split(':')[1], file), mtime(file))
      expect(pushes.length).toBe(1)

      appendFileSync(file, jsonl([fx.final]))
      t.observe(file, meta(provider, id.split(':')[1], file), mtime(file))
      expect(t.sessions()).toEqual([])
      expect(pushes).toEqual([[{ id, startedAt: fx.startedAt, source: 'observed' }], []])
    })

    it(`${provider}: a stale mid-turn log is not live and reads no tail`, () => {
      const pushes: BusySession[][] = []
      const t = tracker((s) => pushes.push(s))
      const file = writeFixture(provider, fx.midTurn)
      age(file, 10 * 60_000)
      t.observe(file, meta(provider, id.split(':')[1], file), mtime(file))
      expect(t.sessions()).toEqual([])
      expect(pushes).toEqual([])
    })

    it(`${provider}: an unreadable log is not live`, () => {
      const t = tracker()
      const file = writeFixture(provider, [])
      writeFileSync(file, 'garbage\n')
      t.observe(file, meta(provider, id.split(':')[1], file), mtime(file))
      expect(t.sessions()).toEqual([])
    })
  }

  it('a log whose own timestamps are old is not live, however fresh the file', () => {
    const pushes: BusySession[][] = []
    const t = tracker((s) => pushes.push(s))
    const file = writeFixture('claude', FIXTURES.claude.midTurn)
    // just written (a restore, a sync), but the log says its last activity was long ago
    t.observe(file, meta('claude', 'c1', file, Date.now() - 10 * 60_000), mtime(file))
    expect(t.sessions()).toEqual([])
    expect(pushes).toEqual([])
  })

  it('going stale drops a live session on the sweep and pushes the change', async () => {
    const pushes: BusySession[][] = []
    const t = tracker((s) => pushes.push(s), { windowMs: 300, sweepMs: 50 })
    const file = writeFixture('claude', FIXTURES.claude.midTurn)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(t.sessions().length).toBe(1)
    await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
    expect(pushes.at(-1)).toEqual([])
  })

  it('a heartbeat keeps a live session past the window, and never creates one', async () => {
    const t = tracker(() => {}, { windowMs: 300, sweepMs: 50 })
    const file = writeFixture('claude', FIXTURES.claude.midTurn)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    t.heartbeat('claude:nobody')
    expect(t.sessions().map((s) => s.id)).toEqual(['claude:c1'])
    const until = Date.now() + 600
    while (Date.now() < until) {
      t.heartbeat('claude:c1')
      await new Promise((r) => setTimeout(r, 40))
    }
    expect(t.sessions().map((s) => s.id)).toEqual(['claude:c1'])
    await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
  })

  it('a turn whose opening record has scrolled out starts from the last write, then keeps that', () => {
    const t = tracker()
    const fx = FIXTURES.claude
    const [prompt, toolUse] = fx.midTurn
    const file = writeFixture('claude', [prompt, ...padding(LIVE_TAIL_STEPS[0] * 2), toolUse])
    const first = mtime(file)
    t.observe(file, meta('claude', 'c1', file, first), first)
    expect(t.sessions()).toEqual([{ id: 'claude:c1', startedAt: first, source: 'observed' }])
    appendFileSync(file, jsonl([{ type: 'attachment' }]))
    t.observe(file, meta('claude', 'c1', file, first + 5000), first + 5000)
    expect(t.sessions()[0].startedAt).toBe(first)
  })

  it('a silent tail keeps a running turn running and never starts one', () => {
    const pushes: BusySession[][] = []
    const t = tracker((s) => pushes.push(s))
    const fx = FIXTURES.claude
    const silent = padding(LIVE_TAIL_STEPS[LIVE_TAIL_STEPS.length - 1] + 64 * 1024)
    const file = writeFixture('claude', [...fx.midTurn, ...silent])
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(t.sessions()).toEqual([])
    expect(pushes).toEqual([])
    // now seen running first, then buried: still running
    writeFileSync(file, jsonl(fx.midTurn))
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    appendFileSync(file, jsonl(silent))
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(t.sessions().map((s) => s.id)).toEqual(['claude:c1'])
    expect(pushes.length).toBe(1)
  })

  it('a new turn replaces the start it learns from the new prompt', () => {
    const t = tracker()
    const fx = FIXTURES.claude
    const file = writeFixture('claude', fx.midTurn)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    const T2 = '2026-09-16T10:05:00.000Z'
    appendFileSync(file, jsonl([fx.final, { type: 'user', message: { role: 'user', content: 'and now this' }, timestamp: T2 }]))
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(t.sessions()).toEqual([{ id: 'claude:c1', startedAt: Date.parse(T2), source: 'observed' }])
  })

  it('stop() forgets everything and says so once', () => {
    const pushes: BusySession[][] = []
    const t = tracker((s) => pushes.push(s))
    const file = writeFixture('claude', FIXTURES.claude.midTurn)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    t.stop()
    t.stop()
    expect(t.sessions()).toEqual([])
    expect(pushes.length).toBe(2)
    expect(pushes[1]).toEqual([])
  })
})
