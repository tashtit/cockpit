import { describe, it, expect } from 'vitest'
import { buildCommand, parseClaudeStreamLine, parseCodexStreamLine, promptWithImages } from '../src/main/chat'

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
})
