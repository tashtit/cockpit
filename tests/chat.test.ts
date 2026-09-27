import { describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  buildCommand,
  ChatManager,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  promptWithImages,
  withTurnFlags,
  CLAUDE_SIDE_TOOLS,
  CODEX_REVIEWED_ARGS,
  CODEX_SIDE_ARGS
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
  it('claude with someone to ask: the CLI puts its permission prompts to Cockpit, and the prompt goes on stdin', () => {
    const req: ChatRequest = { provider: 'claude', cwd: '/x', prompt: '- fix this', permissionMode: 'auto-edit', resumeNativeId: 'abc' }
    const { args, stdin } = buildCommand(req, { askHost: true })
    expect(args.join(' ')).toContain('--input-format stream-json --permission-prompt-tool stdio')
    expect(args).toContain('acceptEdits')
    expect(args[args.indexOf('--resume') + 1]).toBe('abc')
    // nothing of the prompt on the command line, so no `--` to keep it from being read as a flag
    expect(args).not.toContain('--')
    expect(args.join(' ')).not.toContain('fix this')
    expect(JSON.parse(stdin ?? '')).toMatchObject({ type: 'user', message: { role: 'user', content: '- fix this' } })
    // without it — a roundtable seat — the CLI refuses on its own, as it always has
    const seat = buildCommand(req)
    expect(seat.stdin).toBeUndefined()
    expect(seat.args).not.toContain('--permission-prompt-tool')
    expect(seat.args.slice(-2)).toEqual(['--', '- fix this'])
    // the option is Claude's alone
    expect(buildCommand({ ...req, provider: 'codex' }, { askHost: true }).stdin).toBeUndefined()
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
  it('a roundtable seat in safe mode may search and fetch pages — nothing that runs or edits', () => {
    const seat = (permissionMode: ChatRequest['permissionMode'], research = true): string[] =>
      buildCommand({ provider: 'claude', cwd: '/x', prompt: 'hi', permissionMode, ...(research ? { research } : {}) }).args
    const safe = seat('safe')
    expect(safe[safe.indexOf('--allowedTools') + 1]).toBe('WebSearch,WebFetch')
    expect(safe.join(' ')).not.toMatch(/Bash|Edit|Write/)
    // only a seat, and only in safe mode: the other modes already say what they allow
    expect(seat('safe', false)).not.toContain('--allowedTools')
    expect(seat('auto-edit')).not.toContain('--allowedTools')
    expect(seat('yolo')).not.toContain('--allowedTools')
    // the flag is Claude's alone
    const codex = buildCommand({ provider: 'codex', cwd: '/x', prompt: 'hi', permissionMode: 'safe', research: true }).args
    expect(codex).not.toContain('--allowedTools')
    // and the prompt still comes last, after --
    expect(safe.slice(-2)).toEqual(['--', 'hi'])
  })
  it('a read-only Codex seat reaches the network through a permission profile, its files still read-only', () => {
    const seat = (over: Partial<ChatRequest> = {}): string[] =>
      buildCommand({
        provider: 'codex',
        cwd: '/x',
        prompt: 'hi',
        permissionMode: 'safe',
        research: true,
        options: { codexSandbox: 'read-only' },
        ...over
      }).args
    const overrides = (args: string[]): string[] => args.filter((_, i) => args[i - 1] === '-c')
    const fresh = seat()
    // the --sandbox flag would beat the profile; -c sandbox_mode is the floor it beats
    expect(fresh).not.toContain('--sandbox')
    expect(overrides(fresh)).toEqual([
      'sandbox_mode="read-only"',
      'permissions.cockpit-roundtable-seat={ extends = ":read-only", filesystem = { ":root" = "read" }, network = { enabled = true } }',
      'default_permissions="cockpit-roundtable-seat"'
    ])
    expect(fresh.join(' ')).not.toMatch(/write|danger/)
    expect(fresh.slice(-2)).toEqual(['--', 'hi'])
    // a resumed turn keeps it
    const resumed = seat({ resumeNativeId: 'sid' })
    expect(resumed.slice(0, 3)).toEqual(['exec', 'resume', 'sid'])
    expect(overrides(resumed)).toEqual(overrides(fresh))
    // only a seat, only read-only, only safe: every other turn keeps its sandbox as it was
    const plain = (over: Partial<ChatRequest>): string[] => overrides(seat(over))
    expect(plain({ research: undefined })).toEqual([])
    expect(seat({ research: undefined })).toContain('--sandbox')
    expect(plain({ options: { codexSandbox: 'workspace-write' } })).toEqual([])
    expect(plain({ options: {} })).toEqual([])
    expect(plain({ permissionMode: 'yolo' })).toEqual([])
    expect(seat({ permissionMode: 'yolo' })).toContain('--dangerously-bypass-approvals-and-sandbox')
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
  it('codex auto-edit hands what its sandbox refuses to Codex’s reviewer, on exec and exec resume', () => {
    const codex = (over: Partial<ChatRequest> = {}): string[] =>
      buildCommand({ provider: 'codex', cwd: '/x', prompt: 'commit it', permissionMode: 'auto-edit', ...over }).args
    const reviewed = (args: string[]): boolean =>
      args.join(' ').includes(CODEX_REVIEWED_ARGS.join(' '))
    // git writes and the network escalate out of the workspace sandbox; headless, the
    // reviewer is the one who can say yes
    expect(reviewed(codex())).toBe(true)
    expect(reviewed(codex({ resumeNativeId: 'sid' }))).toBe(true)
    expect(CODEX_REVIEWED_ARGS).toEqual(['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'])
    // the prompt still comes last
    expect(codex().slice(-2)).toEqual(['--', 'commit it'])
    // nothing is reviewed out of a sandbox the person chose to keep read-only, out of a
    // safe turn, a roundtable seat, or a side question's copy — and yolo asks nobody
    expect(reviewed(codex({ options: { codexSandbox: 'read-only' } }))).toBe(false)
    expect(reviewed(codex({ permissionMode: 'safe' }))).toBe(false)
    expect(reviewed(codex({ permissionMode: 'safe', options: { codexSandbox: 'read-only' }, research: true }))).toBe(false)
    expect(reviewed(codex({ resumeNativeId: 'sid', sideFork: true }))).toBe(false)
    expect(reviewed(codex({ permissionMode: 'yolo' }))).toBe(false)
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
    expect(args).not.toContain('--deny-tool')
  })
  it('copilot auto-edit edits files but never runs a shell it cannot ask about', () => {
    const { args } = buildCommand({ provider: 'copilot', cwd: '/x', prompt: 'p', permissionMode: 'auto-edit' })
    expect(args).toContain('--allow-all-tools')
    expect(args[args.indexOf('--deny-tool') + 1]).toBe('shell')
  })
  it('keeps a prompt that starts with "-" a prompt, not an option', () => {
    // a pasted markdown list: claude refused it as `unknown option '- fix this'`,
    // codex as an unexpected argument, copilot as an invalid command format
    const prompt = '- fix this\n- and that'
    for (const provider of ['claude', 'codex'] as const) {
      const { args } = buildCommand({ provider, cwd: '/x', prompt, permissionMode: 'safe' })
      expect(args.slice(-2), provider).toEqual(['--', prompt])
    }
    const { args } = buildCommand({ provider: 'copilot', cwd: '/x', prompt, permissionMode: 'safe' })
    expect(args[0]).toBe(`--prompt=${prompt}`)
    expect(args).not.toContain('-p')
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
      const prompt =
        provider === 'copilot' ? (args.find((a) => a.startsWith('--prompt=')) ?? '') : args[args.length - 1]
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

describe('side chat: a copy of the session, never the session', () => {
  const side = (over: Partial<ChatRequest>): string[] =>
    buildCommand({
      provider: 'claude',
      cwd: '/x',
      prompt: 'why?',
      resumeNativeId: 'sid',
      permissionMode: 'safe',
      sideFork: true,
      ...over
    }).args

  it('claude forks the session and saves nothing: read-only tools, no MCP servers', () => {
    const args = side({})
    expect(args[args.indexOf('--resume') + 1]).toBe('sid')
    expect(args).toContain('--fork-session')
    expect(args).toContain('--no-session-persistence')
    // --tools is the set itself, not a pre-approval the person's own rules could widen
    expect(args[args.indexOf('--tools') + 1]).toBe(CLAUDE_SIDE_TOOLS.join(','))
    expect(CLAUDE_SIDE_TOOLS).toEqual(['Read', 'Grep', 'Glob'])
    expect(args).toContain('--strict-mcp-config')
    expect(args.join(' ')).not.toMatch(/permission-mode|dangerously|allowedTools/)
    expect(args.slice(-2)).toEqual(['--', 'why?'])
    // a plain resume is the session itself, and is kept
    const plain = side({ sideFork: undefined })
    expect(plain).not.toContain('--fork-session')
    expect(plain).not.toContain('--no-session-persistence')
    expect(plain).not.toContain('--tools')
  })

  it('codex forks ephemerally — never `exec resume`, which appends the turn to the rollout', () => {
    const args = side({ provider: 'codex', options: { model: 'gpt-5', effort: 'low' } })
    expect(args.slice(0, 5)).toEqual(['exec', 'fork', 'sid', '--json', '--ephemeral'])
    expect(args).not.toContain('resume')
    // read-only, nothing escalating out of it, and never kept from a folder for not being a repo
    expect(args.slice(-2 - CODEX_SIDE_ARGS.length, -2)).toEqual([...CODEX_SIDE_ARGS])
    expect(CODEX_SIDE_ARGS).toContain('sandbox_mode="read-only"')
    expect(CODEX_SIDE_ARGS).toContain('approval_policy="never"')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).not.toContain('--sandbox')
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5')
    expect(args).toContain('model_reasoning_effort="low"')
    expect(args.slice(-2)).toEqual(['--', 'why?'])
  })

  it('without a session to copy there is nothing to fork', () => {
    const claude = side({ resumeNativeId: undefined })
    expect(claude).not.toContain('--fork-session')
    const codex = side({ provider: 'codex', resumeNativeId: undefined })
    expect(codex).not.toContain('fork')
    expect(codex).not.toContain('--ephemeral')
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
  it('a queued task notice drained before the prompt is not the turn ending', () => {
    // a resumed session with a background task's notice pending: claude runs it first, as a
    // zero-turn run that ends in a result of its own, then reads the prompt
    const notice = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', session_id: 's', origin: { kind: 'task-notification' } }
    expect(parseClaudeStreamLine('t', notice).map((e) => e.type)).toEqual(['session'])
    const own = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok', session_id: 's' }
    expect(parseClaudeStreamLine('t', own).map((e) => e.type)).toEqual(['session', 'done'])
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
  it('carries a check that streamed in finished, with how it ended', () => {
    const [run] = parseCodexStreamLine('t', {
      type: 'item.completed',
      item: { type: 'command_execution', command: "bash -lc 'npm test'", aggregated_output: ' Tests  2 failed | 8 passed', exit_code: 1, status: 'failed' }
    })
    expect(run).toMatchObject({ type: 'tool', preview: 'npm test', artifact: { kind: 'check', checks: ['tests'], status: 'failed', exitCode: 1 } })
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

describe('ChatManager: reading a CLI stream', () => {
  // a stub `claude` first on PATH: it prints what real CLIs have been caught printing
  const bin = mkdtempSync(join(tmpdir(), 'cockpit-chat-stream-'))
  const deep = '{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000)
  writeFileSync(
    join(bin, 'stub.mjs'),
    [
      `const w = (s) => process.stdout.write(s)`,
      // a banner far past a message's size, then an event nested past what can be serialised
      `w('x'.repeat(30000) + '\\n')`,
      `w(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stub-1' }) + '\\n')`,
      `w(${JSON.stringify(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Weird","input":${deep}}]}}\n`)})`,
      `w(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still here' }] } }) + '\\n')`,
      // the result, without the newline a last line often lacks
      `w(JSON.stringify({ type: 'result', session_id: 'stub-1' }))`
    ].join('\n')
  )
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'stub.mjs')}"\n`)
  chmodSync(join(bin, 'claude'), 0o755)

  it('caps a non-JSON line, shows an event nested too deeply to serialise, and still ends on the final line', async () => {
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const events: ChatEvent[] = []
      let finish: () => void = () => {}
      const finished = new Promise<void>((r) => (finish = r))
      const chat = new ChatManager((ev) => {
        events.push(ev)
        if (ev.type === 'done') finish()
      })
      chat.send({ provider: 'claude', cwd: tmpdir(), prompt: 'hi', permissionMode: 'safe' })
      await finished
      expect(events.map((e) => e.type)).toEqual(['text', 'session', 'tool', 'text', 'session', 'done'])
      const banner = events[0] as Extract<ChatEvent, { type: 'text' }>
      expect(banner.text.length).toBeLessThan(20_100)
      expect(banner.text).toContain('more chars')
      // the row the transcript shows for it too, rather than no row at all
      expect(events[2]).toMatchObject({ type: 'tool', toolName: 'Weird', detail: '(nested too deeply to show)' })
      expect(events[3]).toMatchObject({ type: 'text', text: 'still here' })
      await vi.waitFor(() => expect(chat.busySessions()).toEqual([]))
    } finally {
      process.env.PATH = path
    }
  })
})

describe('ChatManager: the last line of a stream', () => {
  // a stub `claude` whose result announces a new id (claude forks one per resumed turn),
  // ended by a newline or — when the prompt says `bare` — by the exit alone
  const bin = mkdtempSync(join(tmpdir(), 'cockpit-chat-last-'))
  writeFileSync(
    join(bin, 'stub.mjs'),
    [
      `const end = process.argv.at(-1) === 'bare' ? '' : '\\n'`,
      `process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stub-1' }) + '\\n')`,
      `process.stdout.write(JSON.stringify({ type: 'result', session_id: 'stub-2' }) + end)`
    ].join('\n')
  )
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'stub.mjs')}" "$@"\n`)
  chmodSync(join(bin, 'claude'), 0o755)

  /** What one turn emitted, and the ids the busy board had it running under at each change. */
  async function run(prompt: string): Promise<{ events: unknown[]; running: string[][] }> {
    const events: ChatEvent[] = []
    const running: string[][] = []
    let finish: () => void = () => {}
    const finished = new Promise<void>((r) => (finish = r))
    const chat = new ChatManager(
      (ev) => {
        events.push(ev)
        if (ev.type === 'done') finish()
      },
      { onBusyChange: (busy) => running.push(busy.filter((b) => b.source === 'spawned' && b.turnId !== null).map((b) => b.id)) }
    )
    chat.send({ provider: 'claude', cwd: tmpdir(), prompt, permissionMode: 'safe' })
    await finished
    await vi.waitFor(() => expect(chat.runningTurns()).toBe(0))
    return { events: events.map((e) => [e.type, e.type === 'session' ? e.nativeSessionId : null]), running }
  }

  it('reads a final line without its newline the way it reads any other', async () => {
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const ended = await run('newline')
      const bare = await run('bare')
      expect(ended.events).toEqual([
        ['session', 'stub-1'],
        ['session', 'stub-2'],
        ['done', null]
      ])
      // the flush at exit once emitted the result past the turn's bookkeeping: the id it
      // announced never reached the busy board, and its done never cleared the turn there
      expect(bare).toEqual(ended)
      expect(bare.running).toContainEqual(['claude:stub-1', 'claude:stub-2'])
    } finally {
      process.env.PATH = path
    }
  })
})

describe('ChatManager: Claude asks Cockpit before what its mode does not allow', () => {
  // a stub `claude` that speaks the stdio control protocol the way claude 2.1 does: it
  // reads its prompt from stdin, puts requests to its host, and keeps reading until the
  // host closes stdin — so a turn only ends if main closes it after the result
  const bin = mkdtempSync(join(tmpdir(), 'cockpit-chat-host-'))
  writeFileSync(
    join(bin, 'stub.mjs'),
    [
      `import { createInterface } from 'node:readline'`,
      `const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')`,
      `const got = []`,
      `const ask = (request_id, request) => out({ type: 'control_request', request_id, request })`,
      `const steps = [`,
      `  () => { out({ type: 'system', subtype: 'init', session_id: 'stub-host' }); ask('q-1', { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Red or blue?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] } }) },`,
      `  () => ask('h-1', { subtype: 'hook_callback', callback_id: 'x' }),`,
      `  () => ask('p-1', { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, description: 'Run the tests' }),`,
      `  () => ask('p-2', { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push' }, description: 'Push' }),`,
      `  () => { out({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ argv: process.argv.slice(2), got }) }] } }); out({ type: 'result', session_id: 'stub-host' }) }`,
      `]`,
      `createInterface({ input: process.stdin }).on('line', (line) => { got.push(JSON.parse(line)); steps.shift()?.() }).on('close', () => process.exit(0))`
    ].join('\n')
  )
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'stub.mjs')}" "$@"\n`)
  chmodSync(join(bin, 'claude'), 0o755)

  it('shows each request on the card, sends the answer back, and ends the turn once the result is in', async () => {
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const events: ChatEvent[] = []
      let finish: () => void = () => {}
      const finished = new Promise<void>((r) => (finish = r))
      const chat: ChatManager = new ChatManager(
        (ev) => {
          events.push(ev)
          if (ev.type === 'permission') {
            // a click on an option the card never had, and on a request it is not waiting on, do nothing
            chat.respondPermission(ev.turnId, ev.requestId, 'allow_always')
            chat.respondPermission(ev.turnId, 'p-404', 'allow')
            chat.respondPermission(ev.turnId, ev.requestId, ev.requestId === 'p-1' ? 'allow' : 'deny')
          }
          if (ev.type === 'done') finish()
        },
        { asksPermissions: () => true }
      )
      chat.send({ provider: 'claude', cwd: tmpdir(), prompt: 'run the tests', permissionMode: 'auto-edit' })
      await finished

      const asks = events.filter((e): e is Extract<ChatEvent, { type: 'permission' }> => e.type === 'permission')
      // the question and the hook never reached the person: only the two commands did
      expect(asks.map((a) => [a.requestId, a.toolName, a.detail, a.preview])).toEqual([
        ['p-1', 'shell', 'npm test', 'Run the tests'],
        ['p-2', 'shell', 'git push', 'Push']
      ])
      const report = events.find((e) => e.type === 'text' && e.text.startsWith('{"argv"'))
      const { argv, got } = JSON.parse((report as Extract<ChatEvent, { type: 'text' }>).text)
      expect(argv).toEqual(expect.arrayContaining(['--permission-prompt-tool', 'stdio', '--permission-mode', 'acceptEdits']))
      expect(got[0]).toMatchObject({ type: 'user', message: { content: 'run the tests' } })
      const answers = got.slice(1).map((m: any) => [m.response.request_id, m.response.response?.behavior ?? m.response.subtype])
      expect(answers).toEqual([
        ['q-1', 'deny'],
        ['h-1', 'error'],
        ['p-1', 'allow'],
        ['p-2', 'deny']
      ])
      expect(got[3].response.response.updatedInput).toEqual({ command: 'npm test', description: 'Run the tests' })
      expect(events.filter((e) => e.type === 'error')).toEqual([])
      // stdin closed after the result, so the CLI exited and nothing is left running
      await vi.waitFor(() => expect(chat.busySessions()).toEqual([]))
      expect(chat.runningTurns()).toBe(0)
    } finally {
      process.env.PATH = path
    }
  })
})
