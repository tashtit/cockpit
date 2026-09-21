import { describe, it, expect, vi, afterAll } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoundtableManager, type NewTable } from '../src/main/roundtable'
import { DEFAULT_ROUNDTABLE_LIMITS } from '../src/shared/roundtable'
import type { ChatRequest, RoundtableEvent } from '../src/shared/types'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cockpit-rt-'))
  dirs.push(d)
  return d
}

type Harness = {
  manager: RoundtableManager
  sent: ChatRequest[]
  events: RoundtableEvent[]
  cancelled: string[]
  turnIdOf: (n: number) => string
}

/** A manager whose "CLI" is the test: sendTurn records the request, the test replays events. */
function makeManager(dir: string): Harness {
  const sent: ChatRequest[] = []
  const events: RoundtableEvent[] = []
  const cancelled: string[] = []
  const manager = new RoundtableManager(dir, {
    sendTurn: vi.fn((req: ChatRequest) => {
      sent.push(req)
      return `turn-${sent.length}`
    }),
    cancelTurn: vi.fn((id: string) => cancelled.push(id)),
    emit: (ev) => events.push(ev)
  })
  return { manager, sent, events, cancelled, turnIdOf: (n) => `turn-${n}` }
}

const TWO_SEATS: NewTable = {
  topic: 'should we adopt incremental indexing?',
  seats: [{ provider: 'claude' }, { provider: 'codex' }]
}

/** Replay one agent turn's stream: optional session id, text chunks, optional error, done. */
function replayTurn(
  h: Harness,
  turnId: string,
  opts: { session?: string; text?: string[]; error?: string } = {}
): void {
  if (opts.session) {
    expect(h.manager.handleChatEvent({ turnId, type: 'session', nativeSessionId: opts.session })).toBe(true)
  }
  for (const text of opts.text ?? []) h.manager.handleChatEvent({ turnId, type: 'text', text })
  if (opts.error) h.manager.handleChatEvent({ turnId, type: 'error', message: opts.error })
  h.manager.handleChatEvent({ turnId, type: 'done' })
}

describe('RoundtableManager', () => {
  it('a consensus table stops at what one message may spend, not only at its own cap', () => {
    // 2 seats, 4 turns a message: two rounds, though the table asked for five
    const h = makeManager(newDir())
    const snap = h.manager.create(
      {
        ...TWO_SEATS,
        mode: 'consensus',
        maxRounds: 5,
        limits: { ...DEFAULT_ROUNDTABLE_LIMITS, maxTurnsPerMessage: 4 }
      },
      null
    )
    for (let turn = 1; turn <= 4; turn++) {
      replayTurn(h, h.turnIdOf(turn), { text: ['still thinking\nCONSENSUS: continue — not yet'] })
    }
    const after = h.manager.get(snap.id)
    expect(h.sent).toHaveLength(4)
    expect(after.running).toBe(false)
    expect(after.concluded).toBe(true)
    expect(after.roundsRun).toBe(2)
  })

  it('a table that has spent its turns refuses the next round, and says how to go on', () => {
    const dir = newDir()
    const h = makeManager(dir)
    const snap = h.manager.create(
      { ...TWO_SEATS, limits: { ...DEFAULT_ROUNDTABLE_LIMITS, maxTurnsPerTable: 3 } },
      null
    )
    replayTurn(h, h.turnIdOf(1), { text: ['one'] })
    replayTurn(h, h.turnIdOf(2), { text: ['two'] })

    expect(() => h.manager.sendMessage(snap.id, 'and?')).toThrow(/spent 2 of its 3 agent turns/)
    expect(() => h.manager.continueRound(snap.id)).toThrow(/Raise the table’s limit/)
    // nothing was recorded or launched for the refused message
    expect(h.manager.get(snap.id).entries).toHaveLength(3)
    expect(h.sent).toHaveLength(2)

    // raising the table's own ceiling lets it go on — and the raise is persisted
    const raised = h.manager.setLimits(snap.id, { ...DEFAULT_ROUNDTABLE_LIMITS, maxTurnsPerTable: 10 })
    expect(raised.limits.maxTurnsPerTable).toBe(10)
    const saved = JSON.parse(readFileSync(join(dir, `${snap.id}.json`), 'utf8'))
    expect(saved.limits).toEqual({ ...DEFAULT_ROUNDTABLE_LIMITS, maxTurnsPerTable: 10 })
    h.manager.sendMessage(snap.id, 'and?')
    expect(h.sent).toHaveLength(4)
  })

  it('runs each seat on its own model and model provider', () => {
    const h = makeManager(newDir())
    h.manager.create(
      {
        topic: 'depth or speed?',
        seats: [
          { provider: 'claude', options: { model: 'opus', modelEndpoint: 'ep-a' } },
          { provider: 'claude', options: { model: 'haiku' } },
          { provider: 'codex', options: { model: 'gpt-5-codex' } }
        ]
      },
      null
    )
    expect(h.sent.map((r) => r.options)).toEqual([
      { model: 'opus', modelEndpoint: 'ep-a' },
      { model: 'haiku' },
      // codex keeps the table's read-only posture on top of the seat's own choice
      { model: 'gpt-5-codex', codexSandbox: 'read-only', codexSkipGitCheck: true }
    ])
  })

  it('a seat whose turn cannot start fails alone, and the round still closes', () => {
    const dir = newDir()
    const sent: ChatRequest[] = []
    const events: RoundtableEvent[] = []
    const manager = new RoundtableManager(dir, {
      sendTurn: (req) => {
        if (req.provider === 'copilot') throw new Error('copilot is not logged in as "ghost"')
        sent.push(req)
        return `turn-${sent.length}`
      },
      cancelTurn: () => {},
      emit: (ev) => events.push(ev)
    })
    const snap = manager.create(
      { topic: 't', seats: [{ provider: 'claude' }, { provider: 'copilot', copilotUser: 'ghost' }] },
      null
    )
    // the copilot seat is on the record as failed, and is not shown as speaking
    expect(snap.speaking).toEqual([0])
    expect(snap.entries[1]).toMatchObject({ speaker: 'copilot', seat: 1, error: true })
    expect(snap.entries[1].text).toContain('ghost')
    expect(events).toContainEqual({ id: snap.id, type: 'turn-end', speaker: 'copilot', seat: 1 })

    manager.handleChatEvent({ turnId: 'turn-1', type: 'text', text: 'my view' })
    manager.handleChatEvent({ turnId: 'turn-1', type: 'done' })
    expect(manager.get(snap.id).running).toBe(false)
  })

  it('a user message opens a parallel wave: every seat launches at once, blind to the others', () => {
    const dir = newDir()
    const h = makeManager(dir)
    const snap = h.manager.create(TWO_SEATS, null)

    // opening state: user topic recorded, round running, scratch room made by main
    expect(snap.entries).toHaveLength(1)
    expect(snap.entries[0]).toMatchObject({ speaker: 'user', text: TWO_SEATS.topic })
    expect(snap.running).toBe(true)
    expect(snap.speaking).toEqual([0, 1])
    expect(existsSync(snap.cwd)).toBe(true)

    // both seats are already in flight — nobody waited for anybody
    expect(h.sent).toHaveLength(2)
    expect(h.sent.map((r) => r.provider)).toEqual(['claude', 'codex'])
    for (const req of h.sent) {
      expect(req.cwd).toBe(snap.cwd)
      expect(req.resumeNativeId).toBeUndefined()
      expect(req.prompt).toContain(TWO_SEATS.topic)
    }
    // wave prompts are independent: codex was not shown claude's (future) reply
    expect(h.sent[1].prompt).not.toContain('I say incremental')

    replayTurn(h, h.turnIdOf(1), { session: 'c-1', text: ['I say ', 'incremental.'] })
    // one seat finishing does not end the wave
    expect(h.manager.get(snap.id).running).toBe(true)
    expect(h.manager.get(snap.id).speaking).toEqual([1])
    replayTurn(h, h.turnIdOf(2), { session: 'x-1', text: ['Agreed, with a cache.'] })
    expect(h.manager.get(snap.id).running).toBe(false)

    // transcript persisted in finish order, session ids captured, and seenUpTo points
    // at what each seat was PROMPTED with (the user message), not the transcript end —
    // so the next delta carries the other seat's wave reply
    const disk = JSON.parse(readFileSync(join(dir, `${snap.id}.json`), 'utf8'))
    expect(disk.entries.map((e: { speaker: string }) => e.speaker)).toEqual([
      'user',
      'claude',
      'codex'
    ])
    expect(disk.participants[0]).toMatchObject({ provider: 'claude', nativeSessionId: 'c-1', seenUpTo: 1 })
    expect(disk.participants[1]).toMatchObject({ provider: 'codex', nativeSessionId: 'x-1', seenUpTo: 1 })

    // the renderer contract: two turns, per-seat turn-ends, absolute entry indexes,
    // and the round closes last
    expect(h.events.filter((e) => e.type === 'turn')).toHaveLength(2)
    expect(h.events.filter((e) => e.type === 'turn-end')).toHaveLength(2)
    const entries = h.events.filter((e) => e.type === 'entry')
    expect(entries.map((e) => (e.type === 'entry' ? e.index : -1))).toEqual([0, 1, 2])
    expect(h.events[h.events.length - 1]).toMatchObject({ type: 'round', running: false })
    expect(h.manager.list()[0]).toMatchObject({ id: snap.id, entryCount: 3, running: false, repoRoot: null })
  })

  it('resumes seats across a restart: delta prompts carry the other seats\' wave replies', () => {
    const dir = newDir()
    const first = makeManager(dir)
    const snap = first.manager.create(TWO_SEATS, null)
    replayTurn(first, first.turnIdOf(1), { session: 'c-1', text: ['claude round one'] })
    replayTurn(first, first.turnIdOf(2), { session: 'x-1', text: ['codex round one'] })

    // fresh manager over the same dir — as after an app restart
    const second = makeManager(dir)
    second.manager.sendMessage(snap.id, 'and what about memory use?')

    // the follow-up is a wave too: both seats fire at once
    expect(second.sent).toHaveLength(2)
    const req = second.sent[0]
    expect(req.provider).toBe('claude')
    expect(req.resumeNativeId).toBe('c-1')
    // delta only: what codex said in the wave plus the new user message — not the
    // framing, not the topic, not claude's own words
    expect(req.prompt).toContain('and what about memory use?')
    expect(req.prompt).toContain('[Codex]: codex round one')
    expect(req.prompt).not.toContain(TWO_SEATS.topic)
    expect(req.prompt).not.toContain('claude round one')
    expect(req.prompt).not.toContain('Ground rules')
    expect(second.sent[1]).toMatchObject({ provider: 'codex', resumeNativeId: 'x-1' })
  })

  it('"one more round" relays sequentially so seats answer each other', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(TWO_SEATS, null)
    replayTurn(h, h.turnIdOf(1), { session: 'c-1', text: ['claude round one'] })
    replayTurn(h, h.turnIdOf(2), { session: 'x-1', text: ['codex round one'] })

    h.manager.continueRound(snap.id)
    // sequential: only the first seat is in flight
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2].provider).toBe('claude')
    expect(h.sent[2].prompt).toContain('[Codex]: codex round one')
    replayTurn(h, h.turnIdOf(3), { text: ['claude round two'] })

    // now the second seat speaks, and it sees BOTH of claude's contributions
    expect(h.sent).toHaveLength(4)
    expect(h.sent[3].provider).toBe('codex')
    expect(h.sent[3].prompt).toContain('[Claude Code]: claude round one')
    expect(h.sent[3].prompt).toContain('[Claude Code]: claude round two')
    expect(h.sent[3].prompt).not.toContain('codex round one') // never its own words
    replayTurn(h, h.turnIdOf(4), { text: ['codex round two'] })
    expect(h.manager.get(snap.id).running).toBe(false)
  })

  it('a session-less seat (copilot) rides full-context prompts every round', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(
      { ...TWO_SEATS, seats: [{ provider: 'copilot' }, { provider: 'claude' }] },
      null
    )
    // copilot -p streams plain text and never announces a session id
    replayTurn(h, h.turnIdOf(1), { text: ['copilot round one'] })
    replayTurn(h, h.turnIdOf(2), { session: 'c-1', text: ['claude round one'] })
    expect(h.manager.get(snap.id).running).toBe(false)

    h.manager.continueRound(snap.id)
    const req = h.sent[2]
    expect(req.provider).toBe('copilot')
    expect(req.resumeNativeId).toBeUndefined()
    // no session to resume → the framing and its own earlier words come along again
    expect(req.prompt).toContain('Ground rules')
    expect(req.prompt).toContain('[You (Copilot)]: copilot round one')
    expect(req.prompt).toContain('[Claude Code]: claude round one')
  })

  it('one failed seat is recorded as an error entry and the wave still completes', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(TWO_SEATS, null)
    replayTurn(h, h.turnIdOf(1), { error: 'claude CLI not found' })

    const t = h.manager.get(snap.id)
    expect(t.entries[1]).toMatchObject({ speaker: 'claude', error: true, text: 'claude CLI not found' })
    expect(t.running).toBe(true) // codex is still thinking
    replayTurn(h, h.turnIdOf(2), { session: 'x-1', text: ['codex still answers'] })
    expect(h.manager.get(snap.id).running).toBe(false)

    // the failure is not discussion content: codex's NEXT prompt skips it too
    h.manager.continueRound(snap.id)
    expect(h.sent[2].provider).toBe('claude')
    replayTurn(h, h.turnIdOf(3), { session: 'c-2', text: ['claude recovers'] })
    expect(h.sent[3].provider).toBe('codex')
    expect(h.sent[3].prompt).not.toContain('claude CLI not found')
  })

  it('an errored turn whose only text is its failure banner becomes an annotation', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(TWO_SEATS, null)
    // claude prints auth failures as plain stream text, then exits non-zero
    replayTurn(h, h.turnIdOf(1), {
      text: ['Failed to authenticate: OAuth session expired and could not be refreshed'],
      error: 'claude exited with code 1'
    })

    const t = h.manager.get(snap.id)
    expect(t.entries[1]).toMatchObject({
      speaker: 'claude',
      error: true,
      text: 'Failed to authenticate: OAuth session expired and could not be refreshed'
    })
  })

  it('substantial text before a crash is kept as content, not downgraded', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(TWO_SEATS, null)
    const essay = 'A real point about the topic. '.repeat(10).trim() // ≥200 chars
    replayTurn(h, h.turnIdOf(1), { text: [essay], error: 'stream closed unexpectedly' })

    const t = h.manager.get(snap.id)
    expect(t.entries[1]).toMatchObject({ speaker: 'claude', text: essay })
    expect(t.entries[1].error).toBeUndefined()
  })

  it('discussion-only: safe mode everywhere, codex sandboxed read-only, trust check per room', () => {
    const scratch = makeManager(newDir())
    scratch.manager.create(TWO_SEATS, null)
    for (const req of scratch.sent) expect(req.permissionMode).toBe('safe')
    expect(scratch.sent[0].options?.codexSkipGitCheck).toBeUndefined()
    expect(scratch.sent[1].provider).toBe('codex')
    expect(scratch.sent[1].options?.codexSandbox).toBe('read-only')
    expect(scratch.sent[1].options?.codexSkipGitCheck).toBe(true)

    const grounded = makeManager(newDir())
    grounded.manager.create(TWO_SEATS, {
      cwd: newDir(),
      branch: 'cockpit/table-x',
      repoRoot: '/repo'
    })
    expect(grounded.sent[1].provider).toBe('codex')
    expect(grounded.sent[1].options?.codexSandbox).toBe('read-only')
    expect(grounded.sent[1].options?.codexSkipGitCheck).toBeUndefined()
  })

  it('twin seats: one provider, two models — separate sessions, separate identities', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(
      {
        topic: 'which model tier fits this repo?',
        seats: [
          { provider: 'claude', options: { model: 'opus' } },
          { provider: 'claude', options: { model: 'haiku' } }
        ]
      },
      null
    )
    // both twins launch in the wave, each with its own model
    expect(h.sent.map((r) => r.options?.model)).toEqual(['opus', 'haiku'])
    replayTurn(h, h.turnIdOf(1), { session: 'c-opus', text: ['depth matters here'] })
    replayTurn(h, h.turnIdOf(2), { session: 'c-haiku', text: ['speed is fine'] })

    // each seat captured its own session id — never its twin's
    const t = h.manager.get(snap.id)
    expect(t.participants[0].nativeSessionId).toBe('c-opus')
    expect(t.participants[1].nativeSessionId).toBe('c-haiku')
    expect(t.entries[1]).toMatchObject({ speaker: 'claude', seat: 0 })
    expect(t.entries[2]).toMatchObject({ speaker: 'claude', seat: 1 })

    // a discussion round relays the twin's words, attributed by model, never its own
    h.manager.continueRound(snap.id)
    const req = h.sent[2]
    expect(req.resumeNativeId).toBe('c-opus')
    expect(req.prompt).toContain('[Claude Code · haiku]: speed is fine')
    expect(req.prompt).not.toContain('depth matters here')
  })

  it('stop cancels every in-flight turn and leaves no ghost entries', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(TWO_SEATS, null)
    h.manager.stop(snap.id)
    expect(h.cancelled.sort()).toEqual([h.turnIdOf(1), h.turnIdOf(2)])

    // the killed CLIs still close out — usually with a non-zero-exit error first
    replayTurn(h, h.turnIdOf(1), { error: 'claude exited with code 143' })
    expect(h.manager.get(snap.id).running).toBe(true) // codex's close hasn't landed yet
    replayTurn(h, h.turnIdOf(2), { error: 'codex exited with code 143' })
    expect(h.manager.get(snap.id).running).toBe(false)
    expect(h.manager.get(snap.id).entries).toHaveLength(1) // just the user topic
    expect(h.sent).toHaveLength(2) // nothing new launched
    // the close says the user stopped it, so nobody is notified about a round they ended
    expect(h.events[h.events.length - 1]).toMatchObject({ type: 'round', running: false, stopped: true })
  })

  it('refuses overlapping rounds and unknown tables', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(TWO_SEATS, null)
    expect(() => h.manager.sendMessage(snap.id, 'wait your turn')).toThrow(/already running/)
    expect(() => h.manager.get('nope')).toThrow(/unknown roundtable/)
    expect(h.manager.handleChatEvent({ turnId: 'foreign', type: 'done' })).toBe(false)
  })

  it('maps a room cwd back to its table, for the seat-session filter', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create(TWO_SEATS, null)
    expect(h.manager.tableIdForCwd(snap.cwd)).toBe(snap.id)
    expect(h.manager.tableIdForCwd('/somewhere/else')).toBeNull()
  })

  // a seat's log records the cwd its CLI resolved for itself — the on-disk spelling —
  // while the table keeps the path it was handed (Electron's userData, a tmpdir link)
  it('claims a seat cwd spelled the way the disk spells it, not the way the table was', () => {
    const h = makeManager(newDir())
    const real = join(realpathSync.native(newDir()), 'worktree')
    mkdirSync(real)
    const link = join(newDir(), 'link')
    symlinkSync(real, link)
    const place = { cwd: link, repoRoot: '/repo', branch: 'cockpit/table-x' }
    const snap = h.manager.create(TWO_SEATS, place)
    expect(h.manager.tableIdForCwd(link)).toBe(snap.id)
    expect(h.manager.tableIdForCwd(real)).toBe(snap.id)
    expect(h.manager.tableIdForCwd(join(real, 'nested'))).toBeNull()
  })

  it('claims a seat cwd that differs from the table\'s only by case, where the volume allows', () => {
    const base = realpathSync.native(newDir())
    const real = join(base, 'cockpit')
    mkdirSync(real)
    const shouted = join(base, 'Cockpit')
    // a case-sensitive volume (Linux CI) has no such second spelling to get wrong
    if (!existsSync(shouted)) return
    const h = makeManager(newDir())
    const place = { cwd: shouted, repoRoot: '/repo', branch: 'cockpit/table-x' }
    const snap = h.manager.create(TWO_SEATS, place)
    expect(h.manager.tableIdForCwd(real)).toBe(snap.id)
  })

  it('consensus: concludes the moment every seat agrees — no extra AI turn runs', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create({ ...TWO_SEATS, mode: 'consensus', maxRounds: 2 }, null)
    replayTurn(h, h.turnIdOf(1), {
      session: 'c-1',
      text: ['Position A.\nCONSENSUS: agree — incremental, behind a flag']
    })
    replayTurn(h, h.turnIdOf(2), {
      session: 'x-1',
      text: ['A works.\nCONSENSUS: agree — with instrumentation first']
    })

    // stances and the seats' own one-liners parsed onto the entries, protocol stripped
    const done = h.manager.get(snap.id)
    expect(done.entries[1]).toMatchObject({
      speaker: 'claude',
      text: 'Position A.',
      stance: 'agree',
      stanceNote: 'incremental, behind a flag'
    })
    expect(done.entries[2]).toMatchObject({ speaker: 'codex', stance: 'agree' })
    // everyone agreed in the wave → concluded outright: the outcome is assembled from
    // these very entries by the renderer, never written by another agent turn
    expect(done.running).toBe(false)
    expect(done.concluded).toBe(true)
    expect(done.entries).toHaveLength(3) // user + two seats; nothing appended after
    expect(h.sent).toHaveLength(2)
    const closes = h.events.filter((e) => e.type === 'round' && !e.running)
    expect(closes).toHaveLength(1)
    expect(closes[0]).toMatchObject({ concluded: true })
    expect(closes[0]).not.toHaveProperty('stopped')
  })

  it('consensus: keeps discussing while seats disagree, concludes honestly at the cap', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create({ ...TWO_SEATS, mode: 'consensus', maxRounds: 2 }, null)
    replayTurn(h, h.turnIdOf(1), { session: 'c-1', text: ['A.\nCONSENSUS: agree'] })
    replayTurn(h, h.turnIdOf(2), { session: 'x-1', text: ['B.\nCONSENSUS: not yet — benchmarks'] })

    // split table, cap not hit → an auto discussion round starts, sequential
    expect(h.sent).toHaveLength(3)
    expect(h.sent[2].provider).toBe('claude')
    expect(h.manager.get(snap.id).running).toBe(true)
    replayTurn(h, h.turnIdOf(3), { text: ['Still A.\nCONSENSUS: agree'] })
    expect(h.sent[3].provider).toBe('codex')
    replayTurn(h, h.turnIdOf(4), { text: ['Unconvinced.\nCONSENSUS: not yet — cache'] })

    // cap reached without agreement → concluded as-is, dissent preserved on the entry
    const t = h.manager.get(snap.id)
    expect(h.sent).toHaveLength(4) // nothing extra ran
    expect(t.running).toBe(false)
    expect(t.concluded).toBe(true)
    expect(t.roundsRun).toBe(2)
    expect(t.entries[t.entries.length - 1]).toMatchObject({
      speaker: 'codex',
      stance: 'continue',
      stanceNote: 'cache'
    })
  })

  it('consensus: a new user message reopens the table with a fresh cycle', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create({ ...TWO_SEATS, mode: 'consensus', maxRounds: 2 }, null)
    replayTurn(h, h.turnIdOf(1), { session: 'c-1', text: ['A.\nCONSENSUS: agree'] })
    replayTurn(h, h.turnIdOf(2), { session: 'x-1', text: ['Fine.\nCONSENSUS: agree'] })
    expect(h.manager.get(snap.id).concluded).toBe(true)

    h.manager.sendMessage(snap.id, 'what about rollback?')
    const t = h.manager.get(snap.id)
    expect(t.concluded).toBe(false)
    expect(t.roundsRun).toBe(0)
    expect(t.running).toBe(true)
    expect(h.sent).toHaveLength(4) // a fresh wave of both seats
    expect(h.sent[2].resumeNativeId).toBe('c-1')
  })

  it('consensus: stop halts the auto-loop mid-cycle', () => {
    const h = makeManager(newDir())
    const snap = h.manager.create({ ...TWO_SEATS, mode: 'consensus', maxRounds: 3 }, null)
    replayTurn(h, h.turnIdOf(1), { session: 'c-1', text: ['A.\nCONSENSUS: not yet — x'] })
    h.manager.stop(snap.id)
    replayTurn(h, h.turnIdOf(2), { error: 'codex exited with code 143' })

    expect(h.manager.get(snap.id).running).toBe(false)
    expect(h.manager.get(snap.id).concluded).toBe(false)
    expect(h.sent).toHaveLength(2) // no auto round, no synthesis
    // a round the user stopped never finished — it must not spend one of the cap
    expect(h.manager.get(snap.id).roundsRun).toBe(0)
  })

  it('maps a room cwd back to its table even as tables are added', () => {
    const h = makeManager(newDir())
    const first = h.manager.create(TWO_SEATS, null)
    // the cwd→table index is cached; a table created after the first lookup must still resolve
    expect(h.manager.tableIdForCwd(first.cwd)).toBe(first.id)
    const second = h.manager.create({ ...TWO_SEATS, topic: 'another' }, null)
    expect(h.manager.tableIdForCwd(second.cwd)).toBe(second.id)
    expect(h.manager.tableIdForCwd(first.cwd)).toBe(first.id)
    expect(h.manager.tableIdForCwd('/somewhere/else')).toBeNull()
  })

  it('skips corrupt files on load instead of failing the scan', () => {
    const dir = newDir()
    const first = makeManager(dir)
    const snap = first.manager.create(TWO_SEATS, null)
    replayTurn(first, first.turnIdOf(1), { session: 'c-1', text: ['ok'] })
    replayTurn(first, first.turnIdOf(2), { session: 'x-1', text: ['ok too'] })
    // a half-written or foreign file next to the real one
    writeFileSync(join(dir, 'not-a-table.json'), '{"id": 12}')

    const second = makeManager(dir)
    const list = second.manager.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(snap.id)
  })
})

describe('RoundtableManager — archiving', () => {
  it('flags archived tables at list time, leaving the table file alone', () => {
    const dir = newDir()
    const h = makeManager(dir)
    const a = h.manager.create(TWO_SEATS, null)
    const b = h.manager.create({ ...TWO_SEATS, topic: 'tabs or spaces?' }, null)

    h.manager.setArchived([a.id])
    const byId = new Map(h.manager.list().map((t) => [t.id, t]))
    expect(byId.get(a.id)?.archived).toBe(true)
    expect(byId.get(b.id)?.archived).toBe(false)
    // archiving is config, not content: the table on disk never learns about it
    expect(JSON.parse(readFileSync(join(dir, `${a.id}.json`), 'utf8')).archived).toBeUndefined()

    // and it comes back
    h.manager.setArchived([])
    expect(h.manager.list().every((t) => !t.archived)).toBe(true)
  })

  it('knows which tables are mid-round, so one cannot be hidden while it runs', () => {
    const h = makeManager(newDir())
    const t = h.manager.create(TWO_SEATS, null)
    expect(h.manager.isRunning(t.id)).toBe(true)

    replayTurn(h, h.turnIdOf(1), { text: ['yes'] })
    replayTurn(h, h.turnIdOf(2), { text: ['no'] })
    expect(h.manager.isRunning(t.id)).toBe(false)
  })
})

describe('RoundtableManager — forgetting a table', () => {
  it('hands cleanup where a table runs, then drops its record for good', () => {
    const dir = newDir()
    const h = makeManager(dir)
    const t = h.manager.create(TWO_SEATS, null)
    replayTurn(h, h.turnIdOf(1), { text: ['yes'] })
    replayTurn(h, h.turnIdOf(2), { text: ['no'] })

    const row = h.manager.forCleanup().find((r) => r.id === t.id)
    expect(row).toMatchObject({ running: false, archived: false, repoRoot: null, repoName: null })
    expect(row?.cwd).toBe(join(dir, t.id, 'room'))
    expect(row?.entryCount).toBeGreaterThan(0)

    h.manager.forget(t.id)
    expect(existsSync(join(dir, `${t.id}.json`))).toBe(false)
    expect(h.manager.list()).toEqual([])
    // and the room is no longer claimed, so nothing else thinks a table owns it
    expect(h.manager.tableIdForCwd(join(dir, t.id, 'room'))).toBeNull()
  })

  it('refuses to forget a table mid-round', () => {
    const h = makeManager(newDir())
    const t = h.manager.create(TWO_SEATS, null)
    expect(() => h.manager.forget(t.id)).toThrow(/mid-round/)
    expect(h.manager.list()).toHaveLength(1)
  })
})
