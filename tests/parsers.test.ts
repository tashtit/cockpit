import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listClaudeSessions, parseClaudeMessages } from '../src/main/parsers/claude'
import { listCodexSessions, parseCodexMessages } from '../src/main/parsers/codex'
import { listCopilotSessions, parseCopilotMessages } from '../src/main/parsers/copilot'

const root = join(tmpdir(), 'cockpit-test-fixtures')

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
    expect(s).toHaveLength(2)
    expect(s.find((x) => x.nativeId === 'aaaa-1111')).toMatchObject({
      provider: 'claude',
      title: 'Fix login bug',
      cwd: '/Users/titan/dev/myrepo',
      gitBranch: 'main',
      messageCount: 2
    })
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
  })
})

describe('codex parser', () => {
  it('lists sessions using session_meta id', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    expect(s).toHaveLength(2)
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
  it('parses messages and function calls', () => {
    const s = listCodexSessions(join(root, 'codex'), 'codex-test')
    const msgs = parseCodexMessages(s.find((x) => x.nativeId === 'bbbb-2222')!.sourcePath)
    expect(msgs.map((m) => m.kind)).toEqual(['text', 'text', 'tool_call'])
    expect(msgs[0].role).toBe('user')
  })
})

describe('copilot parser', () => {
  it('lists sessions from both current and legacy layouts', () => {
    const s = listCopilotSessions(join(root, 'copilot'), 'copilot-test')
    expect(s).toHaveLength(2)
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
      gitBranch: 'titan/feat-x',
      repoFullName: 'acme/site',
      messageCount: 2
    })
  })
  it('parses events.jsonl messages and tool calls', () => {
    const s = listCopilotSessions(join(root, 'copilot'), 'copilot-test')
    const current = s.find((x) => x.nativeId === 'dddd-4444')!
    const msgs = parseCopilotMessages(current.sourcePath)
    expect(msgs.map((m) => m.kind)).toEqual(['text', 'tool_call', 'text'])
    expect(msgs[1].toolName).toBe('bash')
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

describe('robustness', () => {
  it('empty/missing dirs return no sessions', () => {
    expect(listClaudeSessions(join(root, 'nope'), 'x')).toEqual([])
    expect(listCodexSessions(join(root, 'nope'), 'x')).toEqual([])
    expect(listCopilotSessions(join(root, 'nope'), 'x')).toEqual([])
  })
})
