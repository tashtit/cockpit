import { afterAll, describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import type { BusySession, Provider, SessionMeta } from '../src/shared/types'
import { LIVE_TAIL_STEPS, LivenessTracker, readTurnState, type LivenessOptions } from '../src/main/liveness'

const root = mkdtempSync(join(tmpdir(), 'cockpit-liveness-fixtures-'))

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

const NATIVE: Record<Provider, string> = { claude: 'c1', codex: 'x1', copilot: 'p1' }

/**
 * The two things silence can mean, per provider: a turn waiting on the model (the
 * plain window — `thinking`) and one waiting on a tool call that writes nothing until
 * it finishes (the tool window — `thinking` plus `inTool`), with the record that
 * finally closes the call.
 */
const SILENCE: Record<
  Provider,
  { readonly thinking: readonly unknown[]; readonly inTool: unknown; readonly toolDone: unknown }
> = {
  claude: {
    // the prompt alone: the model has been handed the turn and has written nothing yet
    thinking: [FIXTURES.claude.midTurn[0]],
    inTool: FIXTURES.claude.midTurn[1],
    toolDone: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
      toolUseResult: {},
      timestamp: T1
    }
  },
  codex: {
    thinking: FIXTURES.codex.midTurn,
    inTool: { timestamp: T1, type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    toolDone: { timestamp: T1, type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } }
  },
  copilot: {
    thinking: FIXTURES.copilot.midTurn,
    inTool: { type: 'tool.execution_start', data: { toolCallId: 'a' }, timestamp: T1 },
    toolDone: { type: 'tool.execution_complete', data: { toolCallId: 'a' }, timestamp: T1 }
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
function tracker(onChange: (s: BusySession[]) => void = () => {}, opts: LivenessOptions = {}): LivenessTracker {
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
      expect(readTurnState(file, provider)).toMatchObject({ live: true, startedAt: fx.startedAt })
    })
    it(`${provider}: the record that ends the turn makes it idle`, () => {
      const file = writeFixture(provider, [...fx.midTurn, fx.final])
      expect(readTurnState(file, provider)).toMatchObject({ live: false, startedAt: null })
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
    expect(readTurnState(file, 'claude')).toMatchObject({ live: true, startedAt: null })
    appendFileSync(file, jsonl([fx.final]))
    expect(isLive(file, 'claude')).toBe(false)
  })

  it('looks further back when the first window holds nothing decisive', () => {
    const fx = FIXTURES.claude
    const file = writeFixture('claude', [...fx.midTurn, ...padding(LIVE_TAIL_STEPS[0] * 2)])
    expect(readTurnState(file, 'claude')).toMatchObject({ live: true, startedAt: fx.startedAt })
    appendFileSync(file, jsonl([fx.final, ...padding(LIVE_TAIL_STEPS[0] * 2)]))
    expect(readTurnState(file, 'claude')).toMatchObject({ live: false, startedAt: null })
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
    const t = tracker((s) => pushes.push(s), { windowMs: 300, toolWindowMs: 300, sweepMs: 50 })
    const file = writeFixture('claude', FIXTURES.claude.midTurn)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(t.sessions().length).toBe(1)
    await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
    expect(pushes.at(-1)).toEqual([])
  })

  it('a heartbeat keeps a live session past the window, and never creates one', async () => {
    const t = tracker(() => {}, { windowMs: 300, toolWindowMs: 300, sweepMs: 50 })
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

describe('LivenessTracker — what it tells the attention desk', () => {
  type Ev = import('../src/main/liveness').ObservedTurn

  it('a turn seen running whose log then ends is an ending, with its start and closing words', () => {
    const events: Ev[] = []
    const t = tracker(() => {}, { onTurn: (ev) => events.push(ev) })
    const fx = FIXTURES.claude
    const file = writeFixture('claude', fx.midTurn)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(events).toEqual([{ type: 'running', id: 'claude:c1', provider: 'claude', cwd: '/x' }])
    appendFileSync(file, jsonl([fx.final]))
    const m = meta('claude', 'c1', file)
    t.observe(file, m, mtime(file))
    expect(events.at(-1)).toEqual({
      type: 'ended',
      id: 'claude:c1',
      provider: 'claude',
      cwd: '/x',
      startedAt: fx.startedAt,
      endedAt: Math.min(mtime(file), m.updatedAt),
      closing: 'Done.'
    })
  })

  it('a log that is already ended when first seen is not an ending — it only settles what was waiting', () => {
    const events: Ev[] = []
    const t = tracker(() => {}, { onTurn: (ev) => events.push(ev) })
    const fx = FIXTURES.codex
    const file = writeFixture('codex', [...fx.midTurn, fx.final])
    t.observe(file, meta('codex', 'x1', file), mtime(file))
    expect(events).toEqual([{ type: 'settled', id: 'codex:x1', provider: 'codex', cwd: '/x' }])
    expect(t.sessions()).toEqual([])
  })

  it('a question answered after its entry expired settles it: the idle write is the only word', async () => {
    const events: Ev[] = []
    const t = tracker(() => {}, { windowMs: 200, toolWindowMs: 200, sweepMs: 40, onTurn: (ev) => events.push(ev) })
    const [prompt] = FIXTURES.claude.midTurn
    const question = {
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship it?' }] } }] },
      timestamp: T1
    }
    const file = writeFixture('claude', [prompt, question])
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
    // Esc on the question: the interrupt marker is the newest record
    appendFileSync(file, jsonl([{ type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' }, timestamp: T1 }]))
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(events.map((e) => e.type)).toEqual(['asks', 'settled'])
  })

  it('an API error the CLI stopped on is an ending that failed', () => {
    const events: Ev[] = []
    const t = tracker(() => {}, { onTurn: (ev) => events.push(ev) })
    const file = writeFixture('claude', FIXTURES.claude.midTurn)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    appendFileSync(file, jsonl([{ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] }, timestamp: T1 }]))
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(events.at(-1)).toMatchObject({ type: 'ended', closing: 'API Error: 529 Overloaded', failed: true })
  })

  it('expiry is silence, not an ending — a killed CLI or a long tool call never chimes', async () => {
    const events: Ev[] = []
    const t = tracker(() => {}, { windowMs: 300, toolWindowMs: 300, sweepMs: 50, onTurn: (ev) => events.push(ev) })
    const file = writeFixture('claude', FIXTURES.claude.midTurn)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
    expect(events.map((e) => e.type)).toEqual(['running'])
    // and a stale file — outside the window on arrival — says nothing either
    const old = writeFixture('codex', [...FIXTURES.codex.midTurn, FIXTURES.codex.final])
    age(old, 10 * 60_000)
    t.observe(old, meta('codex', 'x1', old), mtime(old))
    expect(events.map((e) => e.type)).toEqual(['running'])
  })

  it('a question is reported once, and the log moving past it is a turn running again', () => {
    const events: Ev[] = []
    const t = tracker(() => {}, { onTurn: (ev) => events.push(ev) })
    const [prompt] = FIXTURES.claude.midTurn
    const question = {
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship it?' }] } }] },
      timestamp: T1
    }
    const file = writeFixture('claude', [prompt, question])
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(events).toEqual([
      { type: 'asks', id: 'claude:c1', provider: 'claude', cwd: '/x', asks: { kind: 'question', detail: 'Ship it?' }, startedAt: FIXTURES.claude.startedAt }
    ])
    // the same tail again (a bookkeeping write): nothing new
    appendFileSync(file, jsonl([{ type: 'attachment' }]))
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(events).toHaveLength(1)
    // answered: the tool result is the newest record
    appendFileSync(file, jsonl([{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'yes' }] }, timestamp: T1 }]))
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(events.at(-1)).toEqual({ type: 'running', id: 'claude:c1', provider: 'claude', cwd: '/x' })
    expect(t.sessions().map((s) => s.id)).toEqual(['claude:c1'])
  })
})

describe('LivenessTracker — the tool window', () => {
  for (const provider of ['claude', 'codex', 'copilot'] as const) {
    const sil = SILENCE[provider]
    const nativeId = NATIVE[provider]
    const id = `${provider}:${nativeId}`

    it(`${provider}: a turn inside a tool call outlives the plain window, and drops back to it once the result is written`, async () => {
      const t = tracker(() => {}, { windowMs: 200, toolWindowMs: 3_000, sweepMs: 40 })
      const file = writeFixture(provider, [...sil.thinking, sil.inTool])
      t.observe(file, meta(provider, nativeId, file), mtime(file))
      await new Promise((r) => setTimeout(r, 600))
      expect(t.sessions().map((s) => s.id)).toEqual([id])
      // the result arrives: the model is thinking again, and silence means what it usually means
      appendFileSync(file, jsonl([sil.toolDone]))
      t.observe(file, meta(provider, nativeId, file), mtime(file))
      await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
    })

    it(`${provider}: a turn waiting on the model gets the plain window, tool window or not`, async () => {
      const t = tracker(() => {}, { windowMs: 150, toolWindowMs: 60_000, sweepMs: 40 })
      const file = writeFixture(provider, [...sil.thinking])
      t.observe(file, meta(provider, nativeId, file), mtime(file))
      expect(t.sessions().map((s) => s.id)).toEqual([id])
      await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
    })

    it(`${provider}: the tool window is longer, not unbounded — a killed CLI mid-tool still expires`, async () => {
      // the plain window is also the arrival gate, judged by the wall clock against the
      // file's mtime: at 100ms a loaded CI runner fell through it between the write and
      // the observe, and the entry was never made at all
      const t = tracker(() => {}, { windowMs: 250, toolWindowMs: 1_200, sweepMs: 40 })
      const file = writeFixture(provider, [...sil.thinking, sil.inTool])
      t.observe(file, meta(provider, nativeId, file), mtime(file))
      await new Promise((r) => setTimeout(r, 600))
      expect(t.sessions().map((s) => s.id)).toEqual([id]) // past the plain window
      await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
    })
  }

  it('the arrival gate is the plain window: an old tool call is not picked up late', () => {
    const t = tracker(() => {}, { windowMs: 200, toolWindowMs: 60_000 })
    const file = writeFixture('claude', FIXTURES.claude.midTurn)
    age(file, 5_000)
    t.observe(file, meta('claude', 'c1', file, Date.now() - 5_000), mtime(file))
    expect(t.sessions()).toEqual([])
  })
})

describe("LivenessTracker — copilot's own lock", () => {
  /** A copilot session directory of its own, so a lock in it reaches no other test. */
  function session(name: string, records: readonly unknown[]): string {
    const file = join(root, 'copilot/session-state', name, 'events.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, jsonl([...records]))
    return file
  }
  const lock = (file: string, pid: number): void =>
    writeFileSync(join(dirname(file), `inuse.${pid}.lock`), `${pid}\n`)
  /** A pid that has certainly gone: a child we waited on. */
  const deadPid = (): number => spawnSync('/usr/bin/true').pid
  const midTool = [...SILENCE.copilot.thinking, SILENCE.copilot.inTool]
  const observe = (t: LivenessTracker, file: string, nativeId: string): void =>
    t.observe(file, meta('copilot', nativeId, file), mtime(file))

  it('a lock held by a living process keeps a running turn past both windows', async () => {
    const t = tracker(() => {}, { windowMs: 100, toolWindowMs: 200, sweepMs: 40 })
    const file = session('held', midTool)
    lock(file, process.pid)
    observe(t, file, 'held')
    expect(t.sessions().map((s) => s.id)).toEqual(['copilot:held'])
    await new Promise((r) => setTimeout(r, 600)) // several sweeps past the tool window
    expect(t.sessions().map((s) => s.id)).toEqual(['copilot:held'])
  })

  it('a lock whose process has gone lets the turn expire at the next sweep', async () => {
    const t = tracker(() => {}, { windowMs: 100, toolWindowMs: 200, sweepMs: 40 })
    const file = session('stale-lock', midTool)
    lock(file, deadPid())
    observe(t, file, 'stale-lock')
    expect(t.sessions().map((s) => s.id)).toEqual(['copilot:stale-lock'])
    await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
  })

  it('a live lock with no running turn creates nothing — the log is what starts one', () => {
    const t = tracker(() => {}, { windowMs: 100, toolWindowMs: 200, sweepMs: 40 })
    const ended = session('ended', [...SILENCE.copilot.thinking, FIXTURES.copilot.final])
    lock(ended, process.pid)
    observe(t, ended, 'ended')
    expect(t.sessions()).toEqual([])
    // and the arrival gate is untouched: an old log is not picked up because a CLI holds it
    const old = session('old', midTool)
    lock(old, process.pid)
    age(old, 10 * 60_000)
    t.observe(old, meta('copilot', 'old', old, Date.now() - 10 * 60_000), mtime(old))
    expect(t.sessions()).toEqual([])
  })

  it('an unreadable lock, or none at all, leaves the windows to decide', async () => {
    const t = tracker(() => {}, { windowMs: 100, toolWindowMs: 200, sweepMs: 40 })
    const file = session('no-lock', midTool)
    writeFileSync(join(dirname(file), '.workspace-fork.lock'), '') // copilot's other lock is not this one
    writeFileSync(join(dirname(file), 'inuse.lock'), 'no pid here')
    observe(t, file, 'no-lock')
    expect(t.sessions().map((s) => s.id)).toEqual(['copilot:no-lock'])
    await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
  })

  it("the lock is copilot's alone: another provider's entry expires beside one", async () => {
    const t = tracker(() => {}, { windowMs: 100, toolWindowMs: 200, sweepMs: 40 })
    const file = writeFixture('claude', [...SILENCE.claude.thinking, SILENCE.claude.inTool])
    writeFileSync(join(dirname(file), `inuse.${process.pid}.lock`), `${process.pid}\n`)
    t.observe(file, meta('claude', 'c1', file), mtime(file))
    expect(t.sessions().map((s) => s.id)).toEqual(['claude:c1'])
    await vi.waitFor(() => expect(t.sessions()).toEqual([]), { timeout: 3000, interval: 25 })
    rmSync(join(dirname(file), `inuse.${process.pid}.lock`), { force: true })
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
