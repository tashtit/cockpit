import { describe, it, expect } from 'vitest'
import {
  IDLE,
  copilotLockPids,
  judgeClaudeTail,
  judgeCodexTail,
  judgeCopilotTail,
  judgeTail,
  mergeBusy
} from '../src/main/liveness-core'

const T0 = '2026-09-16T10:00:00.000Z'
const T1 = '2026-09-16T10:00:05.000Z'
const T2 = '2026-09-16T10:00:09.000Z'
const ms = (iso: string): number => Date.parse(iso)

/* ---------- claude ---------- */

const prompt = (text = 'fix the bug', ts = T0): unknown => ({
  type: 'user',
  message: { role: 'user', content: text },
  timestamp: ts
})
const toolUse = (ts = T1, stop: string | null = 'tool_use'): unknown => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    stop_reason: stop,
    content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]
  },
  timestamp: ts
})
const toolResult = (ts = T2): unknown => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
  toolUseResult: { stdout: 'ok' },
  timestamp: ts
})
const answer = (ts = T2, stop: string | null = 'end_turn'): unknown => ({
  type: 'assistant',
  message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'Done.' }] },
  timestamp: ts
})

describe('judgeClaudeTail', () => {
  it('a prompt with no answer yet is live, from the prompt', () => {
    expect(judgeClaudeTail([prompt()])).toEqual({ live: true, startedAt: ms(T0) })
  })
  it('a tool_use waiting on its tool is live, from the turn prompt, and says it is inside a tool', () => {
    expect(judgeClaudeTail([prompt(), toolUse()])).toEqual({ live: true, startedAt: ms(T0), inTool: true })
  })
  it('a tool result waiting on the model is live', () => {
    expect(judgeClaudeTail([prompt(), toolUse(), toolResult()])).toEqual({
      live: true,
      startedAt: ms(T0)
    })
  })
  it('a text-only answer ends the turn, and its words come along for the notification', () => {
    expect(judgeClaudeTail([prompt(), toolUse(), toolResult(), answer()])).toEqual({ ...IDLE, closing: 'Done.' })
  })
  it('content blocks decide, not stop_reason: the desktop harness stamps end_turn on tool_use', () => {
    expect(judgeClaudeTail([prompt(), toolUse(T1, 'end_turn')])?.live).toBe(true)
  })
  it('a text block whose stop_reason is tool_use is mid-turn (the tool_use line follows)', () => {
    expect(judgeClaudeTail([prompt(), answer(T1, 'tool_use')])?.live).toBe(true)
  })
  it('streamed thinking with nothing said yet is live', () => {
    const thinking = {
      type: 'assistant',
      message: { role: 'assistant', stop_reason: null, content: [{ type: 'thinking', thinking: '…' }] },
      timestamp: T1
    }
    expect(judgeClaudeTail([prompt(), thinking])).toEqual({ live: true, startedAt: ms(T0) })
  })
  it('the Stop hook summary confirms the end', () => {
    const summary = { type: 'system', subtype: 'stop_hook_summary', hookCount: 1 }
    expect(judgeClaudeTail([prompt(), answer(), summary])).toEqual({ ...IDLE, closing: 'Done.' })
    // and it is the newest word even after a tool_use line (a hook that ran on abort)
    expect(judgeClaudeTail([prompt(), toolUse(), summary])).toEqual(IDLE)
  })
  it('an API error the CLI is retrying is still a turn', () => {
    const err = { type: 'system', subtype: 'api_error', level: 'warning', retryAttempt: 1 }
    expect(judgeClaudeTail([prompt(), err])).toEqual({ live: true, startedAt: ms(T0) })
  })
  it('an API error or usage limit the CLI stopped on ends the turn as a failure, with its words', () => {
    const stopped = {
      type: 'assistant',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] },
      timestamp: T2
    }
    expect(judgeClaudeTail([prompt(), toolUse(), toolResult(), stopped])).toEqual({
      ...IDLE,
      closing: 'API Error: 529 Overloaded',
      failed: true
    })
  })
  it('the interrupt marker ends the turn', () => {
    expect(judgeClaudeTail([prompt(), toolUse(), prompt('[Request interrupted by user for tool use]', T2)])).toEqual(IDLE)
  })
  it('local slash-command echoes start no turn', () => {
    expect(judgeClaudeTail([prompt(), answer(), prompt('<command-name>/cost</command-name>', T2)])).toEqual(IDLE)
    expect(judgeClaudeTail([prompt(), answer(), prompt('<local-command-stdout>…</local-command-stdout>', T2)])).toEqual(IDLE)
  })
  it('a prompt wrapped in a system-reminder block is still a prompt', () => {
    expect(judgeClaudeTail([prompt('<system-reminder>ctx</system-reminder>\nfix it')])?.live).toBe(true)
  })
  it('bookkeeping records after the decisive one change nothing', () => {
    const misc = [
      { type: 'last-prompt', content: 'x' },
      { type: 'atis-latch' },
      { type: 'attachment', timestamp: T2 },
      { type: 'custom-title', customTitle: 'Name' },
      { type: 'queue-operation' }
    ]
    expect(judgeClaudeTail([prompt(), toolUse(), ...misc])?.live).toBe(true)
    expect(judgeClaudeTail([prompt(), answer(), ...misc])).toMatchObject(IDLE)
  })
  it('inlined sidechain lines speak for the subagent, not the parent', () => {
    const sub = { ...(answer(T2) as object), isSidechain: true }
    expect(judgeClaudeTail([prompt(), toolUse(), sub])?.live).toBe(true)
  })
  it('a new prompt after an answer opens a new turn, from the new prompt', () => {
    expect(judgeClaudeTail([prompt(), answer(T1), prompt('more', T2)])).toEqual({
      live: true,
      startedAt: ms(T2)
    })
  })
  it('a turn whose prompt scrolled out of the tail is live with an unknown start', () => {
    expect(judgeClaudeTail([toolResult(T1), toolUse(T2)])).toEqual({ live: true, startedAt: null, inTool: true })
  })
  it('a tail with nothing that speaks for the turn is silent, not idle', () => {
    expect(judgeClaudeTail([])).toBeNull()
    expect(judgeClaudeTail([{ type: 'summary', summary: 'x' }, null, 42, 'str'])).toBeNull()
    expect(judgeClaudeTail([{ type: 'assistant' }, { type: 'attachment' }])).toBeNull()
  })
})

/* ---------- codex ---------- */

const ev = (type: string, extra: object = {}, ts = T1): unknown => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type, ...extra }
})
const item = (payload: object, ts = T1): unknown => ({ timestamp: ts, type: 'response_item', payload })
const started = ev('task_started', { turn_id: 't1', started_at: 1789556848 }, T0)

describe('judgeCodexTail', () => {
  it('task_started opens a turn, from its own started_at (epoch seconds)', () => {
    expect(judgeCodexTail([started])).toEqual({ live: true, startedAt: 1789556848000 })
  })
  it('the turn stays live through the records a turn writes', () => {
    const mid = [
      started,
      { timestamp: T1, type: 'turn_context', payload: { cwd: '/x' } },
      item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }),
      item({ type: 'reasoning', summary: [] }),
      item({ type: 'custom_tool_call', name: 'shell', input: 'ls' }),
      item({ type: 'custom_tool_call_output', output: 'a b' }),
      ev('item_completed'),
      ev('token_count'),
      { timestamp: T2, type: 'token_usage_record', usage: {} }
    ]
    expect(judgeCodexTail(mid)).toEqual({ live: true, startedAt: 1789556848000 })
  })
  it('task_complete ends it, and the settings record after it changes nothing', () => {
    expect(judgeCodexTail([started, ev('task_complete', { turn_id: 't1' }, T2)])).toEqual(IDLE)
    expect(judgeCodexTail([started, ev('task_complete'), ev('thread_settings_applied')])).toEqual(IDLE)
  })
  it('turn_aborted ends it', () => {
    expect(judgeCodexTail([started, ev('turn_aborted', { reason: 'interrupted' })])).toEqual(IDLE)
  })
  it('a fresh rollout that is only its header is idle', () => {
    const meta = { timestamp: T0, type: 'session_meta', payload: { id: 's', cwd: '/x' } }
    expect(judgeCodexTail([meta])).toEqual(IDLE)
    expect(judgeCodexTail([meta, item({ type: 'compaction' }), ev('thread_settings_applied')])).toEqual(IDLE)
  })
  it('falls back to task_started even without its started_at', () => {
    expect(judgeCodexTail([ev('task_started', {}, T2)])).toEqual({ live: true, startedAt: ms(T2) })
  })
  describe('rollouts without markers (bare ResponseItems)', () => {
    it('a prompt is live, an answer is not', () => {
      expect(judgeCodexTail([{ type: 'message', role: 'user', content: 'hi', timestamp: T0 }])).toEqual({
        live: true,
        startedAt: ms(T0)
      })
      expect(judgeCodexTail([{ type: 'message', role: 'assistant', content: 'done' }])).toEqual({ ...IDLE, closing: 'done' })
    })
    it('commentary and tool traffic are mid-turn, a final answer is not', () => {
      expect(judgeCodexTail([item({ type: 'message', role: 'assistant', phase: 'commentary' })])?.live).toBe(true)
      expect(judgeCodexTail([item({ type: 'function_call', name: 'shell' })])?.live).toBe(true)
      expect(judgeCodexTail([item({ type: 'function_call_output', output: '' })])?.live).toBe(true)
      expect(judgeCodexTail([item({ type: 'message', role: 'assistant', phase: 'final_answer' })])).toEqual(IDLE)
    })
    it('developer instructions ride along with the prompt before them', () => {
      expect(
        judgeCodexTail([
          item({ type: 'message', role: 'user', content: 'go' }, T0),
          item({ type: 'message', role: 'developer', content: '# AGENTS.md' }, T1)
        ])
      ).toEqual({ live: true, startedAt: ms(T0) })
    })
  })
  it('a tail of nothing but echoes and bookkeeping is silent, not idle', () => {
    expect(judgeCodexTail([])).toBeNull()
    expect(judgeCodexTail([null, 'x', { type: 'world_state' }, ev('item_completed'), ev('token_count')])).toBeNull()
  })
})

/* ---------- copilot ---------- */

const cp = (type: string, ts = T1, data: object = {}): unknown => ({ type, data, timestamp: ts })

describe('judgeCopilotTail', () => {
  it('a user message is live, from itself', () => {
    expect(judgeCopilotTail([cp('session.start', T0), cp('user.message', T0)])).toEqual({
      live: true,
      startedAt: ms(T0)
    })
  })
  it('turn_start is live, from the user message that opened the turn', () => {
    const recs = [cp('user.message', T0), cp('assistant.turn_start', T1), cp('assistant.message', T1), cp('tool.execution_start', T2), cp('hook.start', T2)]
    expect(judgeCopilotTail(recs)).toEqual({ live: true, startedAt: ms(T0), inTool: true })
  })
  it('a second round-trip in the same turn keeps the first start', () => {
    const recs = [cp('user.message', T0), cp('assistant.turn_start', T1), cp('assistant.turn_end', T1), cp('assistant.turn_start', T2)]
    expect(judgeCopilotTail(recs)).toEqual({ live: true, startedAt: ms(T0) })
  })
  it('turn_start with its user message out of the tail starts from itself', () => {
    expect(judgeCopilotTail([cp('assistant.turn_end', T0), cp('assistant.turn_start', T1)])).toEqual({
      live: true,
      startedAt: ms(T1)
    })
  })
  it('turn_end ends it, whatever hooks run afterwards', () => {
    const recs = [cp('user.message', T0), cp('assistant.turn_start'), cp('assistant.message'), cp('assistant.turn_end', T2), cp('hook.start', T2), cp('hook.end', T2)]
    expect(judgeCopilotTail(recs)).toEqual(IDLE)
  })
  it('shutdown ends it', () => {
    expect(judgeCopilotTail([cp('user.message'), cp('assistant.turn_start'), cp('session.shutdown', T2)])).toEqual(IDLE)
  })
  it('compaction sits inside a turn', () => {
    const recs = [cp('user.message', T0), cp('assistant.turn_start'), cp('session.compaction_start'), cp('session.compaction_complete', T2)]
    expect(judgeCopilotTail(recs)).toEqual({ live: true, startedAt: ms(T0) })
  })
  it('a resumed session waiting for input is idle', () => {
    expect(judgeCopilotTail([cp('session.resume', T2)])).toEqual(IDLE)
  })
  it('a tail of nothing but hooks and tool traffic is silent, not idle', () => {
    expect(judgeCopilotTail([])).toBeNull()
    expect(judgeCopilotTail([null, { type: 42 }, cp('hook.end'), cp('tool.execution_complete')])).toBeNull()
  })
})

describe('judgeTail', () => {
  it('routes by provider', () => {
    expect(judgeTail('claude', [prompt()])?.live).toBe(true)
    expect(judgeTail('codex', [started])?.live).toBe(true)
    expect(judgeTail('copilot', [cp('user.message')])?.live).toBe(true)
  })
})

/* ---------- the busy set ---------- */

describe('mergeBusy', () => {
  it('keeps both sides, spawned first and winning on a shared id', () => {
    const merged = mergeBusy(
      [{ id: 'claude:a', startedAt: 100, source: 'spawned' }],
      [
        { id: 'claude:a', startedAt: 150, source: 'observed' },
        { id: 'codex:b', startedAt: 200, source: 'observed' }
      ]
    )
    expect(merged).toEqual([
      { id: 'claude:a', startedAt: 100, source: 'spawned' },
      { id: 'codex:b', startedAt: 200, source: 'observed' }
    ])
  })
  it('handles either side empty', () => {
    expect(mergeBusy([], [])).toEqual([])
    const only = [{ id: 'copilot:c', startedAt: 1, source: 'observed' as const }]
    expect(mergeBusy([], only)).toEqual(only)
    expect(mergeBusy(only, [])).toEqual(only)
  })
})

/* ---------- waiting on the person, and the closing words ---------- */

describe('asks: a live turn blocked on the person', () => {
  const ask = (name: string, input: object, ts = T1): unknown => ({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
    timestamp: ts
  })
  const questions = { questions: [{ question: 'Which owner should the repo live under?\nSecond line', header: 'Owner', options: [] }] }

  it('claude: AskUserQuestion is a question, with its first line', () => {
    expect(judgeClaudeTail([prompt(), ask('AskUserQuestion', questions)])).toEqual({
      live: true,
      startedAt: ms(T0),
      asks: { kind: 'question', detail: 'Which owner should the repo live under?' }
    })
  })
  it('claude: ExitPlanMode waits for the plan to be approved', () => {
    expect(judgeClaudeTail([prompt(), ask('ExitPlanMode', { plan: '# Plan' })])?.asks).toEqual({
      kind: 'permission',
      detail: 'Approve the plan'
    })
  })
  it('claude: the answer clears it — the tool result is the newest record', () => {
    const answered = { ...(toolResult(T2) as object), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'The user answered: …' }] } }
    expect(judgeClaudeTail([prompt(), ask('AskUserQuestion', questions), answered])).toEqual({ live: true, startedAt: ms(T0) })
  })
  it('claude: an ordinary tool_use is not a question, even when it takes a while', () => {
    expect(judgeClaudeTail([prompt(), toolUse()])?.asks).toBeUndefined()
  })
  it('claude: a question with no readable text still asks', () => {
    expect(judgeClaudeTail([prompt(), ask('AskUserQuestion', { questions: 'nope' })])?.asks).toEqual({ kind: 'question', detail: '' })
  })

  it('codex: request_user_input with no output yet is a question; the async variant is not', () => {
    const args = JSON.stringify({ questions: [{ title: 'What would you mainly use it for?', options: ['a', 'b'] }] })
    const call = item({ type: 'function_call', name: 'request_user_input', call_id: 'c1', arguments: args })
    expect(judgeCodexTail([started, call])).toEqual({
      live: true,
      startedAt: 1789556848000,
      asks: { kind: 'question', detail: 'What would you mainly use it for?' }
    })
    const output = item({ type: 'function_call_output', call_id: 'c1', output: '{"accepted":true}' })
    expect(judgeCodexTail([started, call, output])).toEqual({ live: true, startedAt: 1789556848000 })
    const async = item({ type: 'function_call', name: 'request_user_input_async', call_id: 'c2', arguments: args })
    expect(judgeCodexTail([started, async])?.asks).toBeUndefined()
  })
  it('codex: an approval request is a permission until anything newer is written', () => {
    const exec = ev('exec_approval_request', { call_id: 'c3', command: ['bash', '-lc', 'rm -rf build'] })
    expect(judgeCodexTail([started, exec])?.asks).toEqual({ kind: 'permission', detail: 'bash -lc rm -rf build' })
    expect(judgeCodexTail([started, ev('apply_patch_approval_request', { call_id: 'c4' })])?.asks).toEqual({ kind: 'permission', detail: 'Apply a patch' })
    const ran = item({ type: 'custom_tool_call_output', call_id: 'c3', output: 'ok' })
    expect(judgeCodexTail([started, exec, ran])?.asks).toBeUndefined()
    expect(judgeCodexTail([started, exec, ev('task_complete')])).toEqual(IDLE)
  })

  it('copilot: permission.requested without its permission.completed is a permission, with the command', () => {
    const req = cp('permission.requested', T2, {
      requestId: 'r1',
      permissionRequest: { kind: 'shell', toolCallId: 't1' },
      promptRequest: JSON.stringify({ kind: 'commands', fullCommandText: 'find . -name "*.ts" | head' })
    })
    const recs = [cp('user.message', T0), cp('assistant.turn_start', T1), cp('tool.execution_start', T1), req]
    expect(judgeCopilotTail(recs)).toEqual({
      live: true,
      startedAt: ms(T0),
      asks: { kind: 'permission', detail: 'find . -name "*.ts" | head' }
    })
    const done = cp('permission.completed', T2, { requestId: 'r1', toolCallId: 't1', result: { kind: 'approved' } })
    // approved: the tool it gated is now the thing running
    expect(judgeCopilotTail([...recs, done])).toEqual({ live: true, startedAt: ms(T0), inTool: true })
  })
  it('copilot: an MCP permission names the server and tool; an unreadable one still asks', () => {
    const mcp = cp('permission.requested', T2, { requestId: 'r2', promptRequest: { kind: 'mcp', serverName: 'cachely', toolName: 'get_plan_usage' } })
    expect(judgeCopilotTail([cp('assistant.turn_start', T1), mcp])?.asks).toEqual({ kind: 'permission', detail: 'cachely: get_plan_usage' })
    expect(judgeCopilotTail([cp('assistant.turn_start', T1), cp('permission.requested', T2, 42 as never)])?.asks).toEqual({ kind: 'permission', detail: '' })
  })
  it('copilot: a completed request for another id does not answer this one', () => {
    const recs = [
      cp('assistant.turn_start', T1),
      cp('permission.requested', T1, { requestId: 'r1', promptRequest: { kind: 'commands', fullCommandText: 'ls' } }),
      cp('permission.completed', T2, { requestId: 'r0' })
    ]
    expect(judgeCopilotTail(recs)?.asks?.detail).toBe('ls')
  })
})

describe('closing: what the agent said as the turn ended', () => {
  it('claude: the answer text, capped; a tool_use before the hook summary means no answer yet', () => {
    const long = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] }, timestamp: T2 }
    expect(judgeClaudeTail([prompt(), long])?.closing?.length).toBe(600)
    const summary = { type: 'system', subtype: 'stop_hook_summary' }
    expect(judgeClaudeTail([prompt(), toolUse(), summary])).toEqual(IDLE)
  })
  it('codex: task_complete carries last_agent_message', () => {
    expect(judgeCodexTail([started, ev('task_complete', { last_agent_message: 'All green.\nDetails…' })])).toEqual({ ...IDLE, closing: 'All green.' })
    expect(judgeCodexTail([started, ev('task_complete', { last_agent_message: 7 })])).toEqual(IDLE)
  })
  it('copilot: the assistant message just before turn_end; none after a tool call', () => {
    const said = cp('assistant.message', T1, { content: 'Fixed the flake.' })
    expect(judgeCopilotTail([cp('user.message', T0), cp('assistant.turn_start'), said, cp('assistant.turn_end', T2)])).toEqual({ ...IDLE, closing: 'Fixed the flake.' })
    expect(judgeCopilotTail([cp('user.message', T0), cp('assistant.turn_start'), said, cp('tool.execution_start'), cp('assistant.turn_end', T2)])).toEqual(IDLE)
  })
})

describe('inTool: the newest record is a tool call waiting for its result', () => {
  it('claude: the tool_use line, not the text line before it, and not a question', () => {
    expect(judgeClaudeTail([prompt(), answer(T1, 'tool_use')])?.inTool).toBeUndefined()
    expect(judgeClaudeTail([prompt(), toolUse()])?.inTool).toBe(true)
    expect(judgeClaudeTail([prompt(), toolUse(), toolResult()])?.inTool).toBeUndefined()
  })
  it('codex: a call item is inside a tool, its output is not, and markers bound the turn', () => {
    expect(judgeCodexTail([started, item({ type: 'custom_tool_call', name: 'exec' })])?.inTool).toBe(true)
    expect(judgeCodexTail([started, item({ type: 'custom_tool_call', name: 'exec' }), item({ type: 'custom_tool_call_output', output: 'ok' })])?.inTool).toBeUndefined()
    expect(judgeCodexTail([item({ type: 'function_call', name: 'shell' }), started])?.inTool).toBeUndefined()
    expect(judgeCodexTail([item({ type: 'function_call', name: 'shell' })])).toEqual({ live: true, startedAt: null, inTool: true })
  })
  it('copilot: an execution_start with no completion for its id; a completed one is not', () => {
    const start = (id: string, ts = T2): unknown => cp('tool.execution_start', ts, { toolCallId: id })
    const done = (id: string, ts = T2): unknown => cp('tool.execution_complete', ts, { toolCallId: id })
    expect(judgeCopilotTail([cp('assistant.turn_start', T1), start('a')])?.inTool).toBe(true)
    expect(judgeCopilotTail([cp('assistant.turn_start', T1), start('a'), done('a')])?.inTool).toBeUndefined()
    expect(judgeCopilotTail([cp('assistant.turn_start', T1), start('a'), start('b'), done('b')])?.inTool).toBe(true)
  })
})

describe("copilotLockPids: who copilot says is holding the session", () => {
  it('reads the pid out of every inuse lock, in the order the directory gave them', () => {
    expect(copilotLockPids(['events.jsonl', 'inuse.23856.lock', 'workspace.yaml', 'inuse.9839.lock'])).toEqual([
      23856, 9839
    ])
  })
  it("ignores copilot's other lock, and anything that is not a pid", () => {
    const names = [
      '.workspace-fork.lock',
      'inuse.lock',
      'inuse..lock',
      'inuse.abc.lock',
      'inuse.-1.lock',
      'inuse.12.lock.bak',
      'xinuse.12.lock',
      'session.db'
    ]
    expect(copilotLockPids(names)).toEqual([])
    expect(copilotLockPids([])).toEqual([])
  })
})
