import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ChatEvent,
  ChatRequest,
  Mutable,
  PermissionMode,
  Provider,
  Roundtable,
  RoundtableEntry,
  RoundtableEvent,
  RoundtableMeta,
  RoundtableMode,
  RoundtableParticipant,
  RoundtableSnapshot
} from '../shared/types'
import {
  buildTurnPrompt,
  clampRounds,
  deriveTitle,
  parseStance,
  sanitizeRoundtable
} from './roundtable-core'
import { entrySeatIndex } from '../shared/roundtable'

/** In-memory working copy — the round loop mutates it, persisting after every entry. */
type Table = Omit<Mutable<Roundtable>, 'participants' | 'entries'> & {
  participants: Array<Mutable<RoundtableParticipant>>
  entries: RoundtableEntry[] // append-only
}

/** Seat identity fields fixed at creation (session id / seenUpTo start empty). */
export type SeatInit = Pick<
  RoundtableParticipant,
  'provider' | 'configDir' | 'copilotUser' | 'accountLabel' | 'options'
>

export type NewTable = {
  readonly topic: string
  readonly seats: SeatInit[]
  /** 'consensus' = auto-rounds until every seat agrees, then a joint synthesis */
  readonly mode?: RoundtableMode
  readonly maxRounds?: number
}

/** Where the table runs: a main-derived worktree, or null for a scratch room. */
export type TablePlace = {
  readonly cwd: string
  readonly branch: string | null
  readonly repoRoot: string | null
}

/** The chat plumbing this manager drives — index.ts wires it to the one ChatManager. */
type Hooks = {
  readonly sendTurn: (req: ChatRequest) => string
  readonly cancelTurn: (turnId: string) => void
  readonly emit: (ev: RoundtableEvent) => void
}

/** One in-flight seat turn — mutable stream bookkeeping on purpose. */
type TurnState = {
  /** Participant index — the seat's identity (providers may repeat) */
  readonly seatIndex: number
  readonly speaker: Provider
  buf: string
  error: string | null
  /** Transcript length when this turn's prompt was built — the seat's next delta
   *  starts here, so wave replies that landed meanwhile are never skipped */
  readonly promptedUpTo: number
}

/** Live state of a round in flight — mutable turn bookkeeping on purpose. */
type Round = {
  /** Seat indexes not yet launched: a wave drains this at once, a relay one at a time */
  queue: number[]
  /** ChatManager turn id → live turn (several at once during a wave) */
  turns: Map<string, TurnState>
  cancelled: boolean
  /** Transcript length when the round started — this round's entries begin here */
  entriesAtStart: number
}

/** A runaway agent reply must not grow memory unbounded mid-stream. */
const STREAM_CAP = 512_000
/** Persisted entries stay bounded — the transcript file crosses the IPC bridge whole. */
const ENTRY_SAVE_CAP = 64_000

/**
 * Orchestrates multi-agent roundtables: one shared transcript per table, agents speak
 * in seat order through the app's ChatManager, and every finalized entry is persisted
 * to `<userData>/roundtables/<id>.json` (write-then-rename, like config.ts). Rounds
 * are in-memory only — a restart mid-round simply leaves the table idle.
 */
export class RoundtableManager {
  private readonly dir: string
  private readonly hooks: Hooks
  private readonly tables = new Map<string, Table>()
  private readonly rounds = new Map<string, Round>()
  /** ChatManager turn id → roundtable id, for routing stream events */
  private readonly byTurn = new Map<string, string>()
  private loaded = false

  constructor(dir: string, hooks: Hooks) {
    this.dir = dir
    this.hooks = hooks
  }

  /** Lazy one-shot scan; a corrupt file is skipped, never fatal (parser house rule). */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'))
    } catch {
      return // no dir yet — first run
    }
    for (const f of files) {
      try {
        const rt = sanitizeRoundtable(JSON.parse(readFileSync(join(this.dir, f), 'utf8')))
        if (rt) this.tables.set(rt.id, structuredClone(rt) as Table)
      } catch {
        /* skip unreadable file */
      }
    }
  }

  private save(t: Table): void {
    mkdirSync(this.dir, { recursive: true })
    // write-then-rename: a crash mid-write must never leave a truncated table
    const tmp = join(this.dir, `${t.id}.json.tmp`)
    writeFileSync(tmp, JSON.stringify(t, null, 2))
    renameSync(tmp, join(this.dir, `${t.id}.json`))
  }

  private mustGet(id: string): Table {
    this.ensureLoaded()
    const t = this.tables.get(id)
    if (!t) throw new Error(`unknown roundtable: ${id}`)
    return t
  }

  list(): RoundtableMeta[] {
    this.ensureLoaded()
    return [...this.tables.values()]
      .map((t) => ({
        id: t.id,
        title: t.title,
        updatedAt: t.updatedAt,
        providers: t.participants.map((p) => p.provider),
        entryCount: t.entries.length,
        running: this.rounds.has(t.id),
        branch: t.branch,
        repoRoot: t.repoRoot
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): RoundtableSnapshot {
    return this.snapshot(this.mustGet(id))
  }

  private snapshot(t: Table): RoundtableSnapshot {
    const round = this.rounds.get(t.id)
    const speaking = new Set([...(round?.turns.values() ?? [])].map((turn) => turn.seatIndex))
    return {
      ...(structuredClone(t) as Roundtable),
      running: round !== undefined,
      // seat order, not launch order — the view lays live blocks out by seat
      speaking: t.participants.map((_, i) => i).filter((i) => speaking.has(i))
    }
  }

  /** The table whose room/worktree this cwd is, if any — the indexer's seat-session filter. */
  tableIdForCwd(cwd: string): string | null {
    this.ensureLoaded()
    const target = resolve(cwd)
    for (const t of this.tables.values()) if (resolve(t.cwd) === target) return t.id
    return null
  }

  /** Create the table and run the opening round on the topic. */
  create(input: NewTable, place: TablePlace | null): RoundtableSnapshot {
    this.ensureLoaded()
    const id = randomUUID()
    let cwd: string
    if (place) {
      cwd = place.cwd
    } else {
      // repo-less table: a scratch room of its own, derived by main — never renderer input
      cwd = join(this.dir, id, 'room')
      mkdirSync(cwd, { recursive: true })
    }
    const now = Date.now()
    const t: Table = {
      id,
      title: deriveTitle(input.topic),
      topic: input.topic,
      createdAt: now,
      updatedAt: now,
      cwd,
      repoRoot: place?.repoRoot ?? null,
      branch: place?.branch ?? null,
      // discussions read, never write — the one permission a table ever gets
      permissionMode: 'safe',
      mode: input.mode ?? 'open',
      maxRounds: clampRounds(input.maxRounds),
      roundsRun: 0,
      concluded: false,
      participants: input.seats.map((s) => ({ ...s, nativeSessionId: null, seenUpTo: 0 })),
      entries: []
    }
    this.tables.set(id, t)
    this.appendEntry(t, { speaker: 'user', text: input.topic, at: now })
    this.save(t)
    this.startRound(t, true)
    return this.snapshot(t)
  }

  /** Append a user message and run one wave of replies — every seat at once. */
  sendMessage(id: string, text: string): void {
    const t = this.mustGet(id)
    if (this.rounds.has(id)) throw new Error('A round is already running — stop it first.')
    const msg = text.trim()
    if (!msg) throw new Error('Empty message.')
    // each user message opens a fresh consensus cycle — the cap counts from here
    t.roundsRun = 0
    t.concluded = false
    this.appendEntry(t, { speaker: 'user', text: msg, at: Date.now() })
    this.save(t)
    this.startRound(t, true)
  }

  /**
   * One discussion round with no new user message. Sequential on purpose — each seat
   * sees what the earlier seats said this round, so they answer each other instead of
   * re-answering the user in parallel.
   */
  continueRound(id: string): void {
    const t = this.mustGet(id)
    if (this.rounds.has(id)) throw new Error('A round is already running — stop it first.')
    if (t.entries.length === 0) throw new Error('Nothing to continue yet.')
    // a manual round after a conclusion reopens the cycle for a fresh evaluation
    t.concluded = false
    this.startRound(t, false)
  }

  stop(id: string): void {
    const round = this.rounds.get(id)
    if (!round) return
    round.cancelled = true
    round.queue = []
    if (round.turns.size === 0) {
      this.endRound(id)
      return
    }
    for (const turnId of round.turns.keys()) this.hooks.cancelTurn(turnId)
  }

  /** True when any table still has a turn in flight (quit-time cleanup asks). */
  anyRunning(): boolean {
    return this.rounds.size > 0
  }

  private appendEntry(t: Table, entry: RoundtableEntry): void {
    const capped =
      entry.text.length > ENTRY_SAVE_CAP
        ? { ...entry, text: entry.text.slice(0, ENTRY_SAVE_CAP) + ' …[truncated]' }
        : entry
    t.entries.push(capped)
    t.updatedAt = Date.now()
    this.hooks.emit({ id: t.id, type: 'entry', index: t.entries.length - 1, entry: capped })
  }

  private startRound(t: Table, parallel: boolean): void {
    const round: Round = {
      queue: t.participants.map((_, i) => i),
      turns: new Map(),
      cancelled: false,
      entriesAtStart: t.entries.length
    }
    this.rounds.set(t.id, round)
    this.hooks.emit({ id: t.id, type: 'round', running: true, roundsRun: t.roundsRun })
    if (parallel) {
      // the wave: every seat gets the same prompt state and streams simultaneously
      const seats = round.queue.splice(0)
      for (const seatIndex of seats) this.launchTurn(t, round, seatIndex)
      if (round.turns.size === 0) this.endRound(t.id)
    } else {
      this.launchNext(t, round)
    }
  }

  /**
   * A round's last turn closed. Open tables go idle; a consensus cycle keeps itself
   * moving — another discussion round while seats disagree and the cap allows. The
   * conclusion is deliberately AI-free: no extra summarizing turn runs — the outcome
   * panel is assembled by the renderer from the seats' own stance lines.
   */
  private roundComplete(t: Table, round: Round): void {
    t.roundsRun++
    if (round.cancelled || t.mode !== 'consensus') {
      this.save(t)
      this.endRound(t.id)
      return
    }
    // everyone must have been heard this round (errors are not agreement) and agree
    const stances = new Map<number, RoundtableEntry['stance']>()
    for (const e of t.entries.slice(round.entriesAtStart)) {
      if (e.speaker !== 'user' && !e.error) stances.set(entrySeatIndex(t.participants, e), e.stance)
    }
    const allAgree = t.participants.every((_, i) => stances.get(i) === 'agree')
    if (allAgree || t.roundsRun >= t.maxRounds) {
      t.concluded = true
      this.save(t)
      this.endRound(t.id)
    } else {
      this.save(t)
      this.startRound(t, false)
    }
  }

  private endRound(id: string): void {
    if (!this.rounds.delete(id)) return
    const t = this.tables.get(id)
    this.hooks.emit({
      id,
      type: 'round',
      running: false,
      ...(t ? { roundsRun: t.roundsRun, concluded: t.concluded } : {})
    })
  }

  /** Sequential relay: pop the next seat; the round completes when the queue runs dry. */
  private launchNext(t: Table, round: Round): void {
    const seatIndex = round.queue.shift()
    if (seatIndex === undefined || round.cancelled) {
      if (round.turns.size === 0) {
        // nothing launched at all → plain idle (an empty round must not advance a cycle)
        if (t.entries.length === round.entriesAtStart) this.endRound(t.id)
        else this.roundComplete(t, round)
      }
      return
    }
    if (!this.launchTurn(t, round, seatIndex)) this.launchNext(t, round)
  }

  /** Spawn one seat's turn. False when the seat no longer exists on the table. */
  private launchTurn(t: Table, round: Round, seatIndex: number): boolean {
    const seat = t.participants[seatIndex]
    if (!seat) return false
    const speaker = seat.provider
    this.hooks.emit({ id: t.id, type: 'turn', speaker, seat: seatIndex })
    // discussion-only: codex runs read-only sandboxed, and repo-less scratch rooms
    // wave off its git-repo trust check (repo-grounded tables sit in a real worktree)
    const options =
      speaker === 'codex'
        ? {
            ...seat.options,
            codexSandbox: 'read-only' as const,
            ...(t.repoRoot === null ? { codexSkipGitCheck: true } : {})
          }
        : seat.options
    const req: ChatRequest = {
      provider: speaker,
      cwd: t.cwd,
      prompt: buildTurnPrompt(t, seatIndex),
      resumeNativeId: seat.nativeSessionId ?? undefined,
      permissionMode: t.permissionMode,
      options,
      configDir: seat.configDir,
      copilotUser: seat.copilotUser
    }
    // send() returns synchronously; even its fast-fail events arrive via microtask,
    // so the routing entry below is always in place before the first event fires
    const turnId = this.hooks.sendTurn(req)
    round.turns.set(turnId, {
      seatIndex,
      speaker,
      buf: '',
      error: null,
      promptedUpTo: t.entries.length
    })
    this.byTurn.set(turnId, t.id)
    return true
  }

  /**
   * Route one ChatManager stream event. Returns true when the event belonged to a
   * roundtable turn (the caller must then keep it away from the plain-chat channel).
   */
  handleChatEvent(ev: ChatEvent): boolean {
    const id = this.byTurn.get(ev.turnId)
    if (id === undefined) return false
    const t = this.tables.get(id)
    const round = this.rounds.get(id)
    const turn = round?.turns.get(ev.turnId)
    if (!t || !round || !turn) {
      // stale turn (table gone or round torn down) — swallow, and drop the route on done
      if (ev.type === 'done') this.byTurn.delete(ev.turnId)
      return true
    }
    const speaker = turn.speaker
    const seatIndex = turn.seatIndex
    switch (ev.type) {
      case 'session': {
        const seat = t.participants[seatIndex]
        if (seat) seat.nativeSessionId = ev.nativeSessionId
        break
      }
      case 'text':
        if (turn.buf.length < STREAM_CAP) turn.buf += ev.text
        this.hooks.emit({ id, type: 'delta', speaker, seat: seatIndex, text: ev.text })
        break
      case 'tool':
        this.hooks.emit({
          id,
          type: 'tool',
          speaker,
          seat: seatIndex,
          toolName: ev.toolName,
          detail: ev.detail,
          ...(ev.preview ? { preview: ev.preview } : {})
        })
        break
      case 'error':
        turn.error = turn.error ? `${turn.error}\n${ev.message}` : ev.message
        break
      case 'done': {
        this.byTurn.delete(ev.turnId)
        round.turns.delete(ev.turnId)
        const text = turn.buf.trim()
        // A turn that errored and produced only a scrap of text almost certainly
        // streamed its own failure banner (claude prints auth errors as plain
        // text) — record that as a failure annotation, never as a contribution
        // the other seats would then "answer". Substantial text before a crash is
        // still content; a user-stopped turn with nothing to keep leaves no trace.
        const salvage = text.length >= 200 || (text.length > 0 && turn.error === null)
        if (salvage) {
          if (t.mode === 'consensus') {
            // the trailing CONSENSUS line is protocol, not prose — parse it off; the
            // note (the seat's own one-liner) is what the outcome panel shows
            const parsed = parseStance(text)
            this.appendEntry(t, {
              speaker,
              seat: seatIndex,
              text: parsed.text || text,
              at: Date.now(),
              ...(parsed.stance ? { stance: parsed.stance } : {}),
              ...(parsed.note ? { stanceNote: parsed.note } : {})
            })
          } else {
            this.appendEntry(t, { speaker, seat: seatIndex, text, at: Date.now() })
          }
        } else if (!round.cancelled) {
          this.appendEntry(t, {
            speaker,
            seat: seatIndex,
            text: text || turn.error || '(no reply)',
            at: Date.now(),
            error: true
          })
        }
        if (salvage || !round.cancelled) {
          const seat = t.participants[seatIndex]
          // deltas restart at what this turn was PROMPTED with, not at the current
          // transcript end: wave replies that landed meanwhile must not be skipped
          // (the seat's own entry inside that span is filtered out at prompt build)
          if (seat) seat.seenUpTo = turn.promptedUpTo
          this.save(t)
        }
        this.hooks.emit({ id, type: 'turn-end', speaker, seat: seatIndex })
        if (!round.cancelled && round.queue.length > 0) {
          this.launchNext(t, round)
        } else if (round.turns.size === 0) {
          this.roundComplete(t, round)
        }
        break
      }
    }
    return true
  }
}
