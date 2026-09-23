import { afterAll, describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listClaudeSessions, parseClaudeMessages } from '../src/main/parsers/claude'
import { listCodexSessions, parseCodexMessages } from '../src/main/parsers/codex'
import { listCopilotSessions, parseCopilotMessages } from '../src/main/parsers/copilot'
import { toolPreview } from '../src/main/parsers/util'

const root = mkdtempSync(join(tmpdir(), 'cockpit-test-fixtures-'))

function jsonl(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })

  // --- Claude fixture ---
  const claudeDir = join(root, 'claude', 'projects', '-Users-titan-dev-myrepo')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(
    join(claudeDir, 'aaaa-1111.jsonl'),
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: 'fix the login bug' },
        timestamp: '2026-08-01T10:00:00Z',
        sessionId: 'aaaa-1111',
        cwd: '/Users/titan/dev/myrepo',
        gitBranch: 'main'
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking at it now.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
          ]
        },
        timestamp: '2026-08-01T10:00:05Z'
      },
      { type: 'summary', summary: 'Fix login bug' },
      'not-json-garbage'
    ]) + 'trailing garbage line\n'
  )
  // Session with generated titles: ai-title wins over summary, custom-title wins over both
  writeFileSync(
    join(claudeDir, 'aaaa-2222.jsonl'),
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: 'do the thing' },
        timestamp: '2026-08-01T12:00:00Z',
        sessionId: 'aaaa-2222'
      },
      { type: 'summary', summary: 'Old summary' },
      { type: 'ai-title', aiTitle: 'Generated name', sessionId: 'aaaa-2222' },
      { type: 'custom-title', customTitle: 'User name', sessionId: 'aaaa-2222' }
    ])
  )

  // Sidechain transcripts are parts of a session, never sessions: one discovered
  // by path (<session-id>/subagents/), one by its isSidechain-marked lines
  const subDir = join(claudeDir, 'aaaa-1111', 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, 'agent-deadbeef.jsonl'),
    jsonl([
      {
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'You are reviewing the repository' },
        timestamp: '2026-08-01T11:00:00Z'
      },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'ok' } }
    ])
  )
  writeFileSync(
    join(claudeDir, 'aaaa-3333.jsonl'),
    jsonl([
      {
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'You are critiquing the UI' },
        timestamp: '2026-08-01T11:30:00Z'
      },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'sure' } }
    ])
  )
  // Inlined sidechain lines AFTER a main line must NOT hide a real session (old CLIs did this)
  writeFileSync(
    join(claudeDir, 'aaaa-4444.jsonl'),
    jsonl([
      {
        type: 'user',
        isSidechain: false,
        message: { role: 'user', content: 'real session with inline agent' },
        timestamp: '2026-08-01T13:00:00Z'
      },
      { type: 'user', isSidechain: true, message: { role: 'user', content: 'agent prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: 'done' } }
    ])
  )

  // --- Codex fixture ---
  const codexDir = join(root, 'codex', 'sessions', '2026', '08', '01')
  mkdirSync(codexDir, { recursive: true })
  writeFileSync(
    join(codexDir, 'rollout-2026-08-01-bbbb.jsonl'),
    jsonl([
      {
        timestamp: '2026-08-01T11:00:00Z',
        type: 'session_meta',
        payload: { id: 'bbbb-2222', cwd: '/Users/titan/dev/other', originator: 'codex_cli_rs' }
      },
      {
        timestamp: '2026-08-01T11:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'add unit tests' }]
        }
      },
      {
        timestamp: '2026-08-01T11:00:10Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done, added 3 tests.' }]
        }
      },
      {
        timestamp: '2026-08-01T11:00:12Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"pytest"}' }
      }
    ])
  )
  // Subagent rollouts (thread_source: subagent) share the sessions dirs but are
  // parts of a thread — never listed as sessions
  writeFileSync(
    join(codexDir, 'rollout-2026-08-01-ffff.jsonl'),
    jsonl([
      {
        timestamp: '2026-08-01T11:30:00Z',
        type: 'session_meta',
        payload: {
          id: 'ffff-6666',
          parent_thread_id: 'bbbb-2222',
          thread_source: 'subagent',
          cwd: '/Users/titan/dev/other',
          originator: 'codex_cli_rs'
        }
      },
      {
        timestamp: '2026-08-01T11:30:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'You are the guardian reviewer' }]
        }
      },
      {
        timestamp: '2026-08-01T11:30:05Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'review done' }]
        }
      }
    ])
  )
  // Guardian auto-reviews: their own thread_source, the parent's session id (so the
  // parent's thread name), and a subagent `source` — the shape Codex Desktop writes
  writeFileSync(
    join(codexDir, 'rollout-2026-08-01-gggg.jsonl'),
    jsonl([
      {
        timestamp: '2026-08-01T11:40:00Z',
        type: 'session_meta',
        payload: {
          session_id: 'ssss-9999',
          id: 'gggg-7777',
          parent_thread_id: 'ssss-9999',
          thread_source: 'guardian_review',
          source: { subagent: { other: 'guardian' } },
          cwd: '/Users/titan/dev/other',
          originator: 'Codex Desktop'
        }
      },
      {
        timestamp: '2026-08-01T11:40:01Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review this action' }] }
      }
    ])
  )
  // a thread_source Codex has not shipped yet, known only by its subagent `source`
  writeFileSync(
    join(codexDir, 'rollout-2026-08-01-hhhh.jsonl'),
    jsonl([
      {
        timestamp: '2026-08-01T11:45:00Z',
        type: 'session_meta',
        payload: {
          session_id: 'ssss-9999',
          id: 'hhhh-8888',
          thread_source: 'some_future_helper',
          source: { subagent: 'review' },
          cwd: '/Users/titan/dev/other'
        }
      },
      {
        timestamp: '2026-08-01T11:45:01Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'helper prompt' }] }
      }
    ])
  )
  // codex-rs persists a turn twice: as a ResponseItem AND as its event_msg echo
  writeFileSync(
    join(codexDir, 'rollout-2026-08-01-dddd.jsonl'),
    jsonl([
      {
        timestamp: '2026-08-01T13:00:00Z',
        type: 'session_meta',
        payload: { id: 'dddd-4444', cwd: '/Users/titan/dev/echo', originator: 'codex_cli_rs' }
      },
      {
        timestamp: '2026-08-01T13:00:01Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship it' }] }
      },
      {
        timestamp: '2026-08-01T13:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'ship it' }
      },
      {
        timestamp: '2026-08-01T13:00:09Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Shipped.' }] }
      },
      {
        timestamp: '2026-08-01T13:00:09Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Shipped.' }
      }
    ])
  )
  // Pre-envelope rollouts wrote bare ResponseItems with no {type,payload} wrapper
  writeFileSync(
    join(codexDir, 'rollout-2026-08-01-9999.jsonl'),
    jsonl([
      { id: '9999-0000', timestamp: '2026-08-01T14:00:00Z', originator: 'codex_cli_rs', cwd: '/Users/titan/dev/old' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy prompt' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'legacy reply' }] }
    ])
  )
  // Out-of-band thread names, keyed by session_meta's session_id
  writeFileSync(
    join(root, 'codex', 'session_index.jsonl'),
    jsonl([{ id: 'ssss-9999', thread_name: 'Add unit tests properly', updated_at: '2026-08-01T11:05:00Z' }])
  )
  writeFileSync(
    join(codexDir, 'rollout-2026-08-01-eeee.jsonl'),
    jsonl([
      {
        timestamp: '2026-08-01T12:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'eeee-5555',
          session_id: 'ssss-9999',
          cwd: '/Users/titan/dev/other',
          originator: 'codex_cli_rs'
        }
      },
      {
        timestamp: '2026-08-01T12:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions preamble' }]
        }
      },
      {
        timestamp: '2026-08-01T12:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'real prompt' }]
        }
      }
    ])
  )

  // --- Copilot fixture ---
  const copilotDir = join(root, 'copilot', 'history-session-state', 'cccc-3333')
  mkdirSync(copilotDir, { recursive: true })
  writeFileSync(
    join(copilotDir, 'state.json'),
    JSON.stringify({
      sessionId: 'cccc-3333',
      startTime: '2026-08-02T09:00:00Z',
      cwd: '/Users/titan/dev/site',
      timeline: [
        { role: 'user', content: 'refactor the header component', timestamp: '2026-08-02T09:00:00Z' },
        { role: 'assistant', content: 'Refactored into three parts.' },
        { type: 'tool', tool: 'str_replace_editor', content: 'edited Header.tsx' }
      ]
    })
  )

  // --- Copilot current-layout fixture: session-state/<id>/events.jsonl ---
  const copilotStateDir = join(root, 'copilot', 'session-state', 'dddd-4444')
  mkdirSync(copilotStateDir, { recursive: true })
  writeFileSync(
    join(copilotStateDir, 'events.jsonl'),
    jsonl([
      {
        type: 'session.start',
        timestamp: '2026-08-03T13:58:14Z',
        data: {
          sessionId: 'dddd-4444',
          startTime: '2026-08-03T13:58:14Z',
          context: {
            cwd: '/Users/titan/.copilot/copilot-worktrees/site/feat-x',
            repository: 'acme/site',
            branch: 'titan/feat-x'
          }
        }
      },
      { type: 'hook.start', timestamp: '2026-08-03T13:58:15Z', data: {} },
      {
        type: 'user.message',
        timestamp: '2026-08-03T13:58:16Z',
        data: { content: 'ship the new pricing page' }
      },
      {
        type: 'tool.execution_start',
        timestamp: '2026-08-03T13:58:20Z',
        data: { toolName: 'bash', arguments: { cmd: 'ls' } }
      },
      {
        type: 'assistant.message',
        timestamp: '2026-08-03T13:58:25Z',
        data: { content: 'Done — pricing page shipped.' }
      }
    ])
  )
  // what the CLI writes after 1.0.80: context is { cwd } alone — no branch, no repository
  const copilotBareDir = join(root, 'copilot', 'session-state', 'dddd-5555')
  mkdirSync(copilotBareDir, { recursive: true })
  writeFileSync(
    join(copilotBareDir, 'events.jsonl'),
    jsonl([
      {
        type: 'session.start',
        timestamp: '2026-09-15T09:00:00Z',
        data: {
          sessionId: 'dddd-5555',
          startTime: '2026-09-15T09:00:00Z',
          copilotVersion: '0.0.0',
          context: { cwd: '/Users/titan/.copilot/copilot-worktrees/site/feat-y' }
        }
      },
      { type: 'user.message', timestamp: '2026-09-15T09:00:01Z', data: { content: 'bump nx' } },
      { type: 'assistant.message', timestamp: '2026-09-15T09:00:09Z', data: { content: 'done' } }
    ])
  )

  writeFileSync(
    join(copilotStateDir, 'workspace.yaml'),
    [
      'id: dddd-4444',
      'cwd: /Users/titan/.copilot/copilot-worktrees/site/feat-x',
      'name: Pricing page launch',
      'user_named: false'
    ].join('\n') + '\n'
  )
})

describe('claude parser', () => {
  it('lists sessions with meta', () => {
    const s = listClaudeSessions(join(root, 'claude'), 'claude-test')
    expect(s).toHaveLength(3)
    expect(s.find((x) => x.nativeId === 'aaaa-1111')).toMatchObject({
      provider: 'claude',
      title: 'Fix login bug',
      cwd: '/Users/titan/dev/myrepo',
      logBranch: 'main',
      messageCount: 2
    })
  })
  it('never lists sidechain transcripts as sessions', () => {
    const s = listClaudeSessions(join(root, 'claude'), 'claude-test')
    // by path: <session-id>/subagents/agent-*.jsonl
    expect(s.find((x) => x.nativeId === 'agent-deadbeef')).toBeUndefined()
    // by content: isSidechain from the first flagged line
    expect(s.find((x) => x.nativeId === 'aaaa-3333')).toBeUndefined()
    // but inlined sidechain lines after a main line keep the session listed
    expect(s.find((x) => x.nativeId === 'aaaa-4444')?.title).toBe('real session with inline agent')
  })
  it('prefers custom-title over ai-title over summary', () => {
    const s = listClaudeSessions(join(root, 'claude'), 'claude-test')
    expect(s.find((x) => x.nativeId === 'aaaa-2222')?.title).toBe('User name')
  })
  it('parses messages incl. tool calls, tolerating garbage lines', () => {
    const s = listClaudeSessions(join(root, 'claude'), 'claude-test')
    const msgs = parseClaudeMessages(s.find((x) => x.nativeId === 'aaaa-1111')!.sourcePath)
    expect(msgs.map((m) => m.kind)).toEqual(['text', 'text', 'tool_call'])
    expect(msgs[2].toolName).toBe('Bash')
    // humanized preview alongside the raw JSON input
    expect(msgs[2].preview).toBe('ls')
    expect(msgs[2].text).toContain('"command"')
  })
})

describe('claude parser: a question waiting on the user', () => {
  it('carries the offered options onto the tool_call row', () => {
    const dir = join(root, 'claude-ask', 'projects', '-p')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'ask-1111.jsonl')
    writeFileSync(
      file,
      jsonl([
        { type: 'user', message: { role: 'user', content: 'set up the repo' }, timestamp: '2026-09-01T10:00:00Z' },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'Which owner?',
                      header: 'Owner',
                      options: [{ label: 'tashtit', description: 'the shared org' }, { label: 'titan-ron' }]
                    }
                  ]
                }
              }
            ]
          },
          timestamp: '2026-09-01T10:00:05Z'
        }
      ])
    )
    const msgs = parseClaudeMessages(file)
    expect(msgs[1]).toMatchObject({ kind: 'tool_call', toolName: 'AskUserQuestion', preview: 'Which owner?' })
    expect(msgs[1].asks).toEqual([
      {
        question: 'Which owner?',
        header: 'Owner',
        options: [{ label: 'tashtit', description: 'the shared org' }, { label: 'titan-ron' }]
      }
    ])
  })
})

describe('toolPreview', () => {
  it('extracts the headline field per tool', () => {
    expect(toolPreview('Bash', { command: 'npm test', description: 'x' })).toBe('npm test')
    expect(toolPreview('Edit', { file_path: 'src/a.ts', old_string: 'x' })).toBe('src/a.ts')
    expect(toolPreview('Read', { file_path: '/tmp/f' })).toBe('/tmp/f')
    expect(toolPreview('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src')
    expect(toolPreview('WebSearch', { query: 'electron fs.watch' })).toBe('electron fs.watch')
    // the calls that wait for a person read as what they asked
    expect(toolPreview('AskUserQuestion', { questions: [{ question: 'Which owner?' }] })).toBe('Which owner?')
    expect(toolPreview('AskUserQuestion', { questions: [] })).toBe('waiting for your answer')
    expect(toolPreview('ExitPlanMode', { plan: '# Plan' })).toBe('waiting for the plan to be approved')
  })
  it('returns null for unknown tools and malformed input', () => {
    expect(toolPreview('mcp__server__tool', { a: 1 })).toBeNull()
    expect(toolPreview('Bash', { command: '   ' })).toBeNull()
    expect(toolPreview('Bash', 'not-an-object')).toBeNull()
    expect(toolPreview('Bash', null)).toBeNull()
    // wrong-typed field (format drift) degrades to null, never throws
    expect(toolPreview('Bash', { command: 42 })).toBeNull()
  })
})

describe('codex parser', () => {
  it('lists sessions using session_meta id', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    expect(s).toHaveLength(4)
    expect(s.find((x) => x.nativeId === 'bbbb-2222')).toMatchObject({
      provider: 'codex',
      title: 'add unit tests',
      cwd: '/Users/titan/dev/other',
      messageCount: 2
    })
  })
  it('uses session_index thread_name and skips AGENTS.md preambles', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    expect(s.find((x) => x.nativeId === 'eeee-5555')?.title).toBe('Add unit tests properly')
  })
  it('never lists subagent rollouts as sessions', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    expect(s.find((x) => x.nativeId === 'ffff-6666')).toBeUndefined()
  })
  it('never lists guardian reviews or other thread parts, which borrow the parent thread name', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    expect(s.find((x) => x.nativeId === 'gggg-7777')).toBeUndefined()
    expect(s.find((x) => x.nativeId === 'hhhh-8888')).toBeUndefined()
    expect(s.filter((x) => x.title === 'Add unit tests properly')).toHaveLength(1)
  })
  it('parses messages and function calls', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    const msgs = parseCodexMessages(s.find((x) => x.nativeId === 'bbbb-2222')!.sourcePath)
    expect(msgs.map((m) => m.kind)).toEqual(['text', 'text', 'tool_call'])
    expect(msgs[0].role).toBe('user')
    // the row's headline is the command it ran, not its JSON arguments
    expect(msgs[2].preview).toBe('pytest')
    expect(msgs[2].text).toBe('{"cmd":"pytest"}')
  })
  it('counts a doubly-persisted turn once, not once per envelope', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    const echoed = s.find((x) => x.nativeId === 'dddd-4444')
    expect(echoed?.messageCount).toBe(2)
    expect(parseCodexMessages(echoed!.sourcePath).map((m) => m.text)).toEqual(['ship it', 'Shipped.'])
  })
  it('reads pre-envelope rollouts (bare ResponseItem lines)', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    const legacy = s.find((x) => x.nativeId === '9999-0000')
    expect(legacy).toMatchObject({ title: 'legacy prompt', messageCount: 2 })
    expect(parseCodexMessages(legacy!.sourcePath).map((m) => m.text)).toEqual([
      'legacy prompt',
      'legacy reply'
    ])
  })
})

describe('copilot parser', () => {
  it('lists sessions from both current and legacy layouts', () => {
    const s = listCopilotSessions(join(root, 'copilot'), 'copilot-test')
    expect(s).toHaveLength(3)
    const legacy = s.find((x) => x.nativeId === 'cccc-3333')
    expect(legacy).toMatchObject({
      provider: 'copilot',
      title: 'refactor the header component',
      cwd: '/Users/titan/dev/site',
      messageCount: 2
    })
  })
  it('reads repo/branch from session.start and the name from workspace.yaml', () => {
    const s = listCopilotSessions(join(root, 'copilot'), 'copilot-test')
    const current = s.find((x) => x.nativeId === 'dddd-4444')
    expect(current).toMatchObject({
      title: 'Pricing page launch',
      cwd: '/Users/titan/.copilot/copilot-worktrees/site/feat-x',
      logBranch: 'titan/feat-x',
      repoFullName: 'acme/site',
      messageCount: 2
    })
  })
  // the provider regression this fallback exists for — the indexer fills gitBranch in
  it('reports no logged branch or repo when session.start carries only a cwd', () => {
    const s = listCopilotSessions(join(root, 'copilot'), 'copilot-test')
    const bare = s.find((x) => x.nativeId === 'dddd-5555')
    expect(bare).toMatchObject({
      cwd: '/Users/titan/.copilot/copilot-worktrees/site/feat-y',
      logBranch: null,
      messageCount: 2
    })
    expect(bare?.repoFullName).toBeNull()
  })

  it('parses events.jsonl messages and tool calls', () => {
    const s = listCopilotSessions(join(root, 'copilot'), 'copilot-test')
    const current = s.find((x) => x.nativeId === 'dddd-4444')!
    const msgs = parseCopilotMessages(current.sourcePath)
    expect(msgs.map((m) => m.kind)).toEqual(['text', 'tool_call', 'text'])
    expect(msgs[1].toolName).toBe('bash')
    // humanized like Claude's rows — the command, not the raw JSON arguments
    expect(msgs[1].preview).toBe('ls')
  })
  it('parses legacy timeline messages and tools', () => {
    const s = listCopilotSessions(join(root, 'copilot'), 'copilot-test')
    const legacy = s.find((x) => x.nativeId === 'cccc-3333')!
    const msgs = parseCopilotMessages(legacy.sourcePath)
    expect(msgs).toHaveLength(3)
    expect(msgs[2].kind).toBe('tool_call')
    expect(msgs[2].toolName).toBe('str_replace_editor')
  })
})

// The Copilot app names a session after its whole kickoff prompt until it gets a real
// name, and a prompt one session writes for another runs to paragraphs — so the name
// arrives as a YAML block scalar, and the session that created it is named in the
// kickoff's <copilot_tauri_workspace> block.
describe('copilot child sessions', () => {
  const home = join(root, 'copilot-children')
  const PARENT = '0a0a0a0a-1111-4111-8111-000000000001'
  const CHILD = '0a0a0a0a-1111-4111-8111-000000000002'
  const SYS_CHILD = '0a0a0a0a-1111-4111-8111-000000000003'
  const TALKER = '0a0a0a0a-1111-4111-8111-000000000004'
  const SELF = '0a0a0a0a-1111-4111-8111-000000000005'

  const workspace = (creator: string): string =>
    [
      '<copilot_tauri_workspace>',
      'project_name: site',
      'workspace_type: worktree',
      `creator_chat_session_id: ${creator}`,
      '</copilot_tauri_workspace>'
    ].join('\n')

  function write(id: string, events: unknown[], yaml: string[]): void {
    const dir = join(home, 'session-state', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'events.jsonl'),
      jsonl([
        {
          type: 'session.start',
          timestamp: '2026-08-22T18:51:09Z',
          data: { sessionId: id, context: { cwd: `/Users/titan/.copilot/copilot-worktrees/site/${id.slice(0, 8)}` } }
        },
        ...events
      ])
    )
    writeFileSync(join(dir, 'workspace.yaml'), [`id: ${id}`, ...yaml].join('\n') + '\n')
  }

  const prompt = (content: string, transformedContent?: string): unknown => ({
    type: 'user.message',
    timestamp: '2026-08-22T18:51:10Z',
    data: { content, ...(transformedContent ? { transformedContent } : {}) }
  })

  beforeAll(() => {
    write(PARENT, [prompt('plan the free plan')], ['name: Free plan limits', 'user_named: false'])
    // the creator rides on the first prompt's transformedContent; the name is a literal block
    write(
      CHILD,
      [prompt('Build the first reviewable PR.', `<current_datetime>now</current_datetime>\n\n${workspace(PARENT)}\n\nBuild the first reviewable PR.`)],
      [
        'client_name: github/autopilot',
        'name: |-',
        '  Build the first reviewable PR in the Free-plan redesign.',
        '  Work only on the usage-accounting foundation.',
        '',
        '  Context and evidence:',
        'user_named: false'
      ]
    )
    // the creator in a system.message ahead of the prompt; the name is a folded block
    write(
      SYS_CHILD,
      [
        { type: 'system.message', timestamp: '2026-08-22T18:51:09Z', data: { content: `You are Copilot.\n\n${workspace(PARENT)}` } },
        prompt('Retain free trials.')
      ],
      ['name: >2-', '  Free trial', '  retention', '', '  second paragraph', 'user_named: false']
    )
    // a session that only *talks* to another one is not its child: the id arrives in a
    // cross-session message, and a context block after the first prompt is not kickoff
    write(
      TALKER,
      [
        prompt('which task takes 6 minutes?'),
        prompt(`<cross_session_message>\nfrom_session_id: ${PARENT}\n</cross_session_message>`, workspace(PARENT))
      ],
      ['name: Six minute task']
    )
    // a block naming the session itself is no parent
    write(SELF, [prompt('go', workspace(SELF))], ['name: Self-made'])
  })

  const byId = (id: string) => listCopilotSessions(home, 'copilot-test').find((s) => s.nativeId === id)

  it('titles a literal block-scalar name by its first line, never the indicator', () => {
    expect(byId(CHILD)?.title).toBe('Build the first reviewable PR in the Free-plan redesign.')
  })
  it('titles a folded block-scalar name by its first paragraph, joined', () => {
    expect(byId(SYS_CHILD)?.title).toBe('Free trial retention')
  })
  it('names the creator as the parent, from the prompt or from a system message before it', () => {
    expect(byId(CHILD)?.parentId).toBe(`copilot:${PARENT}`)
    expect(byId(SYS_CHILD)?.parentId).toBe(`copilot:${PARENT}`)
  })
  it('gives no parent to a top-level session, one that only messages another, or one naming itself', () => {
    expect(byId(PARENT)?.parentId).toBeUndefined()
    expect(byId(TALKER)?.parentId).toBeUndefined()
    expect(byId(SELF)?.parentId).toBeUndefined()
  })
})

describe('robustness', () => {
  it('empty/missing dirs return no sessions', () => {
    expect(listClaudeSessions(join(root, 'nope'), 'x')).toEqual([])
    expect(listCodexSessions(join(root, 'nope'), 'x')).toEqual([])
    expect(listCopilotSessions(join(root, 'nope'), 'x')).toEqual([])
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
