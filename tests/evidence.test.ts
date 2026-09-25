import { describe, expect, it } from 'vitest'
import { buildEvidence, seatSessions } from '../src/renderer/src/evidence'
import type { RoundtableParticipant, SessionMessage, SessionMeta } from '../src/shared/types'

const user = (text: string, ts?: number): SessionMessage => ({ role: 'user', kind: 'text', text, ...(ts ? { ts } : {}) })
const say = (text: string): SessionMessage => ({ role: 'assistant', kind: 'text', text })
const call = (toolName: string, preview: string, extra: Partial<SessionMessage> = {}): SessionMessage => ({
  role: 'assistant',
  kind: 'tool_call',
  toolName,
  text: '{"raw":"json"}',
  preview,
  ...extra
})
const result = (text: string): SessionMessage => ({ role: 'tool', kind: 'tool_result', text })

describe('buildEvidence: what a seat’s replies rest on', () => {
  it('splits the log into turns at each relayed prompt, newest first, with the reply each gave', () => {
    const log = [
      user('Is takt.com taken?', 1),
      call('Bash', 'dig +short takt.com A'),
      result('104.21.3.9\n172.67.1.1'),
      call('WebSearch', 'takt.com owner'),
      say('Taken — it resolves.\n\nMore detail.'),
      user('And tandem.dev?', 2),
      call('WebFetch', 'https://rdap.org/domain/tandem.dev'),
      result('(result)'),
      call('Read', '/room/notes.md'),
      call('mcp__search__query', 'names like takt'),
      call('TodoWrite', '3 steps'),
      say('Free.')
    ]
    const turns = buildEvidence(log)
    expect(turns.map((t) => [t.ts, t.reply])).toEqual([
      [2, 'Free.'],
      [1, 'Taken — it resolves.']
    ])
    expect(turns[0]!.items.map((i) => [i.kind, i.text])).toEqual([
      ['page', 'https://rdap.org/domain/tandem.dev'],
      ['file', '/room/notes.md'],
      ['other', 'names like takt']
    ])
    // the result the row paired with, not a placeholder; the raw input is never the headline
    expect(turns[1]!.items[0]).toMatchObject({ kind: 'command', text: 'dig +short takt.com A', result: '104.21.3.9\n172.67.1.1' })
    expect(turns[0]!.items[0]).not.toHaveProperty('result')
  })

  it('tells a call that failed from one the seat’s safe mode never let run, and drops turns that gathered nothing', () => {
    const turns = buildEvidence([
      user('first'),
      say('From memory.'),
      user('second'),
      call('shell', 'curl -sf https://registry.npmjs.org/takt', { failed: true }),
      result('exit 22'),
      call('Bash', 'dig +short takt.com', { failed: true }),
      result('This command requires approval'),
      call('Bash', 'for n in a b; do curl "$n"; done', { failed: true }),
      result('Contains simple_expansion'),
      call('WebSearch', 'takt', { failed: true }),
      result("Claude requested permissions to use WebSearch, but you haven't granted it yet."),
      call('Bash', 'ls'),
      say('Checked.')
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.items.map((i) => i.outcome)).toEqual(['failed', 'refused', 'refused', 'refused', 'ok'])
    expect(turns[0]!.items[0]).toMatchObject({ kind: 'command', result: 'exit 22' })
  })
})

describe('seatSessions: whose log is whose', () => {
  const meta = (id: string, provider: SessionMeta['provider'], startedAt: number): SessionMeta =>
    ({ id, provider, startedAt }) as SessionMeta
  const seat = (provider: RoundtableParticipant['provider'], nativeSessionId: string | null): RoundtableParticipant => ({
    provider,
    nativeSessionId,
    seenUpTo: 0
  })

  it('matches a seat that named its session, and gives an agent’s other sessions to its unnamed seat', () => {
    const sessions = [meta('claude:c1', 'claude', 1), meta('copilot:a', 'copilot', 3), meta('copilot:b', 'copilot', 2)]
    const got = seatSessions([seat('claude', 'c1'), seat('copilot', null)], sessions)
    expect(got.map((g) => [g.sessions.map((s) => s.id), g.shared])).toEqual([
      [['claude:c1'], false],
      [['copilot:b', 'copilot:a'], false]
    ])
  })

  it('shows two unnamed seats of one agent all of its sessions, and says the logs can’t tell them apart', () => {
    const got = seatSessions([seat('copilot', null), seat('copilot', null)], [meta('copilot:a', 'copilot', 1)])
    expect(got.map((g) => g.shared)).toEqual([true, true])
    expect(got[1]!.sessions.map((s) => s.id)).toEqual(['copilot:a'])
  })

  it('finds nothing for a seat whose log isn’t indexed yet', () => {
    expect(seatSessions([seat('codex', 'x9')], [])).toEqual([{ sessions: [], shared: false }])
  })
})
