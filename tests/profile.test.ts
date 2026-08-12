import { beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProfile, dayKey, streaks } from '../src/main/profile'
import type { Provider, SessionMeta } from '../src/shared/types'

const root = join(tmpdir(), 'cockpit-profile-fixtures')

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
      { ext: 'tsx', files: 1, linesAdded: 4 },
      { ext: 'ts', files: 1, linesAdded: 3 }
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
    expect(p.languages).toEqual([{ ext: 'py', files: 1, linesAdded: 4 }])
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

  it('buckets session starts into local hours and averages turns', async () => {
    const file = claudeLog('hours.jsonl', [])
    const at = (h: number): number => new Date(2026, 7, 10, h, 30).getTime()
    const p = await buildProfile(
      [
        meta({ provider: 'claude', sourcePath: file, startedAt: at(9), messageCount: 10 }),
        meta({ provider: 'claude', sourcePath: file, startedAt: at(9), messageCount: 20 }),
        meta({ provider: 'claude', sourcePath: file, startedAt: at(22), messageCount: 33 })
      ],
      { now: NOW, login: null }
    )
    expect(p.hourCounts[9]).toBe(2)
    expect(p.hourCounts[22]).toBe(1)
    expect(p.hourCounts.reduce((a, b) => a + b, 0)).toBe(3)
    expect(p.providers[0].avgTurns).toBe(21) // (10+20+33)/3 rounded
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
  })

  it('groups sessions with no repo under General', async () => {
    const file = claudeLog('general.jsonl', [])
    const p = await buildProfile([meta({ provider: 'claude', sourcePath: file })], {
      now: NOW,
      login: null
    })
    expect(p.repos).toEqual([
      { key: 'general', name: 'General', sessions: 1, lastActivity: NOW }
    ])
  })
})
