import { afterAll, describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parseClaudeMessages, parseClaudeMeta } from '../src/main/parsers/claude'
import { parseCodexMessages, parseCodexMeta } from '../src/main/parsers/codex'
import { parseCopilotMessages, parseCopilotMeta } from '../src/main/parsers/copilot'
import { listClaudeSessions, listCodexSessions, listCopilotSessions } from './list-sessions'
import { parseCodexStreamLine } from '../src/main/chat'
import type { SessionMessage } from '../src/shared/types'
import { toolPreview } from '../src/main/parsers/util'
import { listGeminiSessions, parseGeminiMessages, parseGeminiMeta } from '../src/main/parsers/gemini'
import { listClineSessions, parseClineMessages } from '../src/main/parsers/cline'
import { listAntigravitySessions, parseAntigravityMessages } from '../src/main/parsers/antigravity'
import { listOpencodeSessions, parseOpencodeMessages } from '../src/main/parsers/opencode'
import { writeAntigravityConversation, writeCursorAcpSession, writeCursorChats, writeOpencodeDb } from '../scripts/ui-tour/store-fixtures.mts'
import {
  cursorQueryTime,
  cursorSlug,
  listCursorSessions,
  parseCursorMessages,
  resolveCursorSlug
} from '../src/main/parsers/cursor'
import { writePagedThread } from './codex-paged-thread'

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
    // Codex's own names for a search and a look at an image
    expect(toolPreview('web_search', { query: 'nx remote cache' })).toBe('nx remote cache')
    expect(toolPreview('view_image', { path: '/r/shot.png' })).toBe('/r/shot.png')
    // Claude's subagent tool under both its names, and Copilot's to-do queries by what they do
    expect(toolPreview('Agent', { description: 'Audit the renderer', prompt: 'long' })).toBe('Audit the renderer')
    expect(toolPreview('Task', { prompt: 'Audit it' })).toBe('Audit it')
    expect(toolPreview('sql', { description: 'Advance todos', query: 'UPDATE todos SET status = 1' })).toBe('Advance todos')
    expect(toolPreview('sql', { query: 'SELECT 1' })).toBe('SELECT 1')
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
  it('reads where a paginated thread continues from, and nothing from a fork', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-codex-paged-'))
    try {
      const t = writePagedThread(dir, '/Users/titan/dev/other')
      expect(parseCodexMeta(t.page1, 'x')?.historyBase).toBeUndefined()
      expect(parseCodexMeta(t.page2, 'x')).toMatchObject({ id: `codex:${t.threadId}`, historyBase: { endByte: t.endByte } })
      // a fork's history_base names the thread it forked from: its own thread, not a page
      const fork = join(dir, 'sessions', '2026', '09', '02', 'rollout-fork.jsonl')
      writeFileSync(
        fork,
        jsonl([
          {
            timestamp: '2026-09-02T12:00:00Z',
            type: 'session_meta',
            payload: {
              id: 'fork-1',
              session_id: 'fork-1',
              forked_from_id: t.threadId,
              history_base: { thread_id: t.threadId, end_byte_offset: t.endByte }
            }
          },
          { timestamp: '2026-09-02T12:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'fork' } }
        ])
      )
      expect(parseCodexMeta(fork, 'x')?.historyBase).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('renders a paginated thread across its pages, without the turn it abandoned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-codex-paged-'))
    try {
      const t = writePagedThread(dir, '/Users/titan/dev/other')
      const texts = parseCodexMessages(t.page2, [{ path: t.page1, endByte: t.endByte }]).map((m) => m.text)
      expect(texts).toEqual(['first question about pagination', 'first answer', 'second question', 'second answer'])
      // alone, the newest page is only its own turns
      expect(parseCodexMessages(t.page2).map((m) => m.text)).toEqual(['second question', 'second answer'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
  it('takes a cwd or a branch only when it is a string', () => {
    // a cwd of another type reached the repo resolver and threw there — outside the
    // parser's own failure tolerance — failing every scan that met the file
    const dir = join(root, 'odd-types')
    mkdirSync(dir, { recursive: true })
    const claude = join(dir, 'claude-odd.jsonl')
    writeFileSync(
      claude,
      jsonl([
        { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-08-01T10:00:00Z', sessionId: 'odd', cwd: { path: '/x' }, gitBranch: 42 }
      ])
    )
    expect(parseClaudeMeta(claude, 'x')).toMatchObject({ cwd: null, logBranch: null })
    const codex = join(dir, 'rollout-odd.jsonl')
    writeFileSync(
      codex,
      jsonl([
        { timestamp: '2026-08-01T10:00:00Z', type: 'session_meta', payload: { id: 'odd', cwd: ['/x'], git: { branch: {} } } },
        { timestamp: '2026-08-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }
      ])
    )
    expect(parseCodexMeta(codex, 'x')).toMatchObject({ cwd: null, logBranch: null })
  })

  // the repo resolver walks every ancestor of a cwd: a 16k-component "path" cost seconds
  it('takes no cwd longer than a directory path can be', () => {
    const dir = join(root, 'long-cwd')
    const long = '/a'.repeat(16_000)
    const ts = '2026-08-01T10:00:00Z'
    const prompt = { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: ts, sessionId: 'long' }
    mkdirSync(join(dir, 'copilot', 'session-state', 'long'), { recursive: true })
    const claude = join(dir, 'claude-long.jsonl')
    // the first usable cwd wins, so a later sane one is still the session's
    writeFileSync(claude, jsonl([{ ...prompt, cwd: long }, { ...prompt, cwd: '/Users/x/app' }]))
    expect(parseClaudeMeta(claude, 'x')?.cwd).toBe('/Users/x/app')
    writeFileSync(claude, jsonl([{ ...prompt, cwd: long }]))
    expect(parseClaudeMeta(claude, 'x')?.cwd).toBeNull()
    const codex = join(dir, 'rollout-long.jsonl')
    writeFileSync(
      codex,
      jsonl([
        { timestamp: ts, type: 'session_meta', payload: { id: 'long', cwd: long } },
        { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }
      ])
    )
    expect(parseCodexMeta(codex, 'x')?.cwd).toBeNull()
    writeFileSync(
      join(dir, 'copilot', 'session-state', 'long', 'events.jsonl'),
      jsonl([
        { type: 'session.start', timestamp: ts, data: { sessionId: 'long', context: { cwd: long } } },
        { type: 'user.message', timestamp: ts, data: { content: 'hi' } }
      ])
    )
    expect(listCopilotSessions(join(dir, 'copilot'), 'x').map((s) => s.cwd)).toEqual([null])
    // a path at the limit is still one
    const edge = `/${'b'.repeat(1023)}`
    writeFileSync(claude, jsonl([{ ...prompt, cwd: edge }]))
    expect(parseClaudeMeta(claude, 'x')?.cwd).toBe(edge)
  })

  // JSON.parse reads any depth; JSON.stringify recursed and threw, blanking the transcript
  it('keeps a transcript whose tool input is nested deeper than JSON.stringify can go', () => {
    const dir = join(root, 'deep-input')
    mkdirSync(join(dir, 'copilot-deep'), { recursive: true })
    const deep = '{"a":'.repeat(100_000) + '1' + '}'.repeat(100_000)
    const ts = '2026-08-01T10:00:00Z'
    const claude = join(dir, 'claude-deep.jsonl')
    writeFileSync(
      claude,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, timestamp: ts }),
        `{"type":"assistant","timestamp":"${ts}","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Weird","input":${deep}}]}}`,
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'still here' }, timestamp: ts })
      ].join('\n') + '\n'
    )
    const rows = parseClaudeMessages(claude)
    expect(rows.map((m) => m.text)).toEqual(['go', '(nested too deeply to show)', 'still here'])
    expect(rows[1]).toMatchObject({ kind: 'tool_call', toolName: 'Weird' })

    const codex = join(dir, 'rollout-deep.jsonl')
    writeFileSync(
      codex,
      [
        `{"timestamp":"${ts}","type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","server":"s","tool":"t","arguments":${deep}}}}`,
        `{"timestamp":"${ts}","type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":${deep}}}`,
        JSON.stringify({ timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'still here' }] } })
      ].join('\n') + '\n'
    )
    expect(parseCodexMessages(codex).map((m) => m.text)).toEqual([
      '(nested too deeply to show)',
      '(nested too deeply to show)',
      'still here'
    ])

    const copilot = join(dir, 'copilot-deep', 'events.jsonl')
    writeFileSync(
      copilot,
      [
        `{"type":"tool.execution_start","timestamp":"${ts}","data":{"toolName":"weird","toolCallId":"x","arguments":${deep}}}`,
        JSON.stringify({ type: 'assistant.message', timestamp: ts, data: { content: 'still here' } })
      ].join('\n') + '\n'
    )
    expect(parseCopilotMessages(copilot).map((m) => m.text)).toEqual(['(nested too deeply to show)', 'still here'])
  })

  it('empty/missing dirs return no sessions', () => {
    expect(listClaudeSessions(join(root, 'nope'), 'x')).toEqual([])
    expect(listCodexSessions(join(root, 'nope'), 'x')).toEqual([])
    expect(listCopilotSessions(join(root, 'nope'), 'x')).toEqual([])
  })
})

// What a tool call hands the person to look at — a plan, a to-do list, an edit — rides
// the call's row as a structured artifact (the Work panel's input), read from the real
// log shapes each CLI writes.
describe('codex code mode: exec cells and the items their tool runs complete with', () => {
  const dir = join(root, 'code-mode')
  const at = (s: number): string => `2026-09-24T10:00:${String(s).padStart(2, '0')}.000Z`
  const head = (id: string): unknown[] => [
    { timestamp: at(0), type: 'session_meta', payload: { id, cwd: '/r', originator: 'Codex Desktop', cli_version: '0.155.0' } },
    { timestamp: at(0), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: at(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look around' }] } }
  ]
  const cell = (s: number, callId: string, input: string): unknown => ({
    timestamp: at(s),
    type: 'response_item',
    payload: { type: 'custom_tool_call', id: `ctc_${callId}`, status: 'completed', call_id: callId, name: 'exec', input }
  })
  const cellOut = (s: number, callId: string, verdict: string, text: string): unknown => ({
    timestamp: at(s),
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: callId,
      output: [
        { type: 'input_text', text: `${verdict}\nWall time 0.2 seconds\nOutput:\n` },
        { type: 'input_text', text }
      ]
    }
  })
  const done = (s: number, item: object): unknown => ({
    timestamp: at(s),
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'th', turn_id: 't1', item, started_at_ms: 1, completed_at_ms: 2 }
  })
  const command = (id: string, script: string, rest: object): object => ({
    type: 'CommandExecution',
    id,
    process_id: '88692',
    command: ['/bin/zsh', '-lc', script],
    cwd: 'file:///r',
    parsed_cmd: [{ type: 'unknown', cmd: script }],
    source: 'unified_exec_startup',
    duration: { secs: 0, nanos: 5 },
    ...rest
  })
  const write = (name: string, records: unknown[]): string => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, jsonl(records))
    return file
  }
  const calls = (msgs: SessionMessage[]): SessionMessage[] => msgs.filter((m) => m.kind === 'tool_call')

  it('renders each tool run from its typed item, and not the cell that ran it', () => {
    const file = write('rollout-items.jsonl', [
      ...head('items-1'),
      cell(2, 'call_a', 'const r = await Promise.allSettled([\n  tools.exec_command({cmd:"rg -n \'unknowns?\' projects",workdir:"/r"}),\n  tools.exec_command({cmd:"git status --short --branch",workdir:"/r"})\n]); r.forEach((x) => text(x.value.output))\n'),
      done(3, command('exec-1', "rg -n 'unknowns?' projects", { status: 'failed', stdout: '', stderr: '', aggregated_output: '', exit_code: 1 })),
      done(3, command('exec-2', 'git status --short --branch', { status: 'completed', stdout: '## main\n', stderr: '', aggregated_output: '## main\n', exit_code: 0 })),
      cellOut(4, 'call_a', 'Script completed', '## main\n'),
      cell(5, 'call_b', "const r = await tools.mcp__node_repl__js({code:'await cua.getState()',title:'Check the console session'}); text(r)"),
      done(6, {
        type: 'McpToolCall',
        id: 'exec-3',
        server: 'node_repl',
        tool: 'js',
        arguments: { code: 'await cua.getState()', title: 'Check the console session' },
        status: 'completed',
        result: { content: [{ type: 'text', text: 'Browser tab: 1' }] }
      }),
      cellOut(6, 'call_b', 'Script completed', 'Browser tab: 1'),
      cell(7, 'call_c', "text(await tools.web__run({search_query:[{q:'\"Tavrek\"'},{q:'\"Tovren\"'},{q:'\"Tazlek\"'}],response_length:\"short\"}));\n"),
      done(8, {
        type: 'Extension',
        kind: 'web.search',
        id: 'exec-4',
        query: '"Tavrek" ...',
        action: { type: 'search', query: null, queries: ['"Tavrek"', '"Tovren"', '"Tazlek"'] },
        results: [{ type: 'text_result', domain: 'tavrek.dev', title: 'Tavrek', url: 'https://tavrek.dev/', snippet: '…' }]
      }),
      cellOut(8, 'call_c', 'Script completed', 'Tavrek (https://tavrek.dev/)'),
      cell(9, 'call_d', 'const t = await tools.chrome_extension__getTabContext({tabId: 1610293432}); text(t)'),
      done(10, {
        type: 'DynamicToolCall',
        id: 'exec-5',
        namespace: 'chrome_extension',
        tool: 'getTabContext',
        arguments: { tabId: 1610293432 },
        status: 'completed',
        content_items: [{ type: 'inputText', text: 'Ads Manager' }],
        success: true
      }),
      done(10, { type: 'ImageView', id: 'exec-6', path: 'file:///r/My%20Shots/preview.png' }),
      cellOut(11, 'call_d', 'Script completed', 'Ads Manager'),
      // a tool called directly completes with an item under the call's own id: said once
      { timestamp: at(12), type: 'response_item', payload: { type: 'function_call', name: 'sleep', arguments: '{"duration_ms":30000}', call_id: 'call_s' } },
      done(13, { type: 'Extension', kind: 'clock.sleep', id: 'call_s', durationMs: 30000 }),
      { timestamp: at(13), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_s', output: 'Wall time: 30.0 seconds\nSleep completed.' } },
      // the answer to a direct `js` call is content blocks, not a string
      { timestamp: at(14), type: 'response_item', payload: { type: 'function_call', name: 'js', arguments: '{"code":"await tab.reload()","title":"Reload the preview"}', call_id: 'call_j' } },
      done(15, { type: 'McpToolCall', id: 'call_j', server: 'cua_repl', tool: 'js', arguments: {}, status: 'completed', result: { content: [] } }),
      {
        timestamp: at(15),
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_j',
          output: [
            { type: 'input_text', text: 'Wall time: 0.9 seconds\nOutput: reloaded' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
          ]
        }
      },
      { timestamp: at(16), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' } }
    ])
    const msgs = parseCodexMessages(file)
    const rows = calls(msgs)
    expect(rows.map((m) => m.toolName)).toEqual([
      'shell',
      'shell',
      'mcp__node_repl__js',
      'web_search',
      'chrome_extension__getTabContext',
      'view_image',
      'sleep',
      'js'
    ])
    // the command a run executed, unwrapped from its shell, is the headline
    expect(rows[0]).toMatchObject({ preview: "rg -n 'unknowns?' projects", text: "rg -n 'unknowns?' projects", failed: true })
    expect(rows[1]).toMatchObject({ preview: 'git status --short --branch' })
    expect(rows[1].failed).toBeUndefined()
    expect(rows[2]).toMatchObject({ preview: 'Check the console session' })
    expect(rows[3]).toMatchObject({ preview: '"Tavrek" (+2 more)', text: '"Tavrek" "Tovren" "Tazlek"' })
    expect(rows[4].preview).toBeUndefined()
    expect(rows[5]).toMatchObject({ preview: '/r/My Shots/preview.png' })
    expect(rows[7]).toMatchObject({ preview: 'Reload the preview' })
    // every result sits right under its call, where the chat folds it into the row
    const resultOf = (row: SessionMessage): string | undefined => {
      const next = msgs[msgs.indexOf(row) + 1]
      return next?.kind === 'tool_result' ? next.text : undefined
    }
    expect(rows.map(resultOf)).toEqual([
      'exit 1',
      '## main',
      'Browser tab: 1',
      'Tavrek — https://tavrek.dev/',
      'Ads Manager',
      undefined,
      'Wall time: 30.0 seconds Sleep completed.',
      'Wall time: 0.9 seconds Output: reloaded'
    ])
  })

  it('names a logged command the way the live stream does, so a rejoined turn matches it', () => {
    const file = write('rollout-rejoin.jsonl', [
      ...head('items-2'),
      cell(2, 'call_a', 'await tools.exec_command({cmd:"npm test -- --run",workdir:"/r"})'),
      done(3, command('exec-1', 'npm test -- --run', { status: 'completed', aggregated_output: 'ok', exit_code: 0 }))
    ])
    const [row] = calls(parseCodexMessages(file))
    const [streamed] = parseCodexStreamLine('turn-1', {
      type: 'item.completed',
      item: { id: 'item_1', type: 'command_execution', command: '/bin/zsh -lc "npm test -- --run"', status: 'completed' }
    })
    expect(streamed).toMatchObject({ type: 'tool', toolName: row!.toolName, preview: row!.preview })
  })

  it('renders cells as rows of their own where no item speaks for their runs', () => {
    const patch = 'const p = "/r";\ntext(await tools.apply_patch(`*** Begin Patch\\n*** Update File: ${p}/src/a.ts\\n@@\\n-a\\n+b\\n*** End Patch`))'
    const file = write('rollout-cells.jsonl', [
      ...head('cells-1'),
      cell(2, 'call_a', "const r = await tools.exec_command({cmd:\"sed -n '1,220p' README.md\", workdir: \"/r\"}); text(r.output)\n"),
      cellOut(3, 'call_a', 'Script completed', '# README'),
      cell(4, 'call_b', 'await Promise.all([\n  tools.exec_command({cmd:"wc -l a.ts"}),\n  tools.exec_command({cmd:"wc -l b.ts"}),\n  tools.web__run({search_query:[{q:"x"}]})\n])'),
      cellOut(5, 'call_b', 'Script completed', '1 a.ts'),
      cell(6, 'call_c', patch),
      cellOut(7, 'call_c', 'Script failed', 'Script error:\napply_patch verification failed'),
      cell(8, 'call_d', 'text(await tools.write_stdin({session_id:91432,chars:"",yield_time_ms:20000}))'),
      cell(9, 'call_e', 'text(ALL_TOOLS.filter((x) => /search/.test(x.name)).map((x) => x.name))'),
      // a direct call's own item is only its echo: it does not make the cells' runs typed
      { timestamp: at(10), type: 'response_item', payload: { type: 'function_call', name: 'sleep', arguments: '{"duration_ms":10}', call_id: 'call_s' } },
      done(11, { type: 'Extension', kind: 'clock.sleep', id: 'call_s', durationMs: 10 })
    ])
    const msgs = parseCodexMessages(file)
    const rows = calls(msgs)
    expect(rows.map((m) => [m.toolName, m.preview])).toEqual([
      ['exec', "sed -n '1,220p' README.md"],
      ['exec', 'wc -l a.ts (+2 more)'],
      ['exec', 'apply_patch ${p}/src/a.ts'],
      ['exec', 'write_stdin'],
      ['exec', undefined],
      ['sleep', undefined]
    ])
    // the cell's output (its content blocks, as text) is its result
    expect(msgs[msgs.indexOf(rows[0]!) + 1]).toMatchObject({ kind: 'tool_result', text: 'Script completed Wall time 0.2 seconds Output: # README' })
    // a cell that only patches carries the edit, and one that threw says it did not apply
    expect(rows[2]).toMatchObject({ artifact: { kind: 'edits', files: [{ path: '${p}/src/a.ts' }] }, failed: true })
    expect(rows[0].failed).toBeUndefined()
    expect(rows[4].text).toContain('ALL_TOOLS.filter')
  })

  it('skips a malformed item and a torn last line rather than failing the transcript', () => {
    const file = write('rollout-torn.jsonl', [
      ...head('torn-1'),
      cell(2, 'call_a', 'await tools.exec_command({cmd:"ls"})'),
      done(3, { type: 'CommandExecution', id: 'exec-1' }),
      done(3, { type: 'McpToolCall', id: 'exec-2', tool: 'js' }),
      done(3, { type: 'Extension', id: 'exec-3' }),
      done(3, { type: 'WebSearch', id: 'exec-4', action: { type: 'search' } }),
      done(3, { type: 'ImageView', id: 'exec-5', path: 42 }),
      done(3, { type: 'DynamicToolCall', id: 'exec-6', namespace: 'x' }),
      done(4, command('exec-7', 'ls', { status: 'completed', exit_code: 0, aggregated_output: '' }))
    ])
    writeFileSync(file, `${jsonl([])}{"timestamp":"${at(5)}","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExec`, { flag: 'a' })
    const msgs = parseCodexMessages(file)
    // the malformed items still say the rollout carries items, so the cell stays hidden
    expect(calls(msgs).map((m) => [m.toolName, m.preview])).toEqual([['shell', 'ls']])
    // a run that printed nothing still says it finished
    expect(msgs.at(-1)).toMatchObject({ kind: 'tool_result', text: 'exit 0' })
  })
})

describe('work artifacts on tool rows', () => {
  const dir = join(root, 'work')

  it('claude: an edit, its failed retry, and tasks numbered by their results', () => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'claude-work.jsonl')
    const at = (s: number): string => `2026-09-01T10:00:${String(s).padStart(2, '0')}Z`
    writeFileSync(
      file,
      jsonl([
        { type: 'user', message: { role: 'user', content: 'fix it' }, timestamp: at(0) },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              // parallel calls: their results arrive together, after both
              { type: 'tool_use', id: 'tu1', name: 'TaskCreate', input: { subject: 'Reproduce', description: 'd', activeForm: 'x' } },
              { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } }
            ]
          },
          timestamp: at(1)
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu1', content: 'Task #7 created successfully: Reproduce' },
              { type: 'tool_result', tool_use_id: 'tu2', content: 'String to replace not found in file.', is_error: true }
            ]
          },
          timestamp: at(2)
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } }] },
          timestamp: at(3)
        }
      ])
    )
    const msgs = parseClaudeMessages(file)
    const calls = msgs.filter((m) => m.kind === 'tool_call')
    expect(calls[0]).toMatchObject({ toolName: 'TaskCreate', preview: 'Reproduce', artifact: { kind: 'task-add', items: ['Reproduce'], ids: ['7'] } })
    expect(calls[0].failed).toBeUndefined()
    // the error answered the Edit, not the call next to it
    expect(calls[1]).toMatchObject({ toolName: 'Edit', failed: true, artifact: { kind: 'edits' } })
    expect(calls[2]).toMatchObject({ preview: '#7 → completed', artifact: { kind: 'task-update', id: '7', status: 'completed' } })
    // the result rows stay as they were — the verdict is the call's
    expect(msgs.filter((m) => m.kind === 'tool_result').every((m) => m.failed === undefined)).toBe(true)
  })

  it('codex: a FileChange item is the patch row when the patch ran inside a code-mode script', () => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'rollout-work.jsonl')
    writeFileSync(
      file,
      jsonl([
        { timestamp: '2026-09-01T10:00:00Z', type: 'session_meta', payload: { id: 'work-1', cwd: '/r' } },
        { timestamp: '2026-09-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
        {
          timestamp: '2026-09-01T10:00:02Z',
          type: 'response_item',
          payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Patch it', status: 'in_progress' }] }), call_id: 'c0' }
        },
        {
          timestamp: '2026-09-01T10:00:03Z',
          type: 'response_item',
          payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.apply_patch("..."))', call_id: 'c1' }
        },
        {
          timestamp: '2026-09-01T10:00:04Z',
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: {
              type: 'FileChange',
              id: 'fc1',
              status: 'completed',
              stdout: 'Success. Updated the following files:\nM /r/a.ts\n',
              changes: { '/r/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null } }
            }
          }
        }
      ])
    )
    const calls = parseCodexMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      toolName: 'update_plan',
      preview: '1 step',
      artifact: { kind: 'todos', items: [{ text: 'Patch it', status: 'in_progress' }] }
    })
    expect(calls[1]).toMatchObject({ toolName: 'apply_patch', preview: 'apply_patch /r/a.ts', artifact: { kind: 'edits' } })
  })

  it('codex: an apply_patch call is the row, and its FileChange item is not shown twice', () => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'rollout-patch.jsonl')
    const patch = '*** Begin Patch\n*** Update File: /r/a.ts\n@@\n-a\n+b\n*** End Patch'
    writeFileSync(
      file,
      jsonl([
        { timestamp: '2026-09-01T10:00:00Z', type: 'session_meta', payload: { id: 'work-2', cwd: '/r' } },
        { timestamp: '2026-09-01T10:00:01Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: patch, call_id: 'p1' } },
        {
          timestamp: '2026-09-01T10:00:02Z',
          type: 'event_msg',
          payload: { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: { '/r/a.ts': { type: 'update', unified_diff: '@@\n-a\n+b\n' } } } }
        },
        { timestamp: '2026-09-01T10:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p1', output: 'Done!' } }
      ])
    )
    const msgs = parseCodexMessages(file)
    expect(msgs.map((m) => m.kind)).toEqual(['tool_call', 'tool_result'])
    expect(msgs[0]).toMatchObject({ toolName: 'apply_patch', preview: 'apply_patch /r/a.ts', artifact: { kind: 'edits' } })
  })

  it('copilot: a plan, an edit, and an edit whose execution failed', () => {
    const sdir = join(dir, 'copilot', 'session-state', 'work-3')
    mkdirSync(sdir, { recursive: true })
    const file = join(sdir, 'events.jsonl')
    writeFileSync(
      file,
      jsonl([
        { type: 'user.message', data: { content: 'plan it' }, timestamp: '2026-09-01T10:00:00Z' },
        {
          type: 'tool.execution_start',
          data: { toolCallId: 'k1', toolName: 'exit_plan_mode', arguments: { summary: '## Plan\n- one', recommendedAction: 'autopilot' } },
          timestamp: '2026-09-01T10:00:01Z'
        },
        {
          type: 'tool.execution_start',
          data: { toolCallId: 'k2', toolName: 'edit', arguments: { path: '/r/a.ts', old_str: 'a', new_str: 'b' } },
          timestamp: '2026-09-01T10:00:02Z'
        },
        { type: 'tool.execution_complete', data: { toolCallId: 'k2', success: false, result: { content: 'no match' } }, timestamp: '2026-09-01T10:00:03Z' },
        {
          type: 'tool.execution_start',
          data: { toolCallId: 'k3', toolName: 'create', arguments: { path: '/r/b.ts', file_text: 'x' } },
          timestamp: '2026-09-01T10:00:04Z'
        },
        { type: 'tool.execution_complete', data: { toolCallId: 'k3', success: true, result: { content: 'ok' } }, timestamp: '2026-09-01T10:00:05Z' }
      ])
    )
    const calls = parseCopilotMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[0]).toMatchObject({ toolName: 'exit_plan_mode', artifact: { kind: 'plan', text: '## Plan\n- one' } })
    expect(calls[1]).toMatchObject({ toolName: 'edit', failed: true, artifact: { kind: 'edits' } })
    expect(calls[2]).toMatchObject({ toolName: 'create', artifact: { kind: 'edits' } })
    expect(calls[2].failed).toBeUndefined()
  })
})

describe('checks: how each agent’s runs of its tests, typecheck and linter ended', () => {
  const dir = join(root, 'checks')
  const at = (s: number): string => `2026-09-03T10:00:${String(s).padStart(2, '0')}Z`

  it('claude: an exit code on an error, a zero exit on a success, nothing for a refusal or the background', () => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'claude-checks.jsonl')
    const call = (id: string, command: string, extra: object = {}): object => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, ...extra } }] },
      timestamp: at(1)
    })
    const result = (id: string, content: string, isError = false): object => ({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
      timestamp: at(2)
    })
    writeFileSync(
      file,
      jsonl([
        { type: 'user', message: { role: 'user', content: 'check it' }, timestamp: at(0) },
        call('b1', 'npm run typecheck'),
        result('b1', 'Exit code 2\nsrc/a.ts(1,7): error TS2322: nope', true),
        call('b2', 'npm test 2>&1 | tail -3'),
        // the pipe exited 0; the runner's summary says otherwise
        result('b2', ' Tests  1 failed | 9 passed (10)'),
        call('b3', 'npx vitest run'),
        result('b3', ' Tests  10 passed (10)'),
        call('b4', 'npm run lint'),
        result('b4', 'Permission for this action was denied by the user.', true),
        call('b5', 'npm run test:e2e', { run_in_background: true }),
        result('b5', 'Command running in background with ID: bx1. Output is being written to: /tmp/x'),
        call('b6', 'ls -la'),
        result('b6', 'total 0')
      ])
    )
    const calls = parseClaudeMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[0]).toMatchObject({ failed: true, artifact: { kind: 'check', checks: ['types'], status: 'failed', exitCode: 2 } })
    expect(calls[0].artifact).toMatchObject({ output: ['src/a.ts(1,7): error TS2322: nope'] })
    expect(calls[1]).toMatchObject({ artifact: { checks: ['tests'], status: 'failed', exitCode: 0 } })
    expect(calls[1].failed).toBeUndefined()
    expect(calls[2]).toMatchObject({ artifact: { status: 'passed', exitCode: 0 } })
    // denied: it never ran, so it has no verdict — the row still says the call failed
    expect(calls[3]).toMatchObject({ failed: true, artifact: { kind: 'check', checks: ['lint'] } })
    expect(calls[3].artifact).not.toHaveProperty('status')
    expect(calls[4].artifact).toMatchObject({ kind: 'check', checks: ['e2e'] })
    expect(calls[4].artifact).not.toHaveProperty('status')
    expect(calls[5].artifact).toBeUndefined()
  })

  it('copilot: the exit code it states, or the marker its output ends with — whatever `success` says', () => {
    const sdir = join(dir, 'copilot', 'session-state', 'checks-1')
    mkdirSync(sdir, { recursive: true })
    const file = join(sdir, 'events.jsonl')
    const call = (id: string, command: string): object => ({
      type: 'tool.execution_start',
      data: { toolCallId: id, toolName: 'bash', arguments: { command, description: 'run', mode: 'sync' } },
      timestamp: at(1)
    })
    const done = (id: string, data: object): object => ({
      type: 'tool.execution_complete',
      data: { toolCallId: id, success: true, ...data },
      timestamp: at(2)
    })
    writeFileSync(
      file,
      jsonl([
        call('c1', 'npm test'),
        done('c1', { shellExecution: { exitCode: 1 }, result: { content: 'FAIL a.test.ts\n<exited with exit code 1>' } }),
        call('c2', 'npm run lint'),
        done('c2', { result: { content: 'clean\n<shellId: 7 completed with exit code 0>', detailedContent: '' } }),
        call('c3', 'npm run build'),
        done('c3', { result: { content: '<shellId: 9>' } })
      ])
    )
    const calls = parseCopilotMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[0]).toMatchObject({ artifact: { checks: ['tests'], status: 'failed', exitCode: 1, output: ['FAIL a.test.ts'] } })
    // a non-zero exit is a failed call, as Claude's log would say — whatever `success` claimed
    expect(calls[0].failed).toBe(true)
    expect(calls[1].failed).toBeUndefined()
    expect(calls[1]).toMatchObject({ artifact: { checks: ['lint'], status: 'passed', exitCode: 0, output: ['clean'] } })
    // started in the background: its end is in a later read, not here
    expect(calls[2].artifact).not.toHaveProperty('status')
  })

  it('codex: a command item’s own exit code, and a direct call’s output', () => {
    const file = join(dir, 'rollout-checks.jsonl')
    writeFileSync(
      file,
      jsonl([
        { timestamp: at(0), type: 'session_meta', payload: { id: 'checks-2', cwd: '/r' } },
        { timestamp: at(1), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'f1' } },
        {
          timestamp: at(2),
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'f1', output: 'Chunk ID: 1\nWall time: 2.0 seconds\nProcess exited with code 1\nOutput:\n2 failed\n' }
        }
      ])
    )
    const direct = parseCodexMessages(file).filter((m) => m.kind === 'tool_call')
    expect(direct[0]).toMatchObject({ artifact: { checks: ['tests'], status: 'failed', exitCode: 1, output: ['2 failed'] } })
  })
})

describe('what agents share with the person', () => {
  const dir = join(root, 'shared')
  const at = (s: number): string => `2026-09-04T10:00:${String(s).padStart(2, '0')}Z`

  it('claude: files it sends, and the address of a page it publishes, read off the result', () => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'claude-shared.jsonl')
    const call = (id: string, name: string, input: object): object => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      timestamp: at(1)
    })
    const result = (id: string, content: string): object => ({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
      timestamp: at(2)
    })
    writeFileSync(
      file,
      jsonl([
        call('s1', 'SendUserFile', { files: ['/tmp/s/1-home.png', '/tmp/s/2-chat.png'], caption: 'Both views', status: 'normal' }),
        result('s1', '2 files delivered to user.'),
        call('s2', 'Artifact', { file_path: '/tmp/s/review.html', description: 'The review' }),
        result('s2', 'Published /tmp/s/review.html at https://claude.ai/code/artifact/abc-123. Watching it.')
      ])
    )
    const calls = parseClaudeMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[0]).toMatchObject({ artifact: { kind: 'shared', files: ['/tmp/s/1-home.png', '/tmp/s/2-chat.png'], caption: 'Both views' } })
    expect(calls[1]).toMatchObject({
      artifact: { kind: 'shared', files: ['/tmp/s/review.html'], links: [{ url: 'https://claude.ai/code/artifact/abc-123' }] }
    })
  })

  it('copilot: what it writes to its session’s files/ is shared, not an edit of the repo; a preview it opens is a page', () => {
    const sdir = join(dir, 'copilot', 'session-state', 'shared-1')
    mkdirSync(sdir, { recursive: true })
    const file = join(sdir, 'events.jsonl')
    const call = (id: string, toolName: string, args: object, s: number): object => ({
      type: 'tool.execution_start',
      data: { toolCallId: id, toolName, arguments: args },
      timestamp: at(s)
    })
    writeFileSync(
      file,
      jsonl([
        call('c1', 'create', { path: join(sdir, 'files', 'pr-body.md'), file_text: '## Summary' }, 1),
        call('c2', 'edit', { path: join(sdir, 'files', 'pr-body.md'), old_str: 'Summary', new_str: 'Summary\n- one' }, 2),
        call('c3', 'create', { path: '/r/src/a.ts', file_text: 'x' }, 3),
        call('c4', 'open_canvas', { canvasId: 'browser', instanceId: 'p', input: { url: 'http://localhost:3345/', title: 'Preview' } }, 4)
      ])
    )
    const calls = parseCopilotMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[0]).toMatchObject({ artifact: { kind: 'shared', files: [join(sdir, 'files', 'pr-body.md')] } })
    expect(calls[1]).toMatchObject({ artifact: { kind: 'shared' } })
    expect(calls[2]).toMatchObject({ artifact: { kind: 'edits' } })
    expect(calls[3]).toMatchObject({ artifact: { kind: 'shared', links: [{ url: 'http://localhost:3345/', title: 'Preview' }] } })
  })
})

describe('follow-ups an agent suggests', () => {
  it('claude: a suggestion learns its id from the result, and a later withdrawal marks it', () => {
    const dir = join(root, 'follow-ups')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'claude-follow-ups.jsonl')
    const at = (s: number): string => `2026-09-05T10:00:${String(s).padStart(2, '0')}Z`
    const call = (id: string, name: string, input: object, s: number): object => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
      timestamp: at(s)
    })
    const result = (id: string, content: string, s: number): object => ({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: content }] }] },
      timestamp: at(s)
    })
    writeFileSync(
      file,
      jsonl([
        call('f1', 'mcp__ccd_session__spawn_task', { title: 'Fix the cache race', tldr: 'Seen in the logs.', prompt: 'In the repo, fix it.' }, 1),
        result('f1', 'Noted (position 1, task_id: task_40d57447). A chip is showing for the user.', 2),
        call('f2', 'mcp__ccd_session__spawn_task', { title: 'Drop the dead flag', prompt: 'Remove it.' }, 3),
        result('f2', 'Noted (position 2, task_id: task_5a73def8).', 4),
        call('d1', 'mcp__ccd_session__dismiss_task', { task_id: 'task_40d57447', reason: 'Fixed on main.' }, 5),
        result('d1', 'Withdrawn.', 6),
        // a withdrawal of something this log never suggested changes nothing
        call('d2', 'mcp__ccd_session__dismiss_task', { task_id: 'task_nope' }, 7)
      ])
    )
    const calls = parseClaudeMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[0]).toMatchObject({
      artifact: { kind: 'follow-up', title: 'Fix the cache race', summary: 'Seen in the logs.', taskId: 'task_40d57447', dismissed: 'Fixed on main.' }
    })
    expect(calls[1]!.artifact).toMatchObject({ taskId: 'task_5a73def8' })
    expect(calls[1]!.artifact).not.toHaveProperty('dismissed')
    expect(calls[2]!.artifact).toBeUndefined()
    // each row reads as what it did
    expect(calls.map((c) => c.preview)).toEqual(['Fix the cache race', 'Drop the dead flag', 'Fixed on main.', 'withdrew a suggestion'])
  })
})

describe('work agents keep outside their own log', () => {
  const dir = join(root, 'beside')
  const at = (s: number): string => `2026-09-02T10:00:${String(s).padStart(2, '0')}Z`

  /** A Claude session that hands work to a subagent, and the subagent's own log. */
  function claudeWithSubagent(name: string, opts: { result: boolean; agentId?: string }): string {
    const proj = join(dir, 'claude', name)
    const sub = join(proj, 'sess-1', 'subagents')
    mkdirSync(sub, { recursive: true })
    const file = join(proj, 'sess-1.jsonl')
    const agentCall = { type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Fix the parser', prompt: 'go', subagent_type: 'general-purpose' } }
    writeFileSync(
      file,
      jsonl([
        { type: 'user', message: { role: 'user', content: 'delegate it' }, timestamp: at(0) },
        { type: 'assistant', message: { role: 'assistant', content: [agentCall] }, timestamp: at(1) },
        ...(opts.result
          ? [
              {
                type: 'user',
                message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'Fixed both files.' }] },
                toolUseResult: { status: 'completed', agentId: opts.agentId ?? 'a1b2', content: [] },
                timestamp: at(9)
              }
            ]
          : []),
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The subagent is done.' }] }, timestamp: at(10) }
      ])
    )
    writeFileSync(join(sub, 'agent-a1b2.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Fix the parser', toolUseId: 'ag1', spawnDepth: 1 }))
    writeFileSync(
      join(sub, 'agent-a1b2.jsonl'),
      jsonl([
        { type: 'user', isSidechain: true, agentId: 'a1b2', message: { role: 'user', content: 'go' }, timestamp: at(2) },
        {
          type: 'assistant',
          isSidechain: true,
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/r/a.ts' } },
              { type: 'tool_use', id: 's2', name: 'Edit', input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } },
              { type: 'tool_use', id: 's3', name: 'TodoWrite', input: { todos: [{ content: 'its own list', status: 'pending' }] } }
            ]
          },
          timestamp: at(3)
        },
        {
          type: 'user',
          isSidechain: true,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's2', content: 'ok' }] },
          timestamp: at(4)
        },
        {
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 's4', name: 'Write', input: { file_path: '/r/b.ts', content: 'x\n' } }] },
          timestamp: at(5)
        },
        {
          type: 'user',
          isSidechain: true,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's4', content: 'denied', is_error: true }] },
          timestamp: at(6)
        }
      ])
    )
    return file
  }

  it('claude: a subagent’s edits follow the call’s result, in its order and with its times', () => {
    const msgs = parseClaudeMessages(claudeWithSubagent('done', { result: true }))
    expect(msgs.map((m) => `${m.kind}:${m.toolName ?? m.text}`)).toEqual([
      'text:delegate it',
      'tool_call:Agent',
      'tool_result:Fixed both files.',
      'tool_call:Edit',
      'tool_call:Write',
      'text:The subagent is done.'
    ])
    expect(msgs[1]).toMatchObject({ preview: 'Fix the parser' })
    expect(msgs[1].artifact).toBeUndefined()
    expect(msgs[3]).toMatchObject({ preview: '/r/a.ts', ts: Date.parse(at(3)), artifact: { kind: 'edits', files: [{ path: '/r/a.ts' }] } })
    // refused inside the subagent: shown, and marked as never landing
    expect(msgs[4]).toMatchObject({ failed: true, artifact: { kind: 'edits', files: [{ path: '/r/b.ts', change: 'write' }] } })
  })

  it('claude: a subagent still running is found by its meta file, its edits after the call', () => {
    const msgs = parseClaudeMessages(claudeWithSubagent('running', { result: false }))
    expect(msgs.map((m) => m.toolName ?? m.kind)).toEqual(['text', 'Agent', 'Edit', 'Write', 'text'])
  })

  it('claude: an agent id that would leave the directory is not followed', () => {
    // `agent-../../x.jsonl` joins to `subagents/x.jsonl`: a log sits there to be found
    const file = claudeWithSubagent('escape', { result: true, agentId: '../../x' })
    const sub = join(dir, 'claude', 'escape', 'sess-1', 'subagents')
    renameSync(join(sub, 'agent-a1b2.jsonl'), join(sub, 'x.jsonl'))
    rmSync(join(sub, 'agent-a1b2.meta.json'))
    expect(parseClaudeMessages(file).map((m) => m.toolName ?? m.kind)).toEqual(['text', 'Agent', 'tool_result', 'text'])
  })

  it('claude: a session without subagents reads as it did', () => {
    const file = claudeWithSubagent('gone', { result: true })
    rmSync(join(dir, 'claude', 'gone', 'sess-1'), { recursive: true })
    expect(parseClaudeMessages(file).map((m) => m.toolName ?? m.kind)).toEqual(['text', 'Agent', 'tool_result', 'text'])
  })

  /** A Copilot session directory: its log, and whatever else the test puts beside it. */
  function copilotSession(id: string, events: unknown[]): { sdir: string; file: string } {
    const sdir = join(dir, 'copilot', 'session-state', id)
    mkdirSync(join(sdir, 'files'), { recursive: true })
    const file = join(sdir, 'events.jsonl')
    writeFileSync(file, jsonl(events))
    return { sdir, file }
  }
  const call = (id: string, toolName: string, args: unknown, s: number): unknown => ({
    type: 'tool.execution_start',
    data: { toolCallId: id, toolName, arguments: args },
    timestamp: at(s)
  })
  const done = (id: string, success: boolean, s: number): unknown => ({
    type: 'tool.execution_complete',
    data: { toolCallId: id, success },
    timestamp: at(s)
  })

  it('copilot: the plan asked for is its plan file as written then, not the summary', () => {
    const sdir = join(dir, 'copilot', 'session-state', 'plan-1')
    const plan = join(sdir, 'plan.md')
    const { file } = copilotSession('plan-1', [
      call('c1', 'create', { path: plan, file_text: '# Ship it\n\n1. one\n2. two\n' }, 1),
      call('c2', 'exit_plan_mode', { summary: 'Two steps' }, 2),
      call('c3', 'edit', { path: plan, old_str: '2. two', new_str: '2. two, tested' }, 3),
      call('c4', 'exit_plan_mode', { summary: 'Two steps, tested' }, 4),
      // a later check-off in the file is progress, not the plan that was approved
      call('c5', 'edit', { path: plan, old_str: '1. one', new_str: '1. one ✅' }, 5),
      call('c6', 'edit', { path: '/r/a.ts', old_str: 'a', new_str: 'b' }, 6)
    ])
    const calls = parseCopilotMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[1].artifact).toEqual({ kind: 'plan', text: '# Ship it\n\n1. one\n2. two' })
    expect(calls[3].artifact).toEqual({ kind: 'plan', text: '# Ship it\n\n1. one\n2. two, tested' })
    // writing the plan is not an edit of the repo
    for (const i of [0, 2, 4]) expect(calls[i].artifact).toBeUndefined()
    expect(calls[5]).toMatchObject({ artifact: { kind: 'edits', files: [{ path: '/r/a.ts' }] } })
  })

  it('copilot: a plan the log cannot follow is read from the file (files/plan.md too)', () => {
    const { sdir, file } = copilotSession('plan-2', [
      // the creation is older than what was read; this edit's passage isn't known
      call('c1', 'edit', { path: '/elsewhere/session-state/plan-2/files/plan.md', old_str: 'x', new_str: 'y' }, 1),
      call('c2', 'exit_plan_mode', { summary: 'The summary' }, 2)
    ])
    writeFileSync(join(sdir, 'files', 'plan.md'), '# From the file\n')
    const calls = parseCopilotMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[1].artifact).toEqual({ kind: 'plan', text: '# From the file' })
    expect(calls[0].artifact).toBeUndefined()
  })

  it('copilot: a question asks until the log records its answer', () => {
    const question = { question: 'Which of these should I fix?', choices: ['All of them', 'Only #2'] }
    const waiting = copilotSession('ask-1', [call('q1', 'ask_user', question, 1)])
    const [asked] = parseCopilotMessages(waiting.file)
    expect(asked).toMatchObject({
      kind: 'tool_call',
      toolName: 'ask_user',
      preview: 'Which of these should I fix?',
      asks: [{ question: 'Which of these should I fix?', options: [{ label: 'All of them' }, { label: 'Only #2' }] }]
    })
    // answered where it was asked: no result row follows, so the call itself stops asking
    const answered = copilotSession('ask-2', [call('q1', 'ask_user', question, 1), done('q1', true, 2)])
    const [row] = parseCopilotMessages(answered.file)
    expect(row).toMatchObject({ toolName: 'ask_user', preview: 'Which of these should I fix?' })
    expect(row.asks).toBeUndefined()
  })

  it('copilot: with no plan file anywhere, the summary is still the plan', () => {
    const { file } = copilotSession('plan-3', [call('c1', 'exit_plan_mode', { summary: 'Only a summary' }, 1)])
    expect(parseCopilotMessages(file)[0].artifact).toEqual({ kind: 'plan', text: 'Only a summary' })
  })

  it('copilot: a draft plan with no approval asked yet rides the row that wrote it', () => {
    const sdir = join(dir, 'copilot', 'session-state', 'plan-4')
    const { file } = copilotSession('plan-4', [
      call('c1', 'create', { path: join(sdir, 'plan.md'), file_text: '# Draft\n' }, 1),
      call('c2', 'view', { path: join(sdir, 'plan.md') }, 2)
    ])
    const calls = parseCopilotMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls[0].artifact).toEqual({ kind: 'plan', text: '# Draft' })
    expect(calls[1].artifact).toBeUndefined()
  })

  /** Copilot's own schema for the table, as its CLI creates it. */
  function todoDb(sdir: string, rows: ReadonlyArray<readonly [string, string]>): void {
    const db = new DatabaseSync(join(sdir, 'session.db'))
    db.exec(
      "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked')))"
    )
    const insert = db.prepare('INSERT INTO todos (id, title, status) VALUES (?, ?, ?)')
    rows.forEach(([title, status], i) => insert.run(`t${i}`, title, status))
    db.close()
  }

  it('copilot: the to-do table as it stands rides the call that last changed it', () => {
    const { sdir, file } = copilotSession('todos-1', [
      call('q1', 'sql', { description: 'Plan the work', query: "INSERT INTO todos (id, title) VALUES ('a', 'Read'), ('b', 'Write')" }, 1),
      call('q2', 'sql', { description: 'Look', query: 'SELECT * FROM todos' }, 2),
      call('q3', 'sql', { description: 'Advance', query: "UPDATE todos SET status = 'done' WHERE id = 'a'" }, 3),
      done('q3', true, 4),
      // a change that failed is not where the list stands
      call('q4', 'sql', { description: 'Oops', query: 'UPDATE todos SET nope = 1' }, 5),
      done('q4', false, 6),
      call('q5', 'sql', { description: 'Scratch', query: 'INSERT INTO notes VALUES (1)' }, 7)
    ])
    todoDb(sdir, [
      ['Read', 'done'],
      ['Write', 'in_progress'],
      ['Ship', 'blocked'],
      ['Tell', 'pending']
    ])
    const calls = parseCopilotMessages(file).filter((m) => m.kind === 'tool_call')
    expect(calls.map((m) => m.preview)).toEqual(['Plan the work', 'Look', 'Advance', 'Oops', 'Scratch'])
    expect(calls[2].artifact).toEqual({
      kind: 'todos',
      items: [
        { text: 'Read', status: 'completed' },
        { text: 'Write', status: 'in_progress' },
        { text: 'Ship', status: 'blocked' },
        { text: 'Tell', status: 'pending' }
      ]
    })
    for (const i of [0, 1, 3, 4]) expect(calls[i].artifact).toBeUndefined()
  })

  it('copilot: a table that cannot be read leaves the queries plain', () => {
    const { sdir, file } = copilotSession('todos-2', [
      call('q1', 'sql', { description: 'Plan', query: "INSERT INTO todos (id, title) VALUES ('a', 'Read')" }, 1)
    ])
    // no db at all
    expect(parseCopilotMessages(file)[0].artifact).toBeUndefined()
    // a db without the table
    new DatabaseSync(join(sdir, 'session.db')).close()
    expect(parseCopilotMessages(file)[0].artifact).toBeUndefined()
    // not a database
    writeFileSync(join(sdir, 'session.db'), 'garbage')
    expect(parseCopilotMessages(file)[0].artifact).toBeUndefined()
  })
})

describe('gemini parser', () => {
  const home = join(root, 'gemini')
  const chats = join(home, 'tmp', 'myrepo', 'chats')
  const sessionId = 'abcd1234-0000-4000-8000-000000000001'
  const t = (m: number): string => `2026-09-01T10:${String(m).padStart(2, '0')}:00.000Z`
  const preamble = {
    id: 'm0',
    timestamp: t(0),
    type: 'user',
    content: [{ text: '<session_context>\nThis is the Gemini CLI.\n- **Workspace Directories:**\n  - /elsewhere\n' }]
  }

  beforeAll(() => {
    mkdirSync(chats, { recursive: true })
    writeFileSync(join(home, 'tmp', 'myrepo', '.project_root'), '/Users/me/dev/myrepo\n')
    writeFileSync(
      join(chats, 'session-2026-09-01T10-00-abcd1234.jsonl'),
      jsonl([
        { sessionId, projectHash: 'h', startTime: t(0), lastUpdated: t(0), kind: 'main' },
        { $set: { messages: [preamble] } },
        { id: 'm1', timestamp: t(1), type: 'user', content: [{ text: 'fix the flaky test' }] },
        { id: 'm2', timestamp: t(2), type: 'gemini', content: [{ text: '' }], thoughts: [] },
        // the same reply again, now with its reasoning and tool call — it replaces the first
        {
          id: 'm2',
          timestamp: t(2),
          type: 'gemini',
          content: [{ text: 'Running the tests.' }],
          thoughts: [{ subject: 'Planning', description: 'run them first', timestamp: t(2) }],
          toolCalls: [
            {
              id: 'c1',
              name: 'run_shell_command',
              args: { command: 'npm test' },
              status: 'success',
              timestamp: t(3),
              result: [
                {
                  functionResponse: {
                    id: 'c1',
                    name: 'run_shell_command',
                    response: { output: 'Command: npm test\nOutput: Tests  1 failed | 4 passed\nExit Code: 1' }
                  }
                }
              ]
            }
          ]
        },
        {
          id: 'm3',
          timestamp: t(4),
          type: 'gemini',
          content: 'Fixed the race.',
          toolCalls: [
            {
              id: 'c2',
              name: 'replace',
              args: { file_path: '/Users/me/dev/myrepo/a.ts', old_string: 'await a\n', new_string: 'await b\n' },
              status: 'error',
              timestamp: t(4),
              resultDisplay: 'Failed to edit: 0 occurrences found'
            }
          ]
        },
        { $set: { summary: 'Fix the flaky test', lastUpdated: t(5) } },
        { id: 'm4', timestamp: t(6), type: 'user', content: [{ text: 'this prompt was rewound' }] },
        { $rewindTo: 'm4' },
        { id: 'm5', timestamp: t(7), type: 'info', content: 'Request cancelled.' }
      ]) + 'not json at all\n'
    )
    // an older CLI's one-document log, its directory named only in projects.json
    const legacy = join(home, 'tmp', 'other', 'chats')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(home, 'projects.json'), JSON.stringify({ projects: { '/Users/me/dev/other': 'other' } }))
    writeFileSync(
      join(legacy, 'session-2026-08-01T09-00-legacy01.json'),
      JSON.stringify({
        sessionId: 'legacy-0001',
        projectHash: 'h2',
        startTime: '2026-08-01T09:00:00.000Z',
        lastUpdated: '2026-08-01T09:05:00.000Z',
        messages: [
          { id: 'a', timestamp: '2026-08-01T09:00:00.000Z', type: 'user', content: 'explain the build' },
          { id: 'b', timestamp: '2026-08-01T09:01:00.000Z', type: 'gemini', content: [{ text: 'It uses vite.' }] }
        ]
      })
    )
    // a session where nothing was said: the context preamble and a slash command
    writeFileSync(
      join(legacy, 'session-2026-08-02T09-00-quiet001.jsonl'),
      jsonl([
        { sessionId: 'quiet-0001', projectHash: 'h2', startTime: t(0), lastUpdated: t(0) },
        preamble,
        { id: 'q', timestamp: t(1), type: 'user', content: [{ text: '/model' }] }
      ])
    )
    // a subagent's log, one directory deeper, and a file that is not a session at all
    mkdirSync(join(chats, sessionId), { recursive: true })
    writeFileSync(
      join(chats, sessionId, 'sub-1.jsonl'),
      jsonl([{ sessionId: 'sub-1', projectHash: 'h', kind: 'subagent' }, { id: 'x', type: 'user', content: 'hi' }])
    )
    writeFileSync(join(chats, 'session-broken.jsonl'), '{"sessionId": "broken"')
  })

  it('lists the sessions a person had, and none of the rest', () => {
    const ids = listGeminiSessions(home, 'gemini-default').map((m) => m.id).sort()
    expect(ids).toEqual([`gemini:${sessionId}`, 'gemini:legacy-0001'])
  })

  it('reads the title, the directory and the span off the log', () => {
    const meta = parseGeminiMeta(join(chats, 'session-2026-09-01T10-00-abcd1234.jsonl'), 'gemini-default')!
    expect(meta).toMatchObject({
      id: `gemini:${sessionId}`,
      provider: 'gemini',
      nativeId: sessionId,
      source: 'gemini-default',
      title: 'Fix the flaky test',
      cwd: '/Users/me/dev/myrepo',
      logBranch: null,
      startedAt: Date.parse(t(0)),
      updatedAt: Date.parse(t(5)),
      // the rewound prompt is gone, the preamble and the info line never counted
      messageCount: 3
    })
    const legacy = listGeminiSessions(home, 'g').find((m) => m.id === 'gemini:legacy-0001')!
    expect(legacy).toMatchObject({ title: 'explain the build', cwd: '/Users/me/dev/other', messageCount: 2 })
  })

  it('turns the replayed records into the conversation', () => {
    const rows = parseGeminiMessages(join(chats, 'session-2026-09-01T10-00-abcd1234.jsonl'))
    expect(rows.map((r) => [r.role, r.kind, r.toolName ?? r.text])).toEqual([
      ['user', 'text', 'fix the flaky test'],
      ['assistant', 'reasoning', 'Planning: run them first'],
      ['assistant', 'text', 'Running the tests.'],
      ['assistant', 'tool_call', 'run_shell_command'],
      ['tool', 'tool_result', 'Command: npm test Output: Tests 1 failed | 4 passed Exit Code: 1'],
      ['assistant', 'text', 'Fixed the race.'],
      ['assistant', 'tool_call', 'replace'],
      ['tool', 'tool_result', 'Failed to edit: 0 occurrences found'],
      ['system', 'system', 'Request cancelled.']
    ])
    const shell = rows[3]!
    expect(shell.preview).toBe('npm test')
    expect(shell.artifact).toMatchObject({ kind: 'check', checks: ['tests'], status: 'failed', exitCode: 1 })
    const edit = rows[6]!
    expect(edit.failed).toBe(true)
    expect(edit.artifact).toMatchObject({ kind: 'edits', files: [{ path: '/Users/me/dev/myrepo/a.ts', change: 'edit' }] })
  })

  it('reads an older one-document log whole', () => {
    const rows = parseGeminiMessages(join(home, 'tmp', 'other', 'chats', 'session-2026-08-01T09-00-legacy01.json'))
    expect(rows.map((r) => r.text)).toEqual(['explain the build', 'It uses vite.'])
  })

  // a document is cut at the meta read's 256KB like any log, and a cut document does not
  // parse: every older session longer than that was left out of the index
  it('lists an older one-document log longer than the meta head', () => {
    const big = join(root, 'gemini-big')
    const dir = join(big, 'tmp', 'bigrepo', 'chats')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(big, 'tmp', 'bigrepo', '.project_root'), '/Users/me/dev/bigrepo\n')
    const file = join(dir, 'session-2026-08-03T09-00-bigdoc01.json')
    writeFileSync(
      file,
      JSON.stringify({
        sessionId: 'bigdoc-0001',
        projectHash: 'h3',
        startTime: '2026-08-03T09:00:00.000Z',
        lastUpdated: '2026-08-03T09:30:00.000Z',
        messages: [
          { id: 'a', timestamp: '2026-08-03T09:00:00.000Z', type: 'user', content: 'summarize this log' },
          { id: 'b', timestamp: '2026-08-03T09:01:00.000Z', type: 'gemini', content: [{ text: 'x'.repeat(400 * 1024) }] },
          { id: 'c', timestamp: '2026-08-03T09:02:00.000Z', type: 'user', content: 'and the errors?' }
        ]
      })
    )
    expect(parseGeminiMeta(file, 'gemini-default')).toMatchObject({
      id: 'gemini:bigdoc-0001',
      title: 'summarize this log',
      cwd: '/Users/me/dev/bigrepo',
      startedAt: Date.parse('2026-08-03T09:00:00.000Z'),
      updatedAt: Date.parse('2026-08-03T09:30:00.000Z'),
      messageCount: 3
    })
    expect(listGeminiSessions(big, 'gemini-default').map((m) => m.id)).toEqual(['gemini:bigdoc-0001'])
  })
})

describe('cline family parser', () => {
  const cline = join(root, 'cline')
  const roo = join(root, 'roo')
  const task = '1756700000000'
  const env = (cwd: string): string =>
    JSON.stringify({ request: `<task>\nx\n</task>\n<environment_details>\n# Current Working Directory (${cwd}) Files\n` })
  const say = (ts: number, kind: string, text: string, extra: object = {}) => ({ ts, type: 'say', say: kind, text, ...extra })
  const ask = (ts: number, kind: string, text: string) => ({ ts, type: 'ask', ask: kind, text })
  const T = 1756700000000

  beforeAll(() => {
    mkdirSync(join(cline, 'tasks', task), { recursive: true })
    mkdirSync(join(cline, 'state'), { recursive: true })
    writeFileSync(
      join(cline, 'state', 'taskHistory.json'),
      JSON.stringify([{ id: task, ts: T + 60_000, task: 'add a login page', cwdOnTaskInitialization: '/Users/me/dev/web' }])
    )
    writeFileSync(
      join(cline, 'tasks', task, 'ui_messages.json'),
      JSON.stringify([
        say(T, 'text', 'add a login page'),
        say(T + 1, 'api_req_started', env('/somewhere/else')),
        say(T + 2, 'checkpoint_created', ''),
        say(T + 3, 'reasoning', 'Needs a form and a route'),
        say(T + 4, 'text', "I'll create the page."),
        ask(T + 5, 'tool', JSON.stringify({ tool: 'newFileCreated', path: 'src/login.tsx', content: 'export const Login = () => null\n' })),
        say(T + 6, 'tool', JSON.stringify({ tool: 'readFile', path: 'src/app.tsx', content: '/Users/me/dev/web/src/app.tsx' })),
        say(T + 7, 'tool', JSON.stringify({ tool: 'searchFiles', path: 'src', regex: 'Route', content: 'Found 2 results.' })),
        ask(
          T + 8,
          'tool',
          JSON.stringify({ tool: 'editedExistingFile', path: 'src/app.tsx', content: '------- SEARCH\n<Home />\n=======\n<Login />\n+++++++ REPLACE' })
        ),
        say(T + 9, 'diff_error', 'src/app.tsx'),
        ask(T + 10, 'command', 'npm testREQ_APP'),
        ask(T + 11, 'command_output', 'FAIL src/login.test.tsx\n'),
        say(T + 12, 'checkpoint_created', ''),
        ask(T + 13, 'command_output', 'Tests: 1 failed, 3 passed\n'),
        say(T + 14, 'task_progress', '- [x] Create the page\n- [ ] Wire the route'),
        ask(T + 15, 'followup', JSON.stringify({ question: 'Keep the old route?', options: ['Yes', 'No'] })),
        say(T + 16, 'user_feedback', 'no — and add a logout'),
        say(T + 17, 'completion_result', 'Done — login and logout added.'),
        ask(T + 18, 'completion_result', '')
      ])
    )
    // no history entry: the directory comes off the first request's environment block
    const bare = join(cline, 'tasks', '1756800000000')
    mkdirSync(bare, { recursive: true })
    writeFileSync(
      join(bare, 'ui_messages.json'),
      JSON.stringify([say(T + 100, 'text', 'tidy the readme'), say(T + 101, 'api_req_started', env('/Users/me/dev/docs'))])
    )
    // a task that only ever started, and one cut off mid-write
    const idle = join(cline, 'tasks', '1756900000000')
    mkdirSync(idle, { recursive: true })
    writeFileSync(join(idle, 'ui_messages.json'), JSON.stringify([say(T + 200, 'api_req_started', env('/x'))]))
    const cut = join(cline, 'tasks', '1757000000000')
    mkdirSync(cut, { recursive: true })
    writeFileSync(join(cut, 'ui_messages.json'), '[{"ts":1757000000000,"type":"say","say":"text","text":"half a')

    // Roo Code: its own history item beside each task, and its SEARCH/REPLACE dialect
    const rtask = join(roo, 'tasks', '9fcb6803-3ba1-4202-bf96-0f076f5ff149')
    mkdirSync(rtask, { recursive: true })
    writeFileSync(
      join(rtask, 'history_item.json'),
      JSON.stringify({ id: '9fcb6803-3ba1-4202-bf96-0f076f5ff149', task: 'bump the config', ts: T + 5_000, workspace: '/Users/me/dev/api', parentTaskId: 'parent-1' })
    )
    writeFileSync(
      join(rtask, 'ui_messages.json'),
      JSON.stringify([
        say(T, 'text', 'bump the config'),
        ask(T + 1, 'tool', JSON.stringify({ tool: 'updateTodoList', todos: [{ id: 'a', content: 'Bump it', status: 'in_progress' }] })),
        ask(
          T + 2,
          'tool',
          JSON.stringify({ tool: 'appliedDiff', path: 'package.json', diff: '<<<<<<< SEARCH\n:start_line:3\n-------\n"version": "1.0.0"\n=======\n"version": "1.1.0"\n>>>>>>> REPLACE' })
        ),
        say(T + 3, 'completion_result', 'Bumped.')
      ])
    )
  })

  it('lists every task with its title, directory and span', () => {
    const metas = listClineSessions(cline, 'cline-vscode')
    expect(metas.map((m) => m.id).sort()).toEqual(['cline:1756700000000', 'cline:1756800000000'])
    expect(metas.find((m) => m.nativeId === task)).toMatchObject({
      provider: 'cline',
      source: 'cline-vscode',
      title: 'add a login page',
      // the history's record of the directory beats the environment block
      cwd: '/Users/me/dev/web',
      startedAt: T,
      updatedAt: T + 18,
      // the task, the reply, the feedback and the result; the question is a question
      messageCount: 5
    })
    expect(metas.find((m) => m.nativeId === '1756800000000')?.cwd).toBe('/Users/me/dev/docs')
  })

  it('reads a Roo Code task, its parent and its edits', () => {
    const [meta] = listClineSessions(roo, 'roo-vscode', 'roo')
    expect(meta).toMatchObject({
      id: 'roo:9fcb6803-3ba1-4202-bf96-0f076f5ff149',
      provider: 'roo',
      title: 'bump the config',
      cwd: '/Users/me/dev/api',
      parentId: 'roo:parent-1'
    })
    const rows = parseClineMessages(meta!.sourcePath)
    expect(rows[1]!.artifact).toEqual({ kind: 'todos', items: [{ text: 'Bump it', status: 'in_progress' }] })
    expect(rows[2]!.artifact).toMatchObject({
      kind: 'edits',
      files: [{ path: 'package.json', change: 'edit', hunks: [[{ op: 'del', text: '"version": "1.0.0"' }, { op: 'add', text: '"version": "1.1.0"' }]] }]
    })
  })

  it('turns the panel into the conversation, gathering a command’s output onto one result', () => {
    const rows = parseClineMessages(join(cline, 'tasks', task, 'ui_messages.json'))
    expect(rows.map((r) => [r.role, r.kind, r.toolName ?? r.text])).toEqual([
      ['user', 'text', 'add a login page'],
      ['assistant', 'reasoning', 'Needs a form and a route'],
      ['assistant', 'text', "I'll create the page."],
      ['assistant', 'tool_call', 'newFileCreated'],
      ['assistant', 'tool_call', 'readFile'],
      ['assistant', 'tool_call', 'searchFiles'],
      ['tool', 'tool_result', 'Found 2 results.'],
      ['assistant', 'tool_call', 'editedExistingFile'],
      ['system', 'system', 'Edit did not apply: src/app.tsx'],
      ['assistant', 'tool_call', 'execute_command'],
      ['tool', 'tool_result', 'FAIL src/login.test.tsx Tests: 1 failed, 3 passed'],
      ['assistant', 'tool_call', 'task_progress'],
      ['assistant', 'text', 'Keep the old route?\n\n- Yes\n- No'],
      ['user', 'text', 'no — and add a logout'],
      ['assistant', 'text', 'Done — login and logout added.']
    ])
    expect(rows[3]!.artifact).toMatchObject({ kind: 'edits', files: [{ path: 'src/login.tsx', change: 'add' }] })
    expect(rows[4]!.preview).toBe('src/app.tsx')
    expect(rows[5]!.preview).toBe('Route in src')
    expect(rows[7]).toMatchObject({ failed: true, artifact: { kind: 'edits', files: [{ path: 'src/app.tsx' }] } })
    expect(rows[9]).toMatchObject({ preview: 'npm test', artifact: { kind: 'check', checks: ['tests'], status: 'failed' } })
    expect(rows[11]!.artifact).toEqual({
      kind: 'todos',
      items: [
        { text: 'Create the page', status: 'completed' },
        { text: 'Wire the route', status: 'pending' }
      ]
    })
  })

  it('reads the newest messages of a log too large to read whole, past a message larger than the budget', () => {
    const dir = join(cline, 'tasks', '1757100000000')
    mkdirSync(dir, { recursive: true })
    // six older messages under the per-message cap, more than the budget together
    const filler = 'x'.repeat(900 * 1024)
    const old = Array.from({ length: 6 }, (_, i) => say(T + i, 'text', `${i === 0 ? 'the task' : 'old reply'} ${filler}`))
    writeFileSync(
      join(dir, 'ui_messages.json'),
      JSON.stringify([
        ...old,
        // a request carrying whole files: bookkeeping, and bigger than the transcript budget
        say(T + 10, 'api_req_started', 'y'.repeat(5 * 1024 * 1024)),
        say(T + 11, 'text', 'z'.repeat(1_500_000)),
        say(T + 12, 'completion_result', 'All done.')
      ])
    )
    const rows = parseClineMessages(join(dir, 'ui_messages.json'))
    expect(rows[0]!.text).toMatch(/older messages omitted/)
    // read from mid-log, the first message left is a reply, never mistaken for the task
    expect(rows.filter((r) => r.role === 'user')).toEqual([])
    expect(rows.filter((r) => r.text.startsWith('old reply')).length).toBeGreaterThan(0)
    expect(rows.slice(-2).map((r) => [r.role, r.text])).toEqual([
      ['assistant', '(message too large to show)'],
      ['assistant', 'All done.']
    ])
  })
})

describe('cursor parser', () => {
  const home = join(root, 'cursor')
  const id = '73aa8a10-b663-4607-8992-e626d22d22e6'
  const dir = join(home, 'projects', 'Users-me-dev-web', 'agent-transcripts', id)
  const user = (text: string) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })

  beforeAll(() => {
    mkdirSync(join(dir, 'subagents'), { recursive: true })
    writeFileSync(
      join(dir, `${id}.jsonl`),
      jsonl([
        user('<timestamp>Wednesday, Aug 19, 2026, 12:56 AM (UTC+3)</timestamp>\n<user_query>\nwhy can customers not sign in?\n</user_query>'),
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: "I'll trace the sign-in flow.\n\n[REDACTED]" },
              { type: 'tool_use', name: 'Read', input: { path: '/Users/me/dev/web/src/auth.ts' } },
              { type: 'tool_use', name: 'Glob', input: { glob_pattern: '**/*sign*' } }
            ]
          }
        },
        { role: 'assistant', message: { content: [{ type: 'text', text: '[REDACTED]' }] } },
        {
          role: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'StrReplace', input: { path: '/Users/me/dev/web/src/auth.ts', old_string: 'false', new_string: 'true' } },
              { type: 'tool_use', name: 'Shell', input: { command: 'npm run typecheck' } }
            ]
          }
        },
        { role: 'assistant', message: { content: [{ type: 'text', text: 'The allow-list was empty.' }] } },
        { type: 'turn_ended', status: 'success' },
        user('<user_query>thanks</user_query>'),
        { type: 'turn_ended', status: 'error', error: 'User aborted request' }
      ])
    )
    writeFileSync(join(dir, 'subagents', 'sub.jsonl'), jsonl([user('<user_query>sub</user_query>')]))
    // a transcript where the agent never answered and nothing was asked
    const empty = join(home, 'projects', 'Users-me-dev-web', 'agent-transcripts', 'empty-1')
    mkdirSync(empty, { recursive: true })
    writeFileSync(join(empty, 'empty-1.jsonl'), jsonl([{ type: 'turn_ended', status: 'error', error: 'no model' }]))
  })

  it('names the workspace the way Cursor does, and finds it again', () => {
    expect(cursorSlug('/Users/jane.doe/.cursor/worktrees/app/v96w')).toBe('Users-jane-doe-cursor-worktrees-app-v96w')
    // from the paths the agent used
    expect(resolveCursorSlug('Users-me-dev-web', ['/Users/me/dev/web/src/auth.ts'])).toBe('/Users/me/dev/web')
    // from the disk, when the agent named none: a real directory with a dot in its name
    const real = join(root, 'cursor-ws', 'my.project')
    mkdirSync(real, { recursive: true })
    expect(resolveCursorSlug(cursorSlug(real))).toBe(real)
    expect(resolveCursorSlug('nowhere-that-exists-at-all-0f3a')).toBeNull()
  })

  it('reads the time the opening query carries', () => {
    expect(cursorQueryTime('<timestamp>Wednesday, Aug 19, 2026, 12:56 AM (UTC+3)</timestamp>')).toBe(
      Date.parse('2026-08-18T21:56:00Z')
    )
    expect(cursorQueryTime('<timestamp>Monday, Sep 7, 2026, 3:05 PM (UTC-4:30)</timestamp>')).toBe(
      Date.parse('2026-09-07T19:35:00Z')
    )
    expect(cursorQueryTime('no time here')).toBeNull()
  })

  it('lists the transcripts with a conversation in them', () => {
    const metas = listCursorSessions(home, 'cursor-default')
    expect(metas).toHaveLength(1)
    expect(metas[0]).toMatchObject({
      id: `cursor:${id}`,
      provider: 'cursor',
      title: 'why can customers not sign in?',
      cwd: '/Users/me/dev/web',
      startedAt: Date.parse('2026-08-18T21:56:00Z'),
      messageCount: 6
    })
  })

  it('turns the transcript into the conversation, hidden reasoning left out', () => {
    const rows = parseCursorMessages(join(dir, `${id}.jsonl`))
    expect(rows.map((r) => [r.role, r.kind, r.toolName ?? r.text])).toEqual([
      ['user', 'text', 'why can customers not sign in?'],
      ['assistant', 'text', "I'll trace the sign-in flow."],
      ['assistant', 'tool_call', 'Read'],
      ['assistant', 'tool_call', 'Glob'],
      ['assistant', 'tool_call', 'StrReplace'],
      ['assistant', 'tool_call', 'Shell'],
      ['assistant', 'text', 'The allow-list was empty.'],
      ['user', 'text', 'thanks'],
      ['system', 'system', 'Turn ended: User aborted request']
    ])
    expect(rows[2]!.preview).toBe('/Users/me/dev/web/src/auth.ts')
    expect(rows[3]!.preview).toBe('**/*sign*')
    expect(rows[4]!.artifact).toMatchObject({ kind: 'edits', files: [{ path: '/Users/me/dev/web/src/auth.ts' }] })
    expect(rows[5]!.artifact).toMatchObject({ kind: 'check', checks: ['types'] })
  })
})

describe('cursor parser — the conversations its ACP server keeps', () => {
  const home = join(root, 'cursor-acp')
  const id = '725e2579-ff14-4351-85d6-51a6c8c36463'
  const created = Date.parse('2026-09-27T22:15:58Z')
  const query = (text: string) => ({
    role: 'user',
    content: [{ type: 'text', text: `<timestamp>Monday, Sep 28, 2026, 1:16 AM (UTC+3)</timestamp>\n<user_query>\n${text}\n</user_query>` }]
  })
  const call = (callId: string, toolName: string, args: object) => ({ type: 'tool-call', toolCallId: callId, toolName, args })
  const result = (callId: string, text: string, isError = false) => ({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: callId, toolName: 'x', result: text }],
    providerOptions: { cursor: { highLevelToolCallResult: { isError } } }
  })
  let file = ''

  beforeAll(() => {
    file = writeCursorAcpSession(home, {
      id,
      cwd: '/Users/me/dev/web',
      name: 'Sign-in fix',
      created,
      stale: [query('a draft of the question, from an earlier root')],
      messages: [
        { role: 'system', content: 'You are an AI coding assistant.' },
        { role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' },
        query('why can customers not sign in?'),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '', signature: 'opaque' },
            { type: 'text', text: 'Reading the auth module.' },
            call('c1', 'Read', { path: 'auth.ts' }),
            call('c2', 'Shell', { command: 'npm run typecheck' })
          ]
        },
        result('c1', 'Error: File not found', true),
        result('c2', 'Exit code: 2\n\nCommand output:\n\n```\nsrc/auth.ts(3,1): error TS2304: Cannot find name x.\n```'),
        { role: 'assistant', content: [{ type: 'text', text: 'The allow-list was empty.' }] }
      ]
    })
    // a folder the server made but never wrote a conversation into
    mkdirSync(join(home, 'acp-sessions', 'empty'), { recursive: true })
  })

  it('lists the conversation under its own id, named and placed as Cursor keeps it', () => {
    const metas = listCursorSessions(home, 'cursor-default')
    expect(metas).toEqual([
      expect.objectContaining({
        id: `cursor:${id}`,
        nativeId: id,
        provider: 'cursor',
        title: 'Sign-in fix',
        cwd: '/Users/me/dev/web',
        startedAt: created,
        // the person's question and two replies — not the context Cursor opens with
        messageCount: 3,
        sourcePath: file
      })
    ])
  })

  it('reads the conversation in the order its root lists, results joined to their calls', () => {
    const rows = parseCursorMessages(file)
    expect(rows.map((r) => [r.role, r.kind, r.toolName ?? r.text])).toEqual([
      ['user', 'text', 'why can customers not sign in?'],
      ['assistant', 'text', 'Reading the auth module.'],
      ['assistant', 'tool_call', 'Read'],
      ['tool', 'tool_result', 'Error: File not found'],
      ['assistant', 'tool_call', 'Shell'],
      ['tool', 'tool_result', expect.stringMatching(/^Exit code: 2/)],
      ['assistant', 'text', 'The allow-list was empty.']
    ])
    expect(rows[2]!.failed).toBe(true)
    expect(rows[4]!.failed).toBeUndefined()
    expect(rows[4]!.artifact).toMatchObject({ kind: 'check', checks: ['types'], status: 'failed', exitCode: 2 })
    expect(rows[0]!.ts).toBe(Date.parse('2026-09-27T22:16:00Z'))
  })

  it('takes the workspace from the root when meta.json is gone', () => {
    const other = writeCursorAcpSession(join(root, 'cursor-acp-bare'), {
      id: 'bare-1',
      cwd: '/Users/me/dev/api',
      created,
      messages: [query('hello'), { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]
    })
    rmSync(join(dirname(other), 'meta.json'))
    expect(listCursorSessions(join(root, 'cursor-acp-bare'), 'cursor-default')).toEqual([
      expect.objectContaining({ id: 'cursor:bare-1', title: 'hello', cwd: '/Users/me/dev/api', messageCount: 2 })
    ])
  })

  // meta reads a message's size without its content, and reads whole only what fits the
  // 256KB a log's head is read within: a tool result holding a file is passed over, and
  // a long conversation's count is carried over from the part read
  describe('within the meta budget', () => {
    const reply = (i: number) => ({ role: 'assistant', content: [{ type: 'text', text: `step ${i}` }, call(`c${i}`, 'Read', { path: `f${i}.ts` })] })
    const file = (i: number) => result(`c${i}`, `${i} `.repeat(50 * 1024))

    it('counts the conversation, its big tool results passed over', () => {
      const h = join(root, 'cursor-acp-big-results')
      writeCursorAcpSession(h, {
        id: 'big-results',
        cwd: '/x',
        created,
        messages: [
          { role: 'system', content: 'You are an AI coding assistant.' },
          { role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' },
          query('read every file'),
          ...Array.from({ length: 10 }, (_, i) => [reply(i), file(i)]).flat(),
          { role: 'assistant', content: [{ type: 'text', text: 'Read them all.' }] }
        ]
      })
      expect(listCursorSessions(h, 'c')).toEqual([expect.objectContaining({ title: 'read every file', messageCount: 12 })])
    })

    it('carries the count over a conversation longer than the budget', () => {
      const h = join(root, 'cursor-acp-long')
      writeCursorAcpSession(h, {
        id: 'long',
        cwd: '/x',
        created,
        messages: [query('go'), ...Array.from({ length: 600 }, (_, i) => ({ role: 'assistant', content: [{ type: 'text', text: `${i} ${'y'.repeat(1000)}` }] }))]
      })
      const [meta] = listCursorSessions(h, 'c')
      expect(meta!.messageCount).toBeGreaterThan(590)
      expect(meta!.messageCount).toBeLessThanOrEqual(601)
    })

    it('still finds an opening prompt too big to read with the rest', () => {
      const h = join(root, 'cursor-acp-big-prompt')
      writeCursorAcpSession(h, {
        id: 'big-prompt',
        cwd: '/x',
        created,
        messages: [query(`summarize ${'z'.repeat(100 * 1024)}`), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]
      })
      expect(listCursorSessions(h, 'c')).toEqual([expect.objectContaining({ title: expect.stringMatching(/^summarize z+/), messageCount: 2 })])
    })
  })
})

describe('antigravity parser', () => {
  const home = join(root, 'antigravity-ide')
  const at = Date.parse('2026-08-22T23:14:00Z')
  const m = (min: number): number => at + min * 60_000

  beforeAll(() => {
    writeAntigravityConversation(join(home, 'conversations', '6a2ff5b3-0000-4000-8000-000000000001.db'), {
      cwd: '/Users/me/dev/cachely',
      branch: 'titan/quotas',
      repo: 'acme/cachely',
      began: at,
      steps: [
        { at: m(0), user: 'Make an onboarding video for the home page' },
        { at: m(1), reply: 'Let me look at the landing page first.', thinking: 'The user wants a demo of setup.' },
        { at: m(2), tool: 'view_file', args: { AbsolutePath: '/Users/me/dev/cachely/src/landing.tsx', toolAction: 'Reading landing page' } },
        {
          at: m(3),
          tool: 'write_to_file',
          args: { TargetFile: '/Users/me/.gemini/antigravity-ide/brain/x/implementation_plan.md', CodeContent: '# Plan\n\nAnimate the setup steps.' }
        },
        {
          at: m(4),
          tool: 'write_to_file',
          args: { TargetFile: '/Users/me/.gemini/antigravity-ide/brain/x/task.md', CodeContent: '- [x] Read the page\n- [ ] Build the demo' }
        },
        {
          at: m(5),
          tool: 'replace_file_content',
          args: { TargetFile: '/Users/me/dev/cachely/src/landing.tsx', TargetContent: '<HowItWorks />', ReplacementContent: '<OnboardingDemo />' }
        },
        { at: m(6), tool: 'run_command', args: { CommandLine: 'npx nx test marketing', Cwd: '/Users/me/dev/cachely' }, output: 'Tests  1 failed | 9 passed' },
        { at: m(7), notice: 'Timer has expired' },
        { at: m(8), reply: 'The demo is in; one test needs a fix.' }
      ]
    })
    // a conversation from before the database: encrypted, not a session anyone can read
    writeFileSync(join(home, 'conversations', 'old.pb'), Buffer.from([0x8f, 0x13, 0xa2, 0x00, 0x51]))
    // a database that is not a conversation's at all
    writeFileSync(join(home, 'conversations', 'broken.db'), 'not sqlite')
  })

  it('lists the conversation with its workspace, branch and repository', () => {
    const [meta, ...rest] = listAntigravitySessions(home, 'antigravity-ide')
    expect(rest).toEqual([])
    expect(meta).toMatchObject({
      id: 'antigravity:6a2ff5b3-0000-4000-8000-000000000001',
      provider: 'antigravity',
      source: 'antigravity-ide',
      title: 'Make an onboarding video for the home page',
      cwd: '/Users/me/dev/cachely',
      logBranch: 'titan/quotas',
      repoFullName: 'acme/cachely',
      startedAt: at,
      // the prompt and the two replies
      messageCount: 3
    })
  })

  it('turns its steps into the conversation, the plan and task list onto the Work panel', () => {
    const rows = parseAntigravityMessages(join(home, 'conversations', '6a2ff5b3-0000-4000-8000-000000000001.db'))
    expect(rows.map((r) => [r.role, r.kind, r.toolName ?? r.text])).toEqual([
      ['user', 'text', 'Make an onboarding video for the home page'],
      ['assistant', 'reasoning', 'The user wants a demo of setup.'],
      ['assistant', 'text', 'Let me look at the landing page first.'],
      ['assistant', 'tool_call', 'view_file'],
      ['assistant', 'tool_call', 'write_to_file'],
      ['assistant', 'tool_call', 'write_to_file'],
      ['assistant', 'tool_call', 'replace_file_content'],
      ['assistant', 'tool_call', 'run_command'],
      ['tool', 'tool_result', 'Tests 1 failed | 9 passed'],
      ['system', 'system', 'Timer has expired'],
      ['assistant', 'text', 'The demo is in; one test needs a fix.']
    ])
    // the agent's own words for what the call does
    expect(rows[3]!.preview).toBe('Reading landing page')
    expect(rows[4]!.artifact).toEqual({ kind: 'plan', text: '# Plan\n\nAnimate the setup steps.' })
    expect(rows[5]!.artifact).toEqual({
      kind: 'todos',
      items: [
        { text: 'Read the page', status: 'completed' },
        { text: 'Build the demo', status: 'pending' }
      ]
    })
    expect(rows[6]!.artifact).toMatchObject({ kind: 'edits', files: [{ path: '/Users/me/dev/cachely/src/landing.tsx' }] })
    expect(rows[7]!.artifact).toMatchObject({ kind: 'check', checks: ['tests'], status: 'failed' })
    expect(rows.every((r) => typeof r.ts === 'number')).toBe(true)
  })

  // when the opening prompt is not where step type 14 says, meta looks through the first
  // steps — passing over one carrying a screenshot rather than reading megabytes of it
  it('finds the opening prompt past a big step when the numbering has moved', () => {
    const file = join(root, 'antigravity-moved', 'conversations', 'moved.db')
    writeAntigravityConversation(file, {
      cwd: '/Users/me/dev/cachely',
      began: at,
      steps: [
        { at: m(0), user: 'Record the onboarding flow' },
        { at: m(1), reply: 'Opening the browser.' }
      ]
    })
    const db = new DatabaseSync(file)
    try {
      db.exec('UPDATE steps SET step_type = 99 WHERE step_type = 14')
      db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (-1, 60, ?)').run(new Uint8Array(2 * 1024 * 1024).fill(7))
    } finally {
      db.close()
    }
    expect(listAntigravitySessions(join(root, 'antigravity-moved'), 'a')).toEqual([
      expect.objectContaining({ id: 'antigravity:moved', title: 'Record the onboarding flow' })
    ])
  })
})

describe('opencode parser', () => {
  const home = join(root, 'opencode')
  const at = Date.parse('2026-09-01T09:00:00Z')

  beforeAll(() => {
    writeOpencodeDb(join(home, 'opencode.db'), [
      {
        id: 'ses_one',
        title: 'Fix the flaky login test',
        directory: '/Users/me/dev/web',
        created: at,
        updated: at + 60_000,
        turns: [
          { role: 'user', at, parts: [{ type: 'text', text: 'the login test flakes, fix it' }] },
          {
            role: 'assistant',
            at: at + 10_000,
            parts: [
              { type: 'step-start' },
              { type: 'reasoning', text: 'Probably a race on the redirect.' },
              { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, output: 'Tests  1 failed', metadata: { exit: 1 } } },
              { type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: 'src/login.ts', oldString: 'await a', newString: 'await b' }, output: '' } },
              { type: 'tool', tool: 'todowrite', state: { status: 'completed', input: { todos: [{ content: 'Rerun', status: 'pending' }] } } },
              { type: 'tool', tool: 'read', state: { status: 'error', input: { filePath: 'src/missing.ts' }, error: 'File not found' } },
              { type: 'text', text: 'Fixed the race.' }
            ]
          }
        ]
      },
      // opencode's placeholder title: the opening prompt names it instead
      {
        id: 'ses_two',
        title: 'New session - 2026-09-02T10:00:00.000Z',
        directory: '/Users/me/dev/api',
        created: at,
        updated: at,
        parent: 'ses_one',
        turns: [{ role: 'user', at, parts: [{ type: 'text', text: 'explain the rate limiter' }] }]
      },
      // archived in opencode, and one never used
      { id: 'ses_gone', title: 'Old', directory: '/x', created: at, updated: at, archived: at, turns: [{ role: 'user', at, parts: [{ type: 'text', text: 'x' }] }] },
      { id: 'ses_empty', title: 'Empty', directory: '/x', created: at, updated: at, turns: [] }
    ])
    // the older file store: a session the database does not hold
    const legacy = join(home, 'storage')
    mkdirSync(join(legacy, 'session', 'proj'), { recursive: true })
    mkdirSync(join(legacy, 'message', 'ses_legacy'), { recursive: true })
    mkdirSync(join(legacy, 'part', 'msg_l1'), { recursive: true })
    writeFileSync(
      join(legacy, 'session', 'proj', 'ses_legacy.json'),
      JSON.stringify({ id: 'ses_legacy', title: 'Assistance scope', directory: '/Users/me/dev/old', time: { created: at, updated: at + 5_000 } })
    )
    writeFileSync(join(legacy, 'message', 'ses_legacy', 'msg_l1.json'), JSON.stringify({ id: 'msg_l1', role: 'user', time: { created: at } }))
    writeFileSync(join(legacy, 'part', 'msg_l1', 'prt_1.json'), JSON.stringify({ type: 'text', text: 'what can you do?' }))
  })

  it('lists the sessions opencode keeps, in its database and in its older file store', () => {
    const metas = listOpencodeSessions(home, 'opencode-default')
    expect(metas.map((m) => m.id).sort()).toEqual(['opencode:ses_legacy', 'opencode:ses_one', 'opencode:ses_two'])
    expect(metas.find((m) => m.nativeId === 'ses_one')).toMatchObject({
      provider: 'opencode',
      title: 'Fix the flaky login test',
      cwd: '/Users/me/dev/web',
      startedAt: at,
      updatedAt: at + 60_000,
      messageCount: 2
    })
    expect(metas.find((m) => m.nativeId === 'ses_two')).toMatchObject({ title: 'explain the rate limiter', parentId: 'opencode:ses_one' })
    expect(metas.find((m) => m.nativeId === 'ses_legacy')).toMatchObject({ title: 'Assistance scope', cwd: '/Users/me/dev/old' })
  })

  it('turns its parts into the conversation', () => {
    const one = listOpencodeSessions(home, 'o').find((m) => m.nativeId === 'ses_one')!
    const rows = parseOpencodeMessages(one.sourcePath)
    expect(rows.map((r) => [r.role, r.kind, r.toolName ?? r.text])).toEqual([
      ['user', 'text', 'the login test flakes, fix it'],
      ['assistant', 'reasoning', 'Probably a race on the redirect.'],
      ['assistant', 'tool_call', 'bash'],
      ['tool', 'tool_result', 'Tests 1 failed'],
      ['assistant', 'tool_call', 'edit'],
      ['assistant', 'tool_call', 'todowrite'],
      ['assistant', 'tool_call', 'read'],
      ['tool', 'tool_result', 'File not found'],
      ['assistant', 'text', 'Fixed the race.']
    ])
    expect(rows[2]).toMatchObject({ preview: 'npm test', artifact: { kind: 'check', status: 'failed', exitCode: 1 } })
    expect(rows[4]!.artifact).toMatchObject({ kind: 'edits', files: [{ path: 'src/login.ts' }] })
    expect(rows[5]!.artifact).toEqual({ kind: 'todos', items: [{ text: 'Rerun', status: 'pending' }] })
    expect(rows[6]!.failed).toBe(true)
    const legacy = listOpencodeSessions(home, 'o').find((m) => m.nativeId === 'ses_legacy')!
    expect(parseOpencodeMessages(legacy.sourcePath).map((r) => r.text)).toEqual(['what can you do?'])
  })

  // opencode — or anything else that opens its database to write — can hold it for a
  // moment; a read then fails. Taken as "no sessions", every session in the database
  // dropped out of the index until the next good read, flickering every few seconds
  it('keeps its sessions through a read that fails while something holds the database', () => {
    const ids = (): string[] => listOpencodeSessions(home, 'o').map((m) => m.nativeId).sort()
    expect(ids()).toEqual(['ses_legacy', 'ses_one', 'ses_two'])
    const writer = new DatabaseSync(join(home, 'opencode.db'))
    try {
      // a write that keeps the whole file to itself: every other connection is refused
      writer.exec('PRAGMA locking_mode = EXCLUSIVE')
      writer.exec("UPDATE session SET title = 'renamed while held' WHERE id = 'ses_two'")
      expect(ids()).toEqual(['ses_legacy', 'ses_one', 'ses_two'])
    } finally {
      writer.close()
    }
    // and the next read after it lets go is the database as it now stands
    expect(listOpencodeSessions(home, 'o').find((m) => m.nativeId === 'ses_two')?.title).toBe('renamed while held')
  })

  it('opens a very long session on its newest turns, saying the older ones were left out', () => {
    const long = join(root, 'opencode-long')
    // twenty parts of ~250KB: sixteen fit the 4MB budget
    writeOpencodeDb(join(long, 'opencode.db'), [
      {
        id: 'ses_long',
        title: 'Long',
        directory: '/Users/me/dev/web',
        created: at,
        updated: at,
        turns: Array.from({ length: 20 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          at: at + i,
          parts: [{ type: 'text', text: `p${i} ${'x'.repeat(250 * 1024)}` }]
        }))
      }
    ])
    const rows = parseOpencodeMessages(listOpencodeSessions(long, 'o')[0]!.sourcePath)
    expect(rows[0]).toEqual({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
    expect(rows.slice(1).map((r) => r.text.split(' ')[0])).toEqual(Array.from({ length: 16 }, (_, i) => `p${i + 4}`))
  })

  describe('the older file store, read within a budget', () => {
    /** A session of the older store: its turns in order, each with its parts. */
    function legacySession(h: string, id: string, turns: ReadonlyArray<{ readonly role: string; readonly parts: readonly object[] }>): string {
      const store = join(h, 'storage')
      mkdirSync(join(store, 'session', 'proj'), { recursive: true })
      mkdirSync(join(store, 'message', id), { recursive: true })
      const file = join(store, 'session', 'proj', `${id}.json`)
      writeFileSync(file, JSON.stringify({ id, title: 'New session - 2026-09-01T09:00:00.000Z', directory: '/x', time: { created: at, updated: at } }))
      turns.forEach((t, i) => {
        const mid = `msg_${String(i).padStart(4, '0')}`
        writeFileSync(join(store, 'message', id, `${mid}.json`), JSON.stringify({ id: mid, role: t.role, time: { created: at + i } }))
        mkdirSync(join(store, 'part', mid), { recursive: true })
        t.parts.forEach((p, j) => writeFileSync(join(store, 'part', mid, `prt_${j}.json`), JSON.stringify(p)))
      })
      return file
    }

    it('names an untitled session by its opening prompt', () => {
      const h = join(root, 'opencode-legacy-untitled')
      legacySession(h, 'ses_u', [
        { role: 'user', parts: [{ type: 'text', text: 'why is the build slow?' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Profiling it.' }] }
      ])
      expect(listOpencodeSessions(h, 'o')).toEqual([expect.objectContaining({ id: 'opencode:ses_u', title: 'why is the build slow?' })])
    })

    // meta reads a log's head, never all of it: an untitled session read every one of up
    // to four thousand files to name itself, on every scan that found it changed
    it('looks for that prompt no further than the meta budget', () => {
      const h = join(root, 'opencode-legacy-far')
      legacySession(h, 'ses_far', [
        ...Array.from({ length: 70 }, () => ({ role: 'assistant', parts: [] })),
        { role: 'user', parts: [{ type: 'text', text: 'a prompt far in' }] }
      ])
      expect(listOpencodeSessions(h, 'o')).toEqual([expect.objectContaining({ id: 'opencode:ses_far', title: '(untitled)' })])
    })

    it('opens a very long session on its newest turns', () => {
      const h = join(root, 'opencode-legacy-long')
      const file = legacySession(
        h,
        'ses_long',
        Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text: `p${i} ${'x'.repeat(250 * 1024)}` }] }))
      )
      const rows = parseOpencodeMessages(file)
      expect(rows[0]).toEqual({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
      expect(rows.slice(1).map((r) => r.text.split(' ')[0])).toEqual(Array.from({ length: 16 }, (_, i) => `p${i + 4}`))
    })
  })
})

describe('cursor parser: the editor’s own chats', () => {
  const storage = join(root, 'cursor-editor', 'User', 'globalStorage')
  const at = Date.parse('2026-08-18T21:54:00Z')

  beforeAll(() => {
    writeCursorChats(join(storage, 'state.vscdb'), [
      {
        id: 'chat-1',
        name: 'Customer sign-in assistance',
        cwd: '/Users/me/dev/web',
        created: at,
        // the chat's own stamp lags its last message
        updated: at + 1_000,
        subagents: ['chat-sub'],
        bubbles: [
          { type: 1, at, text: 'why can customers not sign in?' },
          { type: 2, at: at + 5_000, thinking: 'Check the auth config.' },
          { type: 2, at: at + 6_000, tool: { name: 'read_file_v2', params: { targetFile: 'src/auth.ts' } } },
          { type: 2, at: at + 7_000, tool: { name: 'run_terminal_command_v2', params: { command: 'npm test' }, status: 'error' } },
          { type: 2, at: at + 300_000, text: 'The allow-list was empty.' }
        ]
      },
      { id: 'chat-sub', name: 'Explore auth', cwd: '/Users/me/dev/web', created: at, updated: at, bubbles: [{ type: 1, at, text: 'explore' }] }
    ])
  })

  it('lists every chat with messages, drafts left out, a subagent’s chat under its parent', () => {
    const metas = listCursorSessions(storage, 'cursor-ide')
    expect(metas.map((m) => m.id).sort()).toEqual(['cursor:chat-1', 'cursor:chat-sub'])
    const chat = metas.find((m) => m.nativeId === 'chat-1')
    expect(chat).toMatchObject({
      provider: 'cursor',
      title: 'Customer sign-in assistance',
      cwd: '/Users/me/dev/web',
      startedAt: at,
      messageCount: 5
    })
    // the last message's time, not the chat's lagging stamp — bounded by the store's last write
    expect(chat!.updatedAt).toBeGreaterThan(at + 1_000)
    expect(metas.find((m) => m.nativeId === 'chat-sub')?.parentId).toBe('cursor:chat-1')
  })

  it('turns its messages into the conversation', () => {
    const chat = listCursorSessions(storage, 'c').find((m) => m.nativeId === 'chat-1')!
    const rows = parseCursorMessages(chat.sourcePath)
    expect(rows.map((r) => [r.role, r.kind, r.toolName ?? r.text])).toEqual([
      ['user', 'text', 'why can customers not sign in?'],
      ['assistant', 'reasoning', 'Check the auth config.'],
      ['assistant', 'tool_call', 'read_file_v2'],
      ['assistant', 'tool_call', 'run_terminal_command_v2'],
      ['assistant', 'text', 'The allow-list was empty.']
    ])
    expect(rows[2]!.preview).toBe('src/auth.ts')
    expect(rows[3]).toMatchObject({ failed: true, artifact: { kind: 'check', checks: ['tests'] } })
  })

  // every other store opens a long conversation on its newest messages within the
  // transcript budget; a chat's messages were all read, however many megabytes they held
  it('opens a very long chat on its newest messages, saying the older ones were left out', () => {
    const big = join(root, 'cursor-editor-long', 'User', 'globalStorage')
    const text = (i: number): string => `m${i} ${'x'.repeat(500 * 1024)}`
    writeCursorChats(join(big, 'state.vscdb'), [
      {
        id: 'long',
        name: 'A long one',
        cwd: '/Users/me/dev/web',
        created: at,
        updated: at,
        bubbles: Array.from({ length: 9 }, (_, i) => ({ type: (i % 2 === 0 ? 1 : 2) as 1 | 2, at: at + i, text: text(i) }))
      }
    ])
    const chat = listCursorSessions(big, 'c').find((m) => m.nativeId === 'long')!
    expect(chat.messageCount).toBe(9)
    const rows = parseCursorMessages(chat.sourcePath)
    expect(rows[0]).toEqual({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
    // eight of ~512KB fit the 4MB budget: the newest eight, in order
    expect(rows.slice(1).map((r) => r.text.split(' ')[0])).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'])
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

/**
 * Where a session was opened — the one thing that tells "in the Claude app" from "in a
 * terminal" — read off what each agent's own log says about its client, and nothing
 * guessed: a client no log has named yet says nothing.
 */
describe('where a session was opened', () => {
  const dir = join(root, 'surfaces')
  const claude = (name: string, entrypoints: readonly unknown[]): string => {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${name}.jsonl`)
    writeFileSync(
      file,
      jsonl(
        entrypoints.map((entrypoint, i) => ({
          type: i % 2 ? 'assistant' : 'user',
          message: { role: i % 2 ? 'assistant' : 'user', content: `line ${i}` },
          timestamp: `2026-08-01T10:00:0${i}Z`,
          sessionId: name,
          cwd: '/Users/titan/dev/myrepo',
          ...(entrypoint === undefined ? {} : { entrypoint })
        }))
      )
    )
    return file
  }

  it("reads Claude's entrypoint — the one it was opened in, not where it was resumed since", () => {
    expect(parseClaudeMeta(claude('desk', ['claude-desktop', 'claude-desktop']), 'x')?.surface).toBe('app')
    expect(parseClaudeMeta(claude('term', ['cli', 'cli']), 'x')?.surface).toBe('terminal')
    expect(parseClaudeMeta(claude('head', ['sdk-cli', 'sdk-cli']), 'x')?.surface).toBe('headless')
    expect(parseClaudeMeta(claude('moved', ['claude-desktop', 'cli']), 'x')?.surface).toBe('app')
    // an older log states none, and a client no log has named yet says nothing
    expect(parseClaudeMeta(claude('old', [undefined, undefined]), 'x')?.surface).toBeUndefined()
    expect(parseClaudeMeta(claude('new', ['claude-hologram', 'x']), 'x')?.surface).toBeUndefined()
    expect(parseClaudeMeta(claude('odd', [{ app: true }, 7]), 'x')?.surface).toBeUndefined()
  })

  it("reads Codex's originator", () => {
    const codex = (name: string, originator: unknown): string => {
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `rollout-${name}.jsonl`)
      writeFileSync(
        file,
        jsonl([
          { timestamp: '2026-08-01T10:00:00Z', type: 'session_meta', payload: { id: name, cwd: '/x', originator } },
          { timestamp: '2026-08-01T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }
        ])
      )
      return file
    }
    expect(parseCodexMeta(codex('c-app', 'Codex Desktop'), 'x')?.surface).toBe('app')
    expect(parseCodexMeta(codex('c-tui', 'codex-tui'), 'x')?.surface).toBe('terminal')
    expect(parseCodexMeta(codex('c-exec', 'codex_exec'), 'x')?.surface).toBe('headless')
    expect(parseCodexMeta(codex('c-ide', 'codex_vscode'), 'x')?.surface).toBe('ide')
    expect(parseCodexMeta(codex('c-web', 'codex-chrome-extension-sidepanel'), 'x')?.surface).toBe('browser')
    expect(parseCodexMeta(codex('c-new', 'codex_somewhere_else'), 'x')?.surface).toBeUndefined()
  })

  it("tells Copilot's app from its CLI by the build that opened it", () => {
    const copilot = (id: string, start: Record<string, unknown>, kickoff?: string): string => {
      const sdir = join(dir, 'copilot', 'session-state', id)
      mkdirSync(sdir, { recursive: true })
      const file = join(sdir, 'events.jsonl')
      writeFileSync(
        file,
        jsonl([
          { type: 'session.start', timestamp: '2026-08-22T18:51:09Z', data: { sessionId: id, context: { cwd: '/x' }, ...start } },
          { type: 'user.message', timestamp: '2026-08-22T18:51:10Z', data: { content: 'hi', ...(kickoff ? { transformedContent: kickoff } : {}) } }
        ])
      )
      return file
    }
    expect(parseCopilotMeta(copilot('p-app', { copilotVersion: '0.0.0' }), 'x')?.surface).toBe('app')
    expect(parseCopilotMeta(copilot('p-cli', { copilotVersion: '1.0.80' }), 'x')?.surface).toBe('cli')
    // the app's workspace block says so whatever the build
    expect(
      parseCopilotMeta(copilot('p-ws', {}, '<copilot_tauri_workspace>\nproject_name: site\n</copilot_tauri_workspace>\nhi'), 'x')
        ?.surface
    ).toBe('app')
    expect(parseCopilotMeta(copilot('p-none', {}), 'x')?.surface).toBeUndefined()
  })
})
