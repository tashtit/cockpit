import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  buildCommand,
  ChatManager,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  promptWithImages,
  withTurnFlags
} from '../src/main/chat'
import { BUILTIN_ACP_AGENTS } from '../src/shared/acp'
import type { AcpAgent, BusySession, ChatEvent, ChatRequest } from '../src/shared/types'

describe('buildCommand', () => {
  it('claude new chat, auto-edit', () => {
    const { cmd, args } = buildCommand({
      provider: 'claude',
      cwd: '/x',
      prompt: 'hi',
      permissionMode: 'auto-edit'
    })
    expect(cmd).toBe('claude')
    expect(args).toContain('--permission-mode')
    expect(args).toContain('stream-json')
    expect(args[args.length - 1]).toBe('hi')
  })
  it('claude resume', () => {
    const { args } = buildCommand({
      provider: 'claude',
      cwd: '/x',
      prompt: 'more',
      resumeNativeId: 'abc',
      permissionMode: 'safe'
    })
    expect(args).toContain('--resume')
    expect(args).toContain('abc')
  })
  it('codex resume inserts subcommand and passes sandbox as a config override', () => {
    // `codex exec resume` accepts neither --full-auto nor --sandbox — only -c
    const { cmd, args } = buildCommand({
      provider: 'codex',
      cwd: '/x',
      prompt: 'go',
      resumeNativeId: 'sid',
      permissionMode: 'auto-edit'
    })
    expect(cmd).toBe('codex')
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'sid'])
    expect(args).not.toContain('--full-auto')
    expect(args).not.toContain('--sandbox')
    expect(args[args.indexOf('-c') + 1]).toBe('sandbox_mode="workspace-write"')
    expect(args[args.length - 1]).toBe('go')
  })
  it('codex auto-edit maps to workspace-write (--full-auto no longer exists)', () => {
    const { args } = buildCommand({
      provider: 'codex',
      cwd: '/x',
      prompt: 'go',
      permissionMode: 'auto-edit'
    })
    expect(args).not.toContain('--full-auto')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write')
  })
  it('codex skip-git-repo-check rides both exec forms, only when asked', () => {
    for (const resumeNativeId of [undefined, 'sid']) {
      const { args } = buildCommand({
        provider: 'codex',
        cwd: '/scratch/room',
        prompt: 'talk',
        resumeNativeId,
        permissionMode: 'safe',
        options: { codexSkipGitCheck: true }
      })
      expect(args).toContain('--skip-git-repo-check')
      expect(args[args.length - 1]).toBe('talk')
    }
    const { args } = buildCommand({ provider: 'codex', cwd: '/x', prompt: 'p', permissionMode: 'safe' })
    expect(args).not.toContain('--skip-git-repo-check')
  })
  it('copilot yolo', () => {
    const { args } = buildCommand({
      provider: 'copilot',
      cwd: '/x',
      prompt: 'p',
      permissionMode: 'yolo'
    })
    expect(args).toContain('--allow-all-tools')
  })
  it('attached images become prompt file references for every provider', () => {
    for (const provider of ['claude', 'codex', 'copilot'] as const) {
      const { args } = buildCommand({
        provider,
        cwd: '/x',
        prompt: 'what is this?',
        permissionMode: 'safe',
        images: ['/data/chat-images/a.png', '/data/chat-images/b.jpg']
      })
      const prompt = provider === 'copilot' ? args[args.indexOf('-p') + 1] : args[args.length - 1]
      expect(prompt).toContain('what is this?')
      expect(prompt).toContain('/data/chat-images/a.png')
      expect(prompt).toContain('/data/chat-images/b.jpg')
    }
  })
  it('codex resume keeps image references in the prompt (no --image flag exists there)', () => {
    const { args } = buildCommand({
      provider: 'codex',
      cwd: '/x',
      prompt: 'look',
      resumeNativeId: 'sid',
      permissionMode: 'safe',
      images: ['/data/chat-images/a.png']
    })
    expect(args).not.toContain('--image')
    expect(args[args.length - 1]).toContain('/data/chat-images/a.png')
  })
})

describe('promptWithImages', () => {
  it('returns the prompt untouched without images', () => {
    expect(promptWithImages({ provider: 'claude', cwd: '/x', prompt: 'hi', permissionMode: 'safe' })).toBe('hi')
  })
  it('an image-only turn still yields a non-empty prompt', () => {
    const p = promptWithImages({
      provider: 'claude',
      cwd: '/x',
      prompt: '',
      permissionMode: 'safe',
      images: ['/data/chat-images/a.png']
    })
    expect(p).toContain('/data/chat-images/a.png')
    expect(p.trim().length).toBeGreaterThan(0)
  })
})

describe('parseClaudeStreamLine', () => {
  it('captures session id from init', () => {
    const ev = parseClaudeStreamLine('t', { type: 'system', subtype: 'init', session_id: 's1' })
    expect(ev).toEqual([{ turnId: 't', type: 'session', nativeSessionId: 's1' }])
  })
  it('extracts text and tool_use from assistant', () => {
    const ev = parseClaudeStreamLine('t', {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
        ]
      }
    })
    expect(ev[0]).toMatchObject({ type: 'text', text: 'hello' })
    expect(ev[1]).toMatchObject({ type: 'tool', toolName: 'Bash' })
  })
  it('tool events carry a humanized preview alongside the raw input', () => {
    const [bash] = parseClaudeStreamLine('t', {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }
        ]
      }
    })
    expect(bash).toMatchObject({ type: 'tool', preview: 'npm test' })
    if (bash.type === 'tool') expect(bash.detail).toContain('"command"')
    const [edit] = parseClaudeStreamLine('t', {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x' } }]
      }
    })
    expect(edit).toMatchObject({ type: 'tool', preview: 'src/a.ts' })
    // unknown tools keep the JSON detail with no preview
    const [mcp] = parseClaudeStreamLine('t', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__x__y', input: { a: 1 } }] }
    })
    expect(mcp.type === 'tool' && mcp.preview).toBeFalsy()
  })
  it('carries a plan or an edit whole, where the detail is cut to 200 characters', () => {
    const plan = '# Plan\n\n' + 'step. '.repeat(100)
    const [ev] = parseClaudeStreamLine('t', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan } }] }
    })
    expect(ev).toMatchObject({ type: 'tool', artifact: { kind: 'plan', text: plan.trim() } })
    if (ev.type === 'tool') expect(ev.asks?.length).toBe(1)
    const [edit] = parseClaudeStreamLine('t', {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' } }] }
    })
    expect(edit).toMatchObject({ type: 'tool', artifact: { kind: 'edits', files: [{ path: '/r/a.ts' }] } })
  })
  it('result emits done with cost', () => {
    const ev = parseClaudeStreamLine('t', { type: 'result', session_id: 's1', total_cost_usd: 0.12 })
    expect(ev.find((e) => e.type === 'done')).toMatchObject({ costUsd: 0.12 })
  })
  it('an error result surfaces an error event before done, not a silent success', () => {
    const ev = parseClaudeStreamLine('t', {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API key invalid'
    })
    expect(ev.map((e) => e.type)).toEqual(['error', 'done'])
    expect(ev[0]).toMatchObject({ message: expect.stringContaining('API key invalid') })
  })
  it('an error result without text falls back to the subtype', () => {
    const ev = parseClaudeStreamLine('t', { type: 'result', subtype: 'error_max_turns', is_error: true })
    expect(ev[0]).toMatchObject({ type: 'error', message: expect.stringContaining('error_max_turns') })
  })
})

describe('parseCodexStreamLine', () => {
  it('new shape: thread + item + turn', () => {
    expect(parseCodexStreamLine('t', { type: 'thread.started', thread_id: 'th1' })[0]).toMatchObject(
      { type: 'session', nativeSessionId: 'th1' }
    )
    expect(
      parseCodexStreamLine('t', { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })[0]
    ).toMatchObject({ type: 'text', text: 'ok' })
    expect(parseCodexStreamLine('t', { type: 'turn.completed' })[0]).toMatchObject({ type: 'done' })
  })
  it('old shape: msg events', () => {
    expect(
      parseCodexStreamLine('t', { msg: { type: 'session_configured', session_id: 's9' } })[0]
    ).toMatchObject({ type: 'session', nativeSessionId: 's9' })
    expect(
      parseCodexStreamLine('t', { msg: { type: 'agent_message', message: 'done it' } })[0]
    ).toMatchObject({ type: 'text', text: 'done it' })
    expect(parseCodexStreamLine('t', { msg: { type: 'task_complete' } })[0]).toMatchObject({
      type: 'done'
    })
  })
  it('ignores unknown lines', () => {
    expect(parseCodexStreamLine('t', { type: 'whatever' })).toEqual([])
  })
  it('headlines tool rows with what ran, keeping the raw detail', () => {
    const [shell] = parseCodexStreamLine('t', {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'bash -lc "rg premium_request src"' }
    })
    expect(shell).toMatchObject({ type: 'tool', preview: 'rg premium_request src', detail: 'bash -lc "rg premium_request src"' })
    const [edit] = parseCodexStreamLine('t', {
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] }
    })
    // named as the rollout's FileChange row is, so a rejoined turn matches the two
    expect(edit).toMatchObject({ type: 'tool', toolName: 'apply_patch', preview: 'apply_patch src/a.ts, src/b.ts' })
    const [old] = parseCodexStreamLine('t', { msg: { type: 'exec_command_begin', command: ['bash', '-lc', 'npm test'] } })
    expect(old).toMatchObject({ type: 'tool', preview: 'npm test' })
  })
  it('carries what the Work panel shows: a file change names its files, a todo list is the plan', () => {
    const [edit] = parseCodexStreamLine('t', {
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }] }
    })
    expect(edit).toMatchObject({
      type: 'tool',
      artifact: { kind: 'edits', files: [{ path: 'src/a.ts', change: 'edit', hunks: [] }] }
    })
    const [plan] = parseCodexStreamLine('t', {
      type: 'item.completed',
      item: { type: 'todo_list', items: [{ text: 'Read', completed: true }, { text: 'Write', completed: false }] }
    })
    expect(plan).toMatchObject({
      type: 'tool',
      toolName: 'update_plan',
      preview: '2 steps',
      artifact: { kind: 'todos', items: [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'pending' }] }
    })
  })
})

describe('thinking level, speed and context', () => {
  const req = (provider: ChatRequest['provider'], options: ChatRequest['options']): ChatRequest => ({
    provider,
    cwd: '/x',
    prompt: 'hi',
    permissionMode: 'safe',
    options
  })

  it('claude takes --effort', () => {
    const { args } = buildCommand(req('claude', { model: 'opus', effort: 'xhigh' }))
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'xhigh'])
  })

  it('codex takes both as config overrides — on exec and on exec resume', () => {
    for (const resumeNativeId of [undefined, 'abc']) {
      const { args } = buildCommand({ ...req('codex', { effort: 'ultra', fast: true }), resumeNativeId })
      expect(args).toContain('model_reasoning_effort="ultra"')
      expect(args).toContain('service_tier="priority"')
    }
  })

  it('copilot takes --reasoning-effort and --context', () => {
    const { args } = buildCommand(req('copilot', { model: 'gpt-5.6-sol', effort: 'minimal', longContext: true }))
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5.6-sol', '--reasoning-effort', 'minimal', '--context', 'long_context']))
  })

  it('a level the CLI does not take never reaches its argv', () => {
    // "ultra" is codex's word; claude has none such, and nothing flag-shaped passes
    expect(buildCommand(req('claude', { effort: 'ultra' })).args).not.toContain('--effort')
    expect(buildCommand(req('copilot', { effort: '--yolo' })).args).not.toContain('--reasoning-effort')
    expect(buildCommand(req('codex', { effort: 'x"; rm' })).args.join(' ')).not.toContain('reasoning')
  })

  it('the built-in copilot ACP agent carries the turn’s flags; a user-defined one never does', () => {
    const builtin = BUILTIN_ACP_AGENTS.find((a) => a.provider === 'copilot')!
    const r = req('copilot', { model: 'gpt-5.6-sol', effort: 'high' })
    expect(withTurnFlags(builtin, r)?.args).toEqual([
      '--acp',
      '--model',
      'gpt-5.6-sol',
      '--reasoning-effort',
      'high'
    ])
    // the shared definition itself is untouched
    expect(builtin.args).toEqual(['--acp'])
    const custom = { id: 'mine', label: 'Mine', command: 'my-agent', args: ['--stdio'], provider: 'copilot' as const }
    expect(withTurnFlags(custom, r)).toBe(custom)
    expect(withTurnFlags(undefined, r)).toBeUndefined()
  })
})

describe('ChatManager — a turn that cannot start', () => {
  /** Every event a turn emits, collected until its done. */
  async function run(
    hooks: ConstructorParameters<typeof ChatManager>[1],
    req: Partial<ChatRequest> = {}
  ): Promise<{ events: ChatEvent[]; started: string[] }> {
    const events: ChatEvent[] = []
    const started: string[] = []
    let finish: () => void = () => {}
    const finished = new Promise<void>((r) => (finish = r))
    const chat = new ChatManager(
      (ev) => {
        events.push(ev)
        if (ev.type === 'done') finish()
      },
      { ...hooks, onTurnStart: (turnId) => started.push(turnId) }
    )
    const turnId = chat.send({ provider: 'claude', cwd: tmpdir(), prompt: 'hi', permissionMode: 'safe', ...req })
    await finished
    expect(events.every((e) => e.turnId === turnId)).toBe(true)
    expect(chat.busySessions()).toEqual([])
    return { events, started }
  }

  // Thrown out of send(), the turn the attention desk had just been told about never
  // ended, and every observed ending of that session was muted until a restart
  it('ends as error then done when the ACP agent it was bound to is gone', async () => {
    const { events, started } = await run({
      resolveAcpAgent: () => {
        throw new Error('that agent was removed')
      }
    })
    expect(started).toHaveLength(1)
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    expect(events[0]).toMatchObject({ message: 'that agent was removed' })
  })

  it('ends as error then done when spawn itself throws', async () => {
    // a NUL byte is refused by spawn synchronously, as E2BIG is for a prompt past the
    // OS argument limit
    const { events } = await run({}, { prompt: 'a\u0000b' })
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
  })
})

describe('ChatManager: one turn per session', () => {
  // the stub ACP agent asks permission mid-turn and waits for the answer — a real turn,
  // held open for as long as the test needs it (tests/fixtures/stub-acp-agent.mjs)
  const stub: AcpAgent = {
    id: 'stub',
    label: 'Stub',
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/stub-acp-agent.mjs', import.meta.url))],
    provider: 'copilot',
    env: { STUB_MODE: 'permission' }
  }
  const cwd = mkdtempSync(join(tmpdir(), 'cockpit-chat-'))
  const resume = (id: string): ChatRequest => ({
    provider: 'copilot',
    cwd,
    prompt: 'hello',
    resumeNativeId: id,
    permissionMode: 'safe'
  })

  type Ask = Extract<ChatEvent, { type: 'permission' }>

  /** Start a turn resuming `id` and wait until it is blocked on its permission question. */
  async function midTurn(id: string): Promise<{
    readonly chat: ChatManager
    readonly turnId: string
    readonly ask: Ask
    /** What main answered at the moment the turn said done, and when it did */
    readonly atDone: Promise<{ readonly busy: BusySession[]; readonly running: string | null }>
  }> {
    let onAsk!: (ev: Ask) => void
    const asked = new Promise<Ask>((r) => (onAsk = r))
    let onDone!: (v: { busy: BusySession[]; running: string | null }) => void
    const atDone = new Promise<{ busy: BusySession[]; running: string | null }>((r) => (onDone = r))
    const chat: ChatManager = new ChatManager(
      (ev) => {
        if (ev.type === 'permission') onAsk(ev)
        if (ev.type === 'done') onDone({ busy: chat.busySessions(), running: chat.turnFor('copilot', id) })
      },
      { resolveAcpAgent: () => stub }
    )
    const turnId = chat.send(resume(id))
    return { chat, turnId, ask: await asked, atDone }
  }

  it('refuses to resume a session it is already running, and names the turn to rejoin', async () => {
    const { chat, turnId, ask, atDone } = await midTurn('sess-7')
    expect(chat.busySessions()).toEqual([
      { id: 'copilot:sess-7', startedAt: expect.any(Number), source: 'spawned', turnId }
    ])
    expect(chat.turnFor('copilot', 'sess-7')).toBe(turnId)
    // chat:send asks before touching anything; send() refuses on its own for every other caller
    expect(() => chat.assertNotRunning(resume('sess-7'))).toThrow(/already has a turn running/)
    expect(() => chat.send(resume('sess-7'))).toThrow(/already has a turn running/)
    expect(chat.busySessions()).toHaveLength(1)
    // only that conversation is held: another session, the same id under another agent
    // and a brand-new session all start as before
    expect(() => chat.assertNotRunning(resume('sess-8'))).not.toThrow()
    expect(() => chat.assertNotRunning({ ...resume('sess-7'), provider: 'claude' })).not.toThrow()
    expect(() => chat.assertNotRunning({ ...resume('sess-7'), resumeNativeId: undefined })).not.toThrow()

    chat.respondPermission(turnId, ask.requestId, 'allow_once')
    // once the turn says done there is nothing to rejoin and nothing for a follow-up to
    // wait on, though its process may take a moment more to exit
    expect(await atDone).toEqual({
      busy: [{ id: 'copilot:sess-7', startedAt: expect.any(Number), source: 'spawned', turnId: null }],
      running: null
    })
    expect(() => chat.assertNotRunning(resume('sess-7'))).not.toThrow()
    await vi.waitFor(() => expect(chat.busySessions()).toEqual([]))
  })

  it('frees the session the moment its turn is stopped', async () => {
    const { chat, turnId } = await midTurn('sess-9')
    chat.cancel(turnId)
    expect(chat.turnFor('copilot', 'sess-9')).toBeNull()
    expect(chat.busySessions()).toEqual([])
    expect(() => chat.assertNotRunning(resume('sess-9'))).not.toThrow()
  })
})
