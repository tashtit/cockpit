import { describe, it, expect } from 'vitest'
import {
  buildTurnPrompt,
  clampRounds,
  deriveTitle,
  entryLabel,
  formatEntries,
  parseStance,
  sanitizeRoundtable,
  type TableInfo
} from '../src/main/roundtable-core'
import { seatDisplayName } from '../src/shared/roundtable'
import type { RoundtableEntry, RoundtableParticipant } from '../src/shared/types'

function seat(overrides: Partial<RoundtableParticipant> = {}): RoundtableParticipant {
  return { provider: 'claude', nativeSessionId: null, seenUpTo: 0, ...overrides }
}

function entry(
  speaker: RoundtableEntry['speaker'],
  text: string,
  seatIdx?: number
): RoundtableEntry {
  return { speaker, text, at: 1, ...(seatIdx !== undefined ? { seat: seatIdx } : {}) }
}

function table(overrides: Partial<TableInfo> = {}): TableInfo {
  return {
    cwd: '/ws/table',
    branch: 'cockpit/table-x',
    repoRoot: '/repo',
    mode: 'open',
    participants: [seat(), seat({ provider: 'codex' })],
    entries: [entry('user', 'should we adopt biome?')],
    ...overrides
  }
}

describe('seat naming', () => {
  it('unique providers keep their plain names', () => {
    const parts = [seat(), seat({ provider: 'codex' })]
    expect(seatDisplayName(parts, 0)).toBe('Claude Code')
    expect(entryLabel(parts, entry('codex', 'x', 1))).toBe('Codex')
    expect(entryLabel(parts, entry('claude', 'x', 0), 0)).toBe('You (Claude Code)')
  })

  it('twin seats disambiguate by model, then ordinal', () => {
    const parts = [
      seat({ options: { model: 'opus' } }),
      seat({ options: { model: 'haiku' } }),
      seat({ provider: 'codex' })
    ]
    expect(seatDisplayName(parts, 0)).toBe('Claude Code · opus')
    expect(seatDisplayName(parts, 1)).toBe('Claude Code · haiku')
    const nameless = [seat(), seat()]
    expect(seatDisplayName(nameless, 0)).toBe('Claude Code #1')
    expect(seatDisplayName(nameless, 1)).toBe('Claude Code #2')
  })

  it("old entries without a seat index resolve to the provider's first seat", () => {
    const parts = [seat({ options: { model: 'opus' } }), seat({ options: { model: 'haiku' } })]
    expect(entryLabel(parts, entry('claude', 'x'))).toBe('Claude Code · opus')
  })
})

describe('formatEntries', () => {
  it('skips error entries — a failed turn is not discussion content', () => {
    const parts = [seat(), seat({ provider: 'codex' })]
    const out = formatEntries(parts, [
      entry('user', 'topic'),
      { speaker: 'codex', text: 'auth expired', at: 1, error: true, seat: 1 },
      entry('claude', 'real point', 0)
    ])
    expect(out).toContain('[User]: topic')
    expect(out).toContain('[Claude Code]: real point')
    expect(out).not.toContain('auth expired')
  })
})

describe('buildTurnPrompt', () => {
  it('first turn: full framing, other seats named, transcript included, read-only stated', () => {
    const p = buildTurnPrompt(table(), 0)
    expect(p).toContain('You are Claude Code')
    expect(p).toContain('Codex')
    expect(p).toContain('Ground rules')
    expect(p).toContain('[User]: should we adopt biome?')
    expect(p).toContain('/ws/table')
    expect(p).toContain('read-only for this discussion')
  })

  it('repo-less tables say so instead of pointing at a directory', () => {
    const p = buildTurnPrompt(table({ repoRoot: null, branch: null }), 0)
    expect(p).toContain('free-standing discussion')
    expect(p).not.toContain('working directory')
  })

  it('resumable seat gets only the delta, never its own lines', () => {
    const t = table({
      participants: [seat({ nativeSessionId: 'c1', seenUpTo: 2 }), seat({ provider: 'codex' })],
      entries: [
        entry('user', 'topic line'),
        entry('claude', 'my earlier point', 0),
        entry('codex', 'codex answers', 1),
        entry('user', 'follow-up question')
      ]
    })
    const p = buildTurnPrompt(t, 0)
    expect(p).toContain('The roundtable continues')
    expect(p).toContain('[Codex]: codex answers')
    expect(p).toContain('[User]: follow-up question')
    expect(p).not.toContain('topic line')
    expect(p).not.toContain('my earlier point')
    expect(p).not.toContain('Ground rules')
  })

  it("twin seats never see their own lines but do see their twin's", () => {
    const t = table({
      participants: [
        seat({ nativeSessionId: 'c1', seenUpTo: 1, options: { model: 'opus' } }),
        seat({ options: { model: 'haiku' } })
      ],
      entries: [
        entry('user', 'topic'),
        entry('claude', 'opus point', 0),
        entry('claude', 'haiku point', 1)
      ]
    })
    const p = buildTurnPrompt(t, 0)
    expect(p).not.toContain('opus point') // its own
    expect(p).toContain('[Claude Code · haiku]: haiku point')
  })

  it('session-less seat (copilot) always gets the full transcript, own lines as You', () => {
    const t = table({
      participants: [seat(), seat({ provider: 'copilot' })],
      entries: [
        entry('user', 'topic line'),
        entry('copilot', 'what copilot said before', 1),
        entry('claude', 'claude reacts', 0)
      ]
    })
    const p = buildTurnPrompt(t, 1)
    expect(p).toContain('Ground rules')
    expect(p).toContain('[You (Copilot)]: what copilot said before')
    expect(p).toContain('[Claude Code]: claude reacts')
  })

  it('caps runaway entries so the prompt stays argv-sized', () => {
    const t = table({ entries: [entry('user', 'x'.repeat(10_000))] })
    const p = buildTurnPrompt(t, 0)
    expect(p).toContain('…[truncated]')
    expect(p.length).toBeLessThan(50_000)
  })
})

describe('consensus protocol', () => {
  it('consensus tables get the stance rule in the framing and every ask', () => {
    const t = table({ mode: 'consensus' })
    const first = buildTurnPrompt(t, 0)
    expect(first).toContain('CONSENSUS: agree')
    expect(first).toContain('end with your CONSENSUS line')
    // resumable delta prompts skip the framing but still carry the reminder
    const t2 = table({
      mode: 'consensus',
      participants: [seat({ nativeSessionId: 'c1', seenUpTo: 1 }), seat({ provider: 'codex' })]
    })
    const delta = buildTurnPrompt(t2, 0)
    expect(delta).not.toContain('Ground rules')
    expect(delta).toContain('end with your CONSENSUS line')
    // open tables never mention the protocol
    expect(buildTurnPrompt(table(), 0)).not.toContain('CONSENSUS')
  })

  it("parseStance pulls the trailing marker off and keeps the seat's own line", () => {
    expect(parseStance('I think X.\n\nCONSENSUS: agree')).toEqual({
      stance: 'agree',
      text: 'I think X.'
    })
    // the note after the dash is the seat's one-liner — the outcome panel's raw material
    expect(parseStance('Body.\nCONSENSUS: agree — one tool, fewer configs')).toEqual({
      stance: 'agree',
      note: 'one tool, fewer configs',
      text: 'Body.'
    })
    expect(parseStance('Point.\n**CONSENSUS:** not yet — perf unproven')).toMatchObject({
      stance: 'continue',
      note: 'perf unproven',
      text: 'Point.'
    })
    expect(parseStance('> consensus: Agree')).toMatchObject({ stance: 'agree' })
    // "agreed" is the same answer as "agree" — a near-miss must not read as dissent
    expect(parseStance('Body.\nCONSENSUS: agreed — ship it behind a flag')).toEqual({
      stance: 'agree',
      note: 'ship it behind a flag',
      text: 'Body.'
    })
    // absence of agreement is never agreement
    expect(parseStance('CONSENSUS: maybe?')).toMatchObject({ stance: 'continue' })
    expect(parseStance('no marker at all')).toEqual({ text: 'no marker at all' })
    // the marker only counts as protocol on the final line
    expect(parseStance('CONSENSUS: agree\nbut actually more prose')).toEqual({
      text: 'CONSENSUS: agree\nbut actually more prose'
    })
  })

  it('clampRounds bounds renderer input to a sane cap', () => {
    expect(clampRounds(4)).toBe(4)
    expect(clampRounds(0)).toBe(3)
    expect(clampRounds(99)).toBe(3)
    expect(clampRounds('7')).toBe(3)
    expect(clampRounds(undefined)).toBe(3)
  })
})

describe('deriveTitle', () => {
  it('keeps a short topic as-is and falls back when empty', () => {
    expect(deriveTitle('adopt biome?')).toBe('adopt biome?')
    expect(deriveTitle('  ')).toBe('Roundtable')
  })
  it('uses only the first line, trimmed at a word boundary', () => {
    expect(deriveTitle('first line\nsecond line')).toBe('first line')
    const long = 'should we migrate the entire indexing pipeline to incremental scanning now'
    const title = deriveTitle(long)
    expect(title.length).toBeLessThanOrEqual(57)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toContain('\n')
  })
})

describe('sanitizeRoundtable', () => {
  const valid = {
    id: 'rt-1',
    title: 'T',
    topic: 'topic',
    createdAt: 1,
    updatedAt: 2,
    cwd: '/ws',
    repoRoot: null,
    branch: null,
    permissionMode: 'auto-edit',
    participants: [{ provider: 'claude', nativeSessionId: 'c1', seenUpTo: 2 }],
    entries: [{ speaker: 'user', text: 'hi', at: 1 }]
  }

  it('accepts a plausible saved table; discussions are always safe', () => {
    const rt = sanitizeRoundtable(valid)
    expect(rt).not.toBeNull()
    expect(rt!.participants[0].nativeSessionId).toBe('c1')
    expect(rt!.participants[0].seenUpTo).toBe(2)
    // even a pre-existing auto-edit file loads as read-only — tables never write
    expect(rt!.permissionMode).toBe('safe')
    expect(rt!.mode).toBe('open')
    expect(rt!.maxRounds).toBe(3)
    expect(rt!.roundsRun).toBe(0)
    expect(rt!.concluded).toBe(false)
  })

  it('keeps consensus cycle state, entry stances, and seat indexes across restarts', () => {
    const rt = sanitizeRoundtable({
      ...valid,
      mode: 'consensus',
      maxRounds: 5,
      roundsRun: 2,
      concluded: true,
      entries: [
        { speaker: 'claude', text: 'pos', at: 1, stance: 'agree', stanceNote: 'ship it', seat: 0 },
        { speaker: 'claude', text: 'x', at: 3, stance: 'nonsense', stanceNote: 42, seat: -1 }
      ]
    })
    expect(rt!.mode).toBe('consensus')
    expect(rt!.maxRounds).toBe(5)
    expect(rt!.roundsRun).toBe(2)
    expect(rt!.concluded).toBe(true)
    expect(rt!.entries[0]).toMatchObject({ stance: 'agree', stanceNote: 'ship it', seat: 0 })
    expect(rt!.entries[1].stance).toBeUndefined()
    expect(rt!.entries[1].stanceNote).toBeUndefined()
    expect(rt!.entries[1].seat).toBeUndefined()
  })

  it('rejects garbage and unknown providers', () => {
    expect(sanitizeRoundtable(null)).toBeNull()
    expect(sanitizeRoundtable('nope')).toBeNull()
    expect(sanitizeRoundtable({})).toBeNull()
    expect(sanitizeRoundtable({ ...valid, participants: [{ provider: 'gemini' }] })).toBeNull()
    expect(sanitizeRoundtable({ ...valid, participants: [] })).toBeNull()
  })

  it('drops malformed entries', () => {
    const rt = sanitizeRoundtable({
      ...valid,
      entries: [
        { speaker: 'user', text: 'ok', at: 1 },
        { speaker: 'gemini', text: 'skip me', at: 1 },
        { text: 'no speaker' },
        { speaker: 'claude', text: 'kept', at: 2, error: true }
      ]
    })
    expect(rt!.entries.map((e) => e.text)).toEqual(['ok', 'kept'])
    expect(rt!.entries[1].error).toBe(true)
  })
})
