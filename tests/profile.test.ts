import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProfile, dayKey, streaks } from '../src/main/profile'
import type { ProfileStats, Provider, SessionMeta } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'cockpit-profile-fixtures-'))

/** Fixed "now" every assertion is relative to (local noon, so day math is stable). */
const NOW = new Date(2026, 7, 10, 12, 0, 0).getTime()
const DAY = 86_400_000

/** Local day key N days before NOW. */
function daysAgo(n: number): string {
  return dayKey(NOW - n * DAY)
}

function meta(over: Partial<SessionMeta> & { provider: Provider; sourcePath: string }): SessionMeta {
  return {
    id: `${over.provider}:${over.sourcePath}`,
    nativeId: over.sourcePath,
    source: root,
    title: 't',
    cwd: null,
    logBranch: null,
    gitBranch: null,
    startedAt: NOW,
    updatedAt: NOW,
    messageCount: 0,
    ...over
  } as SessionMeta
}

/* ---------- fixtures: real log shapes, written to disk ---------- */

function claudeLog(name: string, blocks: unknown[]): string {
  const file = join(root, name)
  const lines = blocks.map((content) =>
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content } })
  )
  writeFileSync(file, lines.join('\n'))
  return file
}

function codexLog(name: string, calls: { name: string; arguments: string }[]): string {
  const file = join(root, name)
  const lines = calls.map((c) =>
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', ...c } })
  )
  writeFileSync(file, lines.join('\n'))
  return file
}

function copilotLog(name: string, events: unknown[]): string {
  const file = join(root, name)
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n'))
  return file
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

describe('streaks', () => {
  it('counts the longest run of consecutive days', () => {
    const days = new Set(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-06'])
    expect(streaks(days, '2026-08-10').longest).toBe(3)
  })

  it('keeps the current streak alive when only today is empty', () => {
    const days = new Set(['2026-08-08', '2026-08-09'])
    expect(streaks(days, '2026-08-10').current).toBe(2)
  })

  it('breaks the current streak once a full day lapses', () => {
    const days = new Set(['2026-08-07', '2026-08-08'])
    expect(streaks(days, '2026-08-10').current).toBe(0)
  })

  it('handles a month boundary', () => {
    const days = new Set(['2026-07-30', '2026-07-31', '2026-08-01'])
    expect(streaks(days, '2026-08-01')).toEqual({ current: 3, longest: 3 })
  })

  it('is empty for no activity', () => {
    expect(streaks(new Set(), '2026-08-10')).toEqual({ current: 0, longest: 0 })
  })
})

describe('buildProfile — heatmap', () => {
  it('returns an empty profile when there are no sessions', async () => {
    const p = await buildProfile([], { now: NOW, login: null })
    expect(p.totalSessions).toBe(0)
    expect(p.days).toEqual([])
    expect(p.busiestDay).toBeNull()
  })

  it('buckets sessions into local calendar days and fills the gaps', async () => {
    const file = claudeLog('gaps.jsonl', [])
    const p = await buildProfile(
      [
        meta({ provider: 'claude', sourcePath: file, startedAt: NOW - 2 * DAY }),
        meta({ provider: 'claude', sourcePath: file, startedAt: NOW }),
        meta({ provider: 'codex', sourcePath: file, startedAt: NOW })
      ],
      { now: NOW, login: null }
    )
    expect(p.totalSessions).toBe(3)
    expect(p.activeDays).toBe(2)
    // the empty middle day must still exist so the grid has no hole
    expect(p.days.map((d) => d.day)).toEqual([daysAgo(2), daysAgo(1), daysAgo(0)])
    expect(p.days[1].sessions).toBe(0)
    expect(p.busiestDay).toMatchObject({ day: daysAgo(0), sessions: 2 })
    expect(p.days[2].byProvider).toEqual({ claude: 1, codex: 1 })
  })

  it('caps the grid at maxDays even when history runs deeper', async () => {
    const file = claudeLog('old.jsonl', [])
    const p = await buildProfile(
      [
        meta({ provider: 'claude', sourcePath: file, startedAt: NOW - 400 * DAY }),
        meta({ provider: 'claude', sourcePath: file, startedAt: NOW })
      ],
      { now: NOW, login: null, maxDays: 30 }
    )
    expect(p.days.length).toBe(30)
    // `since` still reports the true first session, even though the grid is clipped
    expect(p.since).toBe(NOW - 400 * DAY)
  })
})

describe('buildProfile — deep pass', () => {
  it('counts claude Edit and Write lines, files, tools and models', async () => {
    const file = claudeLog('claude-edits.jsonl', [
      [
        {
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: '/repo/a.ts', old_string: 'x\ny', new_string: 'x\ny\nz' }
        }
      ],
      [
        {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/repo/b.tsx', content: 'l1\nl2\nl3\nl4' }
        },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }
      ]
    ])
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file })], {
      now: NOW,
      login: null
    })
    const agent = p.providers[0]
    expect(agent.linesAdded).toBe(7) // 3 from the edit + 4 written
    expect(agent.linesRemoved).toBe(2)
    expect(agent.filesTouched).toBe(2)
    expect(agent.tools).toEqual([
      { name: 'Bash', count: 1 },
      { name: 'Edit', count: 1 },
      { name: 'Write', count: 1 }
    ])
    expect(agent.models).toEqual([{ name: 'claude-opus-5', count: 2 }])
    expect(p.languages).toEqual([
      { ext: 'tsx', files: 1, linesAdded: 4, byProvider: { claude: 4 } },
      { ext: 'ts', files: 1, linesAdded: 3, byProvider: { claude: 3 } }
    ])
  })

  it('handles a MultiEdit block', async () => {
    const file = claudeLog('multi.jsonl', [
      [
        {
          type: 'tool_use',
          name: 'MultiEdit',
          input: {
            file_path: '/repo/m.ts',
            edits: [
              { old_string: 'a', new_string: 'a\nb' },
              { old_string: 'c\nd', new_string: 'c' }
            ]
          }
        }
      ]
    ])
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file })], {
      now: NOW,
      login: null
    })
    expect(p.providers[0].linesAdded).toBe(3)
    expect(p.providers[0].linesRemoved).toBe(3)
  })

  it('counts codex apply_patch bodies carried inside a shell call', async () => {
    // codex has no edit tool — it patches through a shell apply_patch heredoc,
    // and the whole body arrives JSON-encoded inside `arguments`
    const patch = [
      '*** Begin Patch',
      '*** Update File: /repo/s.ts',
      '@@',
      '-old one',
      '-old two',
      '+new one',
      '+new two',
      '+new three',
      '*** End Patch'
    ].join('\n')
    const file = codexLog('codex-patch.jsonl', [
      { name: 'shell', arguments: JSON.stringify({ command: ['apply_patch', patch] }) },
      { name: 'exec_command', arguments: JSON.stringify({ command: 'npm test' }) }
    ])
    const p = await buildProfile([meta({ provider: 'codex', sourcePath: file })], {
      now: NOW,
      login: null
    })
    const agent = p.providers[0]
    expect(agent.linesAdded).toBe(3)
    expect(agent.linesRemoved).toBe(2)
    expect(agent.filesTouched).toBe(1)
    expect(agent.tools.map((t) => t.name).sort()).toEqual(['exec_command', 'shell'])
  })

  it('counts copilot create and edit tool events', async () => {
    const file = copilotLog('copilot.jsonl', [
      {
        type: 'tool.execution_start',
        data: { toolName: 'create', arguments: { path: '/repo/c.py', file_text: 'a\nb\nc' } }
      },
      {
        type: 'tool.execution_start',
        data: {
          toolName: 'edit',
          arguments: { path: '/repo/c.py', old_str: 'a\nb', new_str: 'a' }
        }
      },
      { type: 'tool.execution_start', data: { toolName: 'bash', arguments: { command: 'ls' } } },
      { type: 'assistant.message', data: {} }
    ])
    const p = await buildProfile([meta({ provider: 'copilot', sourcePath: file })], {
      now: NOW,
      login: null
    })
    const agent = p.providers[0]
    expect(agent.linesAdded).toBe(4)
    expect(agent.linesRemoved).toBe(2)
    expect(agent.filesTouched).toBe(1)
    expect(p.languages).toEqual([{ ext: 'py', files: 1, linesAdded: 4, byProvider: { copilot: 4 } }])
  })

  it('survives an unreadable log without losing the session counts', async () => {
    const p = await buildProfile(
      [meta({ provider: 'claude', sourcePath: join(root, 'does-not-exist.jsonl') })],
      { now: NOW, login: null }
    )
    expect(p.totalSessions).toBe(1)
    expect(p.providers[0].sessions).toBe(1)
    expect(p.providers[0].linesAdded).toBe(0)
    expect(p.providers[0].deepUnavailable).toBeTruthy()
    // nothing was read, so no rate has a denominator
    expect(p.providers[0].readSessions).toBe(0)
  })

  it('tolerates corrupt and half-written lines', async () => {
    const file = join(root, 'corrupt.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            model: 'claude-opus-5',
            content: [
              { type: 'tool_use', name: 'Write', input: { file_path: '/r/a.ts', content: 'x' } }
            ]
          }
        }),
        '{"type":"assistant","message":{ broken',
        ''
      ].join('\n')
    )
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file })], {
      now: NOW,
      login: null
    })
    expect(p.providers[0].linesAdded).toBe(1)
    expect(p.providers[0].deepUnavailable).toBeUndefined()
  })
})

// Newer Codex runs its tools from a code-mode `exec` cell and records each run again as
// a typed `item_completed` item; the profile counts every run once, from the record the
// transcript reads it from.
describe('buildProfile — codex code mode', () => {
  const at = (s: number): string => `2026-09-24T10:00:${String(s).padStart(2, '0')}.000Z`
  const rollout = (name: string, records: unknown[]): string => {
    const file = join(root, name)
    const head = [
      { timestamp: at(0), type: 'session_meta', payload: { id: name, cwd: '/r', originator: 'Codex Desktop', cli_version: '0.155.0' } },
      { timestamp: at(0), type: 'turn_context', payload: { turn_id: 't1', cwd: '/r', model: 'gpt-6-sol', effort: 'medium' } }
    ]
    writeFileSync(file, [...head, ...records].map((r) => JSON.stringify(r)).join('\n'))
    return file
  }
  const cell = (s: number, callId: string, input: string): unknown => ({
    timestamp: at(s),
    type: 'response_item',
    payload: { type: 'custom_tool_call', id: `ctc_${callId}`, status: 'completed', call_id: callId, name: 'exec', input }
  })
  const cellOut = (s: number, callId: string): unknown => ({
    timestamp: at(s),
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }] }
  })
  const direct = (s: number, name: string, callId: string, args: object): unknown => ({
    timestamp: at(s),
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId }
  })
  const done = (s: number, item: object): unknown => ({
    timestamp: at(s),
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'th', turn_id: 't1', item, started_at_ms: 1, completed_at_ms: 2 }
  })
  const command = (id: string, script: string): object => ({
    type: 'CommandExecution',
    id,
    command: ['/bin/zsh', '-lc', script],
    cwd: 'file:///r',
    status: 'completed',
    aggregated_output: '',
    exit_code: 0
  })
  const deep = async (file: string): Promise<ProfileStats['providers'][number]> =>
    (await buildProfile([meta({ provider: 'codex', sourcePath: file })], { now: NOW, login: null })).providers[0]!
  const tally = (agent: ProfileStats['providers'][number]): Record<string, number> =>
    Object.fromEntries(agent.tools.map((t) => [t.name, t.count]))

  it("counts each run from its typed item and each patch from its FileChange, not the cell's", async () => {
    const file = rollout('rollout-items.jsonl', [
      cell(1, 'call_a', 'await Promise.all([tools.exec_command({cmd:"npm test"}), tools.exec_command({cmd:"git status"})])'),
      done(2, command('exec-1', 'npm test')),
      done(2, command('exec-2', 'git status')),
      cellOut(2, 'call_a'),
      cell(3, 'call_b', "text(await tools.mcp__node_repl__js({code:'1',title:'Probe'}))"),
      done(4, { type: 'McpToolCall', id: 'exec-3', server: 'node_repl', tool: 'js', arguments: { code: '1' }, status: 'completed', result: { content: [] } }),
      cellOut(4, 'call_b'),
      cell(5, 'call_c', "text(await tools.web__run({search_query:[{q:'nx cache'}]}))"),
      done(6, { type: 'Extension', kind: 'web.search', id: 'exec-4', action: { type: 'search', queries: ['nx cache'] }, results: [] }),
      cellOut(6, 'call_c'),
      // the patch is in the cell too, but the FileChange items are what it did
      cell(7, 'call_d', 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /r/src/s.ts\\n@@\\n-a\\n+b\\n*** End Patch"))'),
      done(8, {
        type: 'FileChange',
        id: 'exec-5',
        changes: {
          '/r/src/s.ts': { type: 'update', unified_diff: '@@ -1,3 +1,4 @@\n keep\n-old one\n-old two\n+new one\n+new two\n+new three\n', move_path: null },
          '/r/src/new.ts': { type: 'add', content: 'export const a = 1\nexport const b = 2\n' },
          '/r/src/gone.ts': { type: 'delete', content: 'x\ny\nz\n' }
        },
        status: 'completed',
        stdout: 'Success.'
      }),
      cellOut(8, 'call_d'),
      // a declined patch still ran the tool, but changed nothing
      done(9, { type: 'FileChange', id: 'exec-6', changes: { '/r/src/no.ts': { type: 'add', content: 'no\n' } }, status: 'declined' }),
      // a tool called directly completes with an item under its own call id: counted once
      direct(10, 'sleep', 'call_s', { duration_ms: 10 }),
      done(11, { type: 'Extension', kind: 'clock.sleep', id: 'call_s', durationMs: 10 }),
      direct(12, 'js', 'call_j', { code: 'await tab.reload()' }),
      done(13, { type: 'McpToolCall', id: 'call_j', server: 'cua_repl', tool: 'js', arguments: {}, status: 'completed', result: { content: [] } })
    ])
    const agent = await deep(file)
    expect(tally(agent)).toEqual({
      shell: 2,
      apply_patch: 2,
      mcp__node_repl__js: 1,
      web_search: 1,
      sleep: 1,
      js: 1
    })
    expect(agent.linesAdded).toBe(5) // 3 in the diff + the 2 lines of the added file
    expect(agent.linesRemoved).toBe(5) // 2 in the diff + the 3 lines of the deleted file
    expect(agent.filesTouched).toBe(3)
    expect(agent.models).toEqual([{ name: 'gpt-6-sol', count: 1 }])
  })

  it('counts the tools a cell calls, and the patches in it, where no item speaks for them', async () => {
    const file = rollout('rollout-cells.jsonl', [
      cell(1, 'call_a', 'await Promise.all([tools.exec_command({cmd:"wc -l a.ts"}), tools.exec_command({cmd:"wc -l b.ts"})])'),
      cellOut(2, 'call_a'),
      cell(3, 'call_b', 'text(await tools.apply_patch(`*** Begin Patch\n*** Update File: /r/src/a.ts\n@@\n-a\n+b\n+c\n*** End Patch`))'),
      cellOut(4, 'call_b'),
      cell(5, 'call_c', "text(await tools.web__run({search_query:[{q:'x'}]})); text(ALL_TOOLS.length)"),
      cellOut(6, 'call_c'),
      // a direct call's own item is only its echo: it does not make the cells' runs typed
      direct(7, 'sleep', 'call_s', { duration_ms: 10 }),
      done(8, { type: 'Extension', kind: 'clock.sleep', id: 'call_s', durationMs: 10 })
    ])
    const agent = await deep(file)
    expect(tally(agent)).toEqual({ exec_command: 2, apply_patch: 1, web__run: 1, sleep: 1 })
    expect(agent.linesAdded).toBe(2)
    expect(agent.linesRemoved).toBe(1)
    expect(agent.filesTouched).toBe(1)
  })

  it('counts a patch applied as a call once, not again from its FileChange item', async () => {
    const patch = '*** Begin Patch\n*** Update File: /r/src/a.ts\n@@\n-a\n+b\n*** End Patch'
    const file = rollout('rollout-direct-patch.jsonl', [
      { timestamp: at(1), type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call_p', name: 'apply_patch', input: patch } },
      done(2, { type: 'FileChange', id: 'call_p', changes: { '/r/src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n' } }, status: 'completed' }),
      { timestamp: at(2), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_p', output: 'Success.' } }
    ])
    const agent = await deep(file)
    expect(tally(agent)).toEqual({ apply_patch: 1 })
    expect(agent.linesAdded).toBe(1)
    expect(agent.linesRemoved).toBe(1)
    expect(agent.filesTouched).toBe(1)
  })
})

describe('buildProfile — insights', () => {
  it('merges one model across agents, keeping the per-agent split', async () => {
    // the same model name served by two different agents must become ONE stat
    const claudeFile = claudeLog('model-a.jsonl', [[]]) // one assistant msg, model claude-opus-5
    const copilotFile = copilotLog('model-b.jsonl', [
      { type: 'assistant.message', data: { model: 'claude-opus-5' } },
      { type: 'assistant.message', data: { model: 'claude-opus-5' } }
    ])
    const p = await buildProfile(
      [
        meta({ provider: 'claude', sourcePath: claudeFile }),
        meta({ provider: 'copilot', sourcePath: copilotFile })
      ],
      { now: NOW, login: null }
    )
    expect(p.models).toEqual([
      { name: 'claude-opus-5', count: 3, byProvider: { claude: 1, copilot: 2 } }
    ])
  })

  it('drops the <synthetic> placeholder from model stats', async () => {
    const file = join(root, 'synthetic.jsonl')
    writeFileSync(
      file,
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [] } })
    )
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file })], {
      now: NOW,
      login: null
    })
    expect(p.models).toEqual([])
  })

  it('attributes sessions to accounts and joins the signed-in identity', async () => {
    const file = claudeLog('acct.jsonl', [])
    const p = await buildProfile(
      [
        meta({ provider: 'claude', sourcePath: file, source: 'work' }),
        meta({ provider: 'claude', sourcePath: file, source: 'work' }),
        meta({ provider: 'claude', sourcePath: file, source: 'personal' })
      ],
      {
        now: NOW,
        login: null,
        identities: [{ provider: 'claude', label: 'work', identity: 'me@work.com' }]
      }
    )
    expect(p.accounts).toEqual([
      { provider: 'claude', label: 'work', identity: 'me@work.com', sessions: 2, lastActivity: NOW },
      { provider: 'claude', label: 'personal', identity: null, sessions: 1, lastActivity: NOW }
    ])
  })

  it('buckets session starts into local hours, split by agent', async () => {
    const file = claudeLog('hours.jsonl', [])
    const at = (h: number): number => new Date(2026, 7, 10, h, 30).getTime()
    const p = await buildProfile(
      [
        meta({ provider: 'claude', sourcePath: file, startedAt: at(9) }),
        meta({ provider: 'codex', sourcePath: file, startedAt: at(9) }),
        meta({ provider: 'claude', sourcePath: file, startedAt: at(22) })
      ],
      { now: NOW, login: null }
    )
    expect(p.hours).toHaveLength(24)
    expect(p.hours[9]).toEqual({ sessions: 2, byProvider: { claude: 1, codex: 1 } })
    expect(p.hours[22]).toEqual({ sessions: 1, byProvider: { claude: 1 } })
    expect(p.hours.reduce((a, h) => a + h.sessions, 0)).toBe(3)
  })

  it('splits languages by the agent that wrote the lines', async () => {
    const claudeFile = claudeLog('lang-a.jsonl', [
      [{ type: 'tool_use', name: 'Write', input: { file_path: '/r/a.ts', content: 'a\nb\nc' } }]
    ])
    const copilotFile = copilotLog('lang-b.jsonl', [
      {
        type: 'tool.execution_start',
        data: { toolName: 'create', arguments: { path: '/r/b.ts', file_text: 'x' } }
      }
    ])
    const p = await buildProfile(
      [
        meta({ provider: 'claude', sourcePath: claudeFile }),
        meta({ provider: 'copilot', sourcePath: copilotFile })
      ],
      { now: NOW, login: null }
    )
    expect(p.languages).toEqual([
      { ext: 'ts', files: 2, linesAdded: 4, byProvider: { claude: 3, copilot: 1 } }
    ])
  })
})

// `messageCount` counts log records, and Claude writes one per tool call and one per
// result — so a rate built on it read Claude as several times chattier than the others.
// Prompts are what the person sent, counted alike for every agent.
describe('buildProfile — prompts', () => {
  const claudeUser = (content: unknown, extra: object = {}): unknown => ({
    type: 'user',
    message: { role: 'user', content },
    ...extra
  })

  it('counts what was typed to claude, not tool results or injected context', async () => {
    const file = join(root, 'claude-prompts.jsonl')
    const lines = [
      claudeUser('Add retries to the webhook handler'),
      { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      claudeUser([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      { type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: {} }] } },
      claudeUser([{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }]),
      claudeUser([{ type: 'text', text: 'Now cover it with a test' }]),
      claudeUser('<command-name>/review</command-name>\n<command-message>review</command-message>'),
      claudeUser('<local-command-stdout>done</local-command-stdout>'),
      claudeUser('Caveat: the messages below were generated by the user…', { isMeta: true }),
      claudeUser('This session is being continued from a previous conversation…', { isCompactSummary: true }),
      claudeUser('[Request interrupted by user for tool use]')
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file, messageCount: 11 })], {
      now: NOW,
      login: null
    })
    const agent = p.providers[0]
    expect(agent.prompts).toBe(3) // the two typed prompts and the slash command
    expect(agent.readSessions).toBe(1)
    expect(agent.toolCalls).toBe(2)
  })

  it("counts codex's user_message events, not the context it injects as user items", async () => {
    const file = join(root, 'codex-prompts.jsonl')
    const item = (text: string): unknown => ({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    })
    const echo = (message: string): unknown => ({ type: 'event_msg', payload: { type: 'user_message', message } })
    writeFileSync(
      file,
      [
        item('<environment_context>\n  <cwd>/r</cwd>\n</environment_context>'),
        item('# AGENTS.md instructions for /r'),
        item('Backfill the tenant_id column.'),
        echo('Backfill the tenant_id column.'),
        item('Then drop the old index.'),
        echo('Then drop the old index.')
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')
    )
    const p = await buildProfile([meta({ provider: 'codex', sourcePath: file })], { now: NOW, login: null })
    expect(p.providers[0].prompts).toBe(2)
  })

  it('falls back to codex user items, minus the injected ones, where no events were written', async () => {
    const file = join(root, 'codex-prompts-items.jsonl')
    writeFileSync(
      file,
      ['<environment_context/>', '# AGENTS.md instructions for /r', 'List unused IAM roles.']
        .map((text) =>
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
          })
        )
        .join('\n')
    )
    const p = await buildProfile([meta({ provider: 'codex', sourcePath: file })], { now: NOW, login: null })
    expect(p.providers[0].prompts).toBe(1)
  })

  it("counts copilot's user.message events", async () => {
    const file = copilotLog('copilot-prompts.jsonl', [
      { type: 'user.message', data: { content: 'Fix typos.' } },
      { type: 'assistant.message', data: { content: 'On it.' } },
      { type: 'tool.execution_start', data: { toolName: 'bash', arguments: {} } },
      { type: 'user.message', data: { content: 'And the headings.' } }
    ])
    const p = await buildProfile([meta({ provider: 'copilot', sourcePath: file })], { now: NOW, login: null })
    expect(p.providers[0].prompts).toBe(2)
    expect(p.providers[0].toolCalls).toBe(1)
  })

  it('counts every tool call, not just the top ones it lists', async () => {
    const file = claudeLog(
      'many-tools.jsonl',
      Array.from({ length: 10 }, (_, i) => [{ type: 'tool_use', name: `Tool${i}`, input: {} }])
    )
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file })], { now: NOW, login: null })
    expect(p.providers[0].tools).toHaveLength(8)
    expect(p.providers[0].toolCalls).toBe(10)
  })
})

describe('buildProfile — aggregation', () => {
  it('ranks agents by sessions and repos by session count', async () => {
    const file = claudeLog('rank.jsonl', [])
    const repoA = { key: 'a', name: 'alpha', root: '/a', host: null, owner: null }
    const repoB = { key: 'b', name: 'beta', root: '/b', host: null, owner: null }
    const sessions = [
      ...Array.from({ length: 3 }, () =>
        meta({ provider: 'copilot', sourcePath: file, repo: repoA as never })
      ),
      meta({ provider: 'claude', sourcePath: file, repo: repoB as never }),
      meta({ provider: 'claude', sourcePath: file, repo: repoA as never })
    ]
    const p = await buildProfile(sessions, { now: NOW, login: 'octocat' })
    expect(p.login).toBe('octocat')
    expect(p.providers.map((x) => x.provider)).toEqual(['copilot', 'claude'])
    expect(p.repos.map((r) => [r.name, r.sessions])).toEqual([
      ['alpha', 4],
      ['beta', 1]
    ])
    // which agent did the work in which repo
    expect(p.repos[0].byProvider).toEqual({ copilot: 3, claude: 1 })
  })

  it("names a repo by its GitHub owner/repo when the remote gives one", async () => {
    const file = claudeLog('fullname.jsonl', [])
    const repo = { key: 'gh:acme/atlas', name: 'atlas', fullName: 'acme/atlas', root: '/a' }
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file, repo })], {
      now: NOW,
      login: null
    })
    expect(p.repos[0]).toMatchObject({ name: 'atlas', fullName: 'acme/atlas' })
  })

  it('groups sessions with no repo under General', async () => {
    const file = claudeLog('general.jsonl', [])
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file })], {
      now: NOW,
      login: null
    })
    expect(p.repos).toEqual([
      {
        key: 'general',
        name: 'General',
        fullName: null,
        sessions: 1,
        byProvider: { claude: 1 },
        lastActivity: NOW
      }
    ])
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
