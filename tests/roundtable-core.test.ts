import { describe, it, expect } from 'vitest'
import {
  buildTurnPrompt,
  clampRounds,
  deriveTitle,
  entryLabel,
  formatEntries,
  parseStance,
  sanitizeRoundtable,
  seatOptions,
  type TableInfo
} from '../src/main/roundtable-core'
import {
  DEFAULT_ROUNDTABLE_LIMITS,
  duplicateSeats,
  roundRefusal,
  roundsAllowed,
  sanitizeRoundtableLimits,
  seatDisplayName
} from '../src/shared/roundtable'
import type { ModelEndpoint, RoundtableEntry, RoundtableParticipant } from '../src/shared/types'

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

describe('seatOptions', () => {
  const ANTHROPIC: ModelEndpoint = {
    id: 'ep-a',
    label: 'Gateway',
    type: 'anthropic',
    baseUrl: 'https://gw.example/v1'
  }
  const OPENAI: ModelEndpoint = {
    id: 'ep-o',
    label: 'Local',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1'
  }
  const ENDPOINTS = [ANTHROPIC, OPENAI]

  it('each seat carries its own model and model provider', () => {
    expect(seatOptions('claude', {}, ENDPOINTS)).toBeUndefined()
    expect(seatOptions('claude', { model: ' opus ' }, ENDPOINTS)).toEqual({ model: 'opus' })
    expect(seatOptions('claude', { model: 'big', modelEndpoint: 'ep-a' }, ENDPOINTS)).toEqual({
      model: 'big',
      modelEndpoint: 'ep-a'
    })
    // claude on a custom provider may leave the model to that provider's default
    expect(seatOptions('claude', { modelEndpoint: 'ep-a' }, ENDPOINTS)).toEqual({
      modelEndpoint: 'ep-a'
    })
    expect(seatOptions('copilot', { model: 'llama3', modelEndpoint: 'ep-o' }, ENDPOINTS)).toEqual({
      model: 'llama3',
      modelEndpoint: 'ep-o'
    })
  })

  it('refuses the table rather than letting a seat fail its first turn', () => {
    // a provider removed since the form loaded, or one the renderer invented
    expect(() => seatOptions('claude', { modelEndpoint: 'gone' }, ENDPOINTS)).toThrow(
      /no longer configured/
    )
    // an agent the provider type cannot run
    expect(() => seatOptions('claude', { modelEndpoint: 'ep-o' }, ENDPOINTS)).toThrow(/can't run/)
    expect(() => seatOptions('codex', { modelEndpoint: 'ep-a' }, ENDPOINTS)).toThrow(/can't run/)
    // copilot never learns a custom provider's catalog on its own
    expect(() => seatOptions('copilot', { modelEndpoint: 'ep-o' }, ENDPOINTS)).toThrow(
      /explicit model/
    )
    // a model name rides as an argv value
    expect(() => seatOptions('claude', { model: '--dangerous' }, ENDPOINTS)).toThrow(/model name/)
    expect(() => seatOptions('claude', { model: 'a b' }, ENDPOINTS)).toThrow(/model name/)
  })

  it('a table saved before per-table limits loads with the defaults', () => {
    const rt = sanitizeRoundtable({ id: 'x', cwd: '/r', participants: [seat()], entries: [] })
    expect(rt?.limits).toEqual(DEFAULT_ROUNDTABLE_LIMITS)
    const kept = sanitizeRoundtable({
      id: 'x',
      cwd: '/r',
      participants: [seat()],
      entries: [],
      limits: { maxTurnsPerMessage: 8, maxTurnsPerTable: 0 }
    })
    expect(kept?.limits).toEqual({ maxTurnsPerMessage: 8, maxTurnsPerTable: 0 })
  })

  it('takes each agent’s own thinking levels and knobs, and drops another agent’s', () => {
    expect(
      seatOptions('codex', { model: 'gpt-5.5', effort: 'ultra', fast: true, longContext: true }, [])
    ).toEqual({ model: 'gpt-5.5', effort: 'ultra', fast: true })
    expect(seatOptions('copilot', { effort: 'none', longContext: true, fast: true }, [])).toEqual({
      effort: 'none',
      longContext: true
    })
    expect(() => seatOptions('claude', { effort: 'ultra' }, [])).toThrow(/no "ultra" thinking level/)
    expect(() => seatOptions('copilot', { effort: 7 }, [])).toThrow(/thinking level/)
  })

  it('ignores anything that is not a string', () => {
    expect(seatOptions('claude', { model: 7, modelEndpoint: '' }, ENDPOINTS)).toBeUndefined()
  })
})

describe('roundtable limits', () => {
  it('anything out of range is the default, field by field', () => {
    expect(sanitizeRoundtableLimits(undefined)).toEqual(DEFAULT_ROUNDTABLE_LIMITS)
    expect(sanitizeRoundtableLimits({ maxTurnsPerMessage: 1, maxTurnsPerTable: 0 })).toEqual({
      maxTurnsPerMessage: 16,
      maxTurnsPerTable: 0
    })
    expect(sanitizeRoundtableLimits({ maxTurnsPerMessage: 99, maxTurnsPerTable: 2.5 })).toEqual(
      DEFAULT_ROUNDTABLE_LIMITS
    )
  })

  it('a message buys whole rounds, and always at least its wave', () => {
    const limits = { maxTurnsPerMessage: 16, maxTurnsPerTable: 80 }
    expect(roundsAllowed(limits, 2)).toBe(8)
    expect(roundsAllowed(limits, 3)).toBe(5)
    expect(roundsAllowed(limits, 6)).toBe(2)
    expect(roundsAllowed({ ...limits, maxTurnsPerMessage: 4 }, 6)).toBe(1)
  })

  it('refuses a round the table cannot afford, counting failed replies as spent', () => {
    const participants = [seat(), seat({ provider: 'codex' })]
    const entries = [
      entry('user', 'q'),
      entry('claude', 'a', 0),
      { ...entry('codex', 'boom', 1), error: true }
    ]
    const limits = { ...DEFAULT_ROUNDTABLE_LIMITS, maxTurnsPerTable: 4 }
    expect(roundRefusal(limits, { participants, entries })).toBeNull()
    expect(roundRefusal({ ...limits, maxTurnsPerTable: 3 }, { participants, entries })).toMatch(
      /spent 2 of its 3 agent turns/
    )
    // 0 switches the ceiling off
    expect(roundRefusal({ ...limits, maxTurnsPerTable: 0 }, { participants, entries })).toBeNull()
  })

  it('marks the later seat of an identical pair, never the first', () => {
    expect(duplicateSeats(['claude||opus', 'codex||', 'claude||opus', 'claude||haiku'])).toEqual([
      false,
      false,
      true,
      false
    ])
  })
})
