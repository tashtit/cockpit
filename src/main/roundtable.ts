import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
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
  RoundtableLimits,
  RoundtableQueued,
  RoundtableSendOptions,
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
import {
  DEFAULT_ROUNDTABLE_LIMITS,
  entrySeatIndex,
  roundRefusal,
  roundsAllowed
} from '../shared/roundtable'
import type { CleanupTable } from './cleanup'

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
  /** Already sanitized by the caller; absent = the defaults */
  readonly limits?: RoundtableLimits
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
  /** Epoch ms it started — the view shows how long a seat has been at it */
  readonly startedAt: number
  /** Why the round is going on without it, once it was cut short (skip, time limit) */
  skipped: string | null
  /** The time-limit timer, cleared when the turn ends */
  timer: ReturnType<typeof setTimeout> | null
}

/** Live state of a round in flight — mutable turn bookkeeping on purpose. */
type Round = {
  /** The seats this round addresses — the whole table, or the ones a message named;
   *  a consensus cycle keeps running with the same set. A seat skipped mid-round
   *  leaves it, so the cycle carries on — and agrees — without it. */
  seats: number[]
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
 * The path as the filesystem spells it — symlinks followed and, on a case-insensitive
 * volume, the stored case. `realpathSync.native` is the one that corrects case; the
 * JS implementation echoes whatever spelling it was handed.
 */
function onDisk(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

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
  /** A message sent while a round ran, per table — sent the moment the round ends.
   *  In memory, like rounds: a restart mid-round leaves the table idle anyway. */
  private readonly queued = new Map<string, RoundtableQueued>()
  /** ChatManager turn id → roundtable id, for routing stream events */
  private readonly byTurn = new Map<string, string>()
  private loaded = false
  /** Archived table ids — kept here, applied at list() time like the indexer's set */
  private archived = new Set<string>()

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
        if (rt) {
          this.tables.set(rt.id, structuredClone(rt) as Table)
          this.cwdIndex = null
        }
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

  /** A round the table cannot afford never starts — the user hears why, up front. */
  private assertAffordable(t: Table, seats: readonly number[]): void {
    const refusal = roundRefusal(t.limits, { participants: seats, entries: t.entries })
    if (refusal) throw new Error(refusal)
  }

  /**
   * The seats a message or round addresses. Renderer input: absent is the whole table;
   * otherwise real seat indexes only, each once, in seat order — and at least one.
   */
  private pickSeats(t: Table, seats?: readonly number[]): number[] {
    const all = t.participants.map((_, i) => i)
    if (seats === undefined) return all
    const wanted = new Set(
      (Array.isArray(seats) ? seats : []).filter((i) => Number.isInteger(i) && i >= 0 && i < all.length)
    )
    const picked = all.filter((i) => wanted.has(i))
    if (picked.length === 0) throw new Error('Pick at least one seat to answer.')
    return picked
  }

  private mustGet(id: string): Table {
    this.ensureLoaded()
    const t = this.tables.get(id)
    if (!t) throw new Error(`unknown roundtable: ${id}`)
    return t
  }

  /** Every table as cleanup reads it — where it runs, and whether a round is live. */
  forCleanup(): CleanupTable[] {
    this.ensureLoaded()
    return [...this.tables.values()].map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      providers: t.participants.map((p) => p.provider),
      entryCount: t.entries.length,
      archived: this.archived.has(t.id),
      running: this.rounds.has(t.id),
      cwd: t.cwd,
      repoRoot: t.repoRoot,
      repoName: t.repoRoot === null ? null : basename(t.repoRoot),
      branch: t.branch
    }))
  }

  /**
   * Drop a table Cockpit no longer keeps: its record file goes, and so does the
   * in-memory copy. Cleanup calls this once the room and the seat logs are gone.
   */
  forget(id: string): void {
    this.ensureLoaded()
    if (this.rounds.has(id)) throw new Error('That roundtable is mid-round.')
    try {
      rmSync(join(this.dir, `${id}.json`), { force: true })
    } catch {
      /* already gone — the record is what matters, and it is about to be */
    }
    this.tables.delete(id)
    this.cwdIndex = null
  }

  /** A round of this table is in flight right now. */
  isRunning(id: string): boolean {
    return this.rounds.has(id)
  }

  /** Applied at query time, so archiving never rewrites a table file. */
  setArchived(ids: readonly string[]): void {
    this.archived = new Set(ids)
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
        repoRoot: t.repoRoot,
        archived: this.archived.has(t.id)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): RoundtableSnapshot {
    return this.snapshot(this.mustGet(id))
  }

  private snapshot(t: Table): RoundtableSnapshot {
    const round = this.rounds.get(t.id)
    const live = [...(round?.turns.values() ?? [])]
    const speaking = new Set(live.map((turn) => turn.seatIndex))
    return {
      ...(structuredClone(t) as Roundtable),
      running: round !== undefined,
      // seat order, not launch order — the view lays live blocks out by seat
      speaking: t.participants.map((_, i) => i).filter((i) => speaking.has(i)),
      speakingSince: Object.fromEntries(live.map((turn) => [turn.seatIndex, turn.startedAt])),
      queued: this.queued.get(t.id) ?? null
    }
  }

  /**
   * Resolved cwd → table id. The indexer asks this for every session in every page()
   * and listRepos() call, so the table side is resolved once and cached; tables change
   * only on create/load, which clear it.
   *
   * Each table is filed under the path it was given *and* the path the disk answers to.
   * A seat's log records the cwd its CLI resolved for itself, which on macOS is the
   * on-disk spelling: Electron hands out `Application Support/Cockpit` for a directory
   * that is really `cockpit`, and `/var` is really `/private/var`. Compared as given,
   * a repo table's seats never matched and surfaced as ordinary sessions.
   */
  private cwdIndex: Map<string, string> | null = null

  /** Queried cwd → its on-disk spelling. Paths only, so table changes never stale it. */
  private readonly realCwds = new Map<string, string>()

  private roomIndex(): Map<string, string> {
    this.ensureLoaded()
    if (!this.cwdIndex) {
      this.cwdIndex = new Map()
      for (const t of this.tables.values()) {
        this.cwdIndex.set(resolve(t.cwd), t.id)
        this.cwdIndex.set(onDisk(t.cwd) ?? resolve(t.cwd), t.id)
      }
    }
    return this.cwdIndex
  }

  /** The table whose room/worktree this cwd is, if any — the indexer's seat-session filter. */
  tableIdForCwd(cwd: string): string | null {
    const rooms = this.roomIndex()
    const given = resolve(cwd)
    const exact = rooms.get(given)
    if (exact !== undefined || rooms.size === 0) return exact ?? null
    let real = this.realCwds.get(given)
    if (real === undefined) {
      // a miss is not remembered: a room that does not exist yet will
      real = onDisk(given) ?? undefined
      if (real === undefined) return null
      this.realCwds.set(given, real)
    }
    return rooms.get(real) ?? null
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
      limits: input.limits ?? DEFAULT_ROUNDTABLE_LIMITS,
      roundsRun: 0,
      concluded: false,
      participants: input.seats.map((s) => ({ ...s, nativeSessionId: null, seenUpTo: 0 })),
      entries: []
    }
    this.tables.set(id, t)
    this.cwdIndex = null
    this.appendEntry(t, { speaker: 'user', text: input.topic, at: now })
    this.save(t)
    this.startRound(t, true)
    return this.snapshot(t)
  }

  /**
   * Append a user message and run one wave of replies — every seat at once, or the
   * seats it names. While a round runs the message waits instead (`whenBusy: 'queue'`,
   * the default) and goes out the moment the round ends — a consensus cycle ends early
   * for it — or stops the round and goes now (`'interrupt'`). A second message sent
   * while one waits joins it, so nothing typed is lost.
   */
  sendMessage(id: string, text: string, opts: RoundtableSendOptions = {}): void {
    const t = this.mustGet(id)
    const msg = text.trim()
    if (!msg) throw new Error('Empty message.')
    const to = this.pickSeats(t, opts.seats)
    if (this.rounds.has(id)) {
      const partial = to.length < t.participants.length
      const waiting = this.queued.get(id)
      const next: RoundtableQueued = {
        text: waiting ? `${waiting.text}\n\n${msg}` : msg,
        ...(partial ? { to } : {})
      }
      this.queued.set(id, next)
      this.hooks.emit({ id, type: 'queued', queued: next })
      if (opts.whenBusy === 'interrupt') this.stop(id)
      return
    }
    this.assertAffordable(t, to)
    // each user message opens a fresh consensus cycle — the cap counts from here
    t.roundsRun = 0
    t.concluded = false
    const partial = to.length < t.participants.length
    this.appendEntry(t, { speaker: 'user', text: msg, at: Date.now(), ...(partial ? { to } : {}) })
    this.save(t)
    this.startRound(t, true, to)
  }

  /**
   * One discussion round with no new user message. Sequential on purpose — each seat
   * sees what the earlier seats said this round, so they answer each other instead of
   * re-answering the user in parallel.
   */
  continueRound(id: string, seats?: readonly number[]): void {
    const t = this.mustGet(id)
    if (this.rounds.has(id)) throw new Error('A round is already running — stop it first.')
    if (t.entries.length === 0) throw new Error('Nothing to continue yet.')
    const to = this.pickSeats(t, seats)
    this.assertAffordable(t, to)
    // a manual round after a conclusion reopens the cycle for a fresh evaluation
    t.concluded = false
    this.startRound(t, false, to)
  }

  /**
   * Change what a table may spend — how a table that hit its ceiling goes on. Takes
   * effect at the next round; a round in flight keeps the ceilings it started under
   * only in the sense that a consensus cycle re-reads them between rounds.
   */
  setLimits(id: string, limits: RoundtableLimits, maxRounds?: number): RoundtableSnapshot {
    const t = this.mustGet(id)
    t.limits = limits
    // the round cap too: a running consensus cycle reads it again before every round,
    // so lowering it ends a cycle the person regrets starting, raising it extends one
    if (maxRounds !== undefined) t.maxRounds = clampRounds(maxRounds)
    this.save(t)
    return this.snapshot(t)
  }

  /** Drop the waiting message — what the person sees go when they cancel it. */
  unqueue(id: string): void {
    if (this.queued.delete(id)) this.hooks.emit({ id, type: 'queued', queued: null })
  }

  /**
   * Stop waiting for one seat: its turn is cancelled and the round goes on without it —
   * a stuck CLI, or one the person has heard enough from. A seat still queued in a
   * relay just leaves the queue. Either way it sits out the rest of this cycle.
   */
  skipSeat(id: string, seatIndex: number): void {
    const round = this.rounds.get(id)
    if (!round) return
    round.seats = round.seats.filter((i) => i !== seatIndex)
    round.queue = round.queue.filter((i) => i !== seatIndex)
    for (const [turnId, turn] of round.turns) {
      if (turn.seatIndex === seatIndex) this.cutShort(turnId, turn, 'Skipped — the table went on without it.')
    }
  }

  /** End one turn early; the done handler records why and moves the round along. */
  private cutShort(turnId: string, turn: TurnState, why: string): void {
    if (turn.skipped !== null) return
    turn.skipped = why
    if (turn.timer) clearTimeout(turn.timer)
    this.hooks.cancelTurn(turnId)
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

  private startRound(t: Table, parallel: boolean, seats?: readonly number[]): void {
    const addressed = seats ?? t.participants.map((_, i) => i)
    const round: Round = {
      seats: [...addressed],
      queue: [...addressed],
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
    // a round the user stopped never finished — it must not spend one of the cap
    if (round.cancelled || t.mode !== 'consensus' || this.queued.has(t.id)) {
      if (!round.cancelled) t.roundsRun++
      this.save(t)
      this.endRound(t.id)
      return
    }
    t.roundsRun++
    // a seat whose turn failed cannot agree, and retrying it by itself fixes nothing (a
    // lapsed sign-in, a gone model): another auto-round would only bill the others for
    // answering an empty chair. Stop — not concluded, so no outcome claims a result —
    // and let the person fix it and carry on.
    const roundEntries = t.entries.slice(round.entriesAtStart)
    if (roundEntries.some((e) => e.speaker !== 'user' && e.error)) {
      this.save(t)
      this.endRound(t.id)
      return
    }
    // everyone still at the table must have been heard this round and agree; with every
    // seat skipped there is nobody left to agree, and the cycle simply stops
    if (round.seats.length === 0) {
      this.save(t)
      this.endRound(t.id)
      return
    }
    const stances = new Map<number, RoundtableEntry['stance']>()
    for (const e of roundEntries) {
      if (e.speaker !== 'user') stances.set(entrySeatIndex(t.participants, e), e.stance)
    }
    // agreement among the seats this cycle addresses: a table carrying on without a seat
    // can still reach an understanding among the rest
    const allAgree = round.seats.every((i) => stances.get(i) === 'agree')
    // the table's own cap, then the user's ceilings: a round it cannot afford closes
    // the cycle exactly as the cap does — a split table is shown as split
    const limits = t.limits
    const rounds = Math.min(t.maxRounds, roundsAllowed(limits, round.seats.length))
    const next = { participants: round.seats, entries: t.entries }
    if (allAgree || t.roundsRun >= rounds || roundRefusal(limits, next) !== null) {
      t.concluded = true
      this.save(t)
      this.endRound(t.id)
    } else {
      this.save(t)
      this.startRound(t, false, round.seats)
    }
  }

  private endRound(id: string): void {
    const stopped = this.rounds.get(id)?.cancelled === true
    if (!this.rounds.delete(id)) return
    const t = this.tables.get(id)
    this.hooks.emit({
      id,
      type: 'round',
      running: false,
      ...(t ? { roundsRun: t.roundsRun, concluded: t.concluded } : {}),
      ...(stopped ? { stopped: true } : {})
    })
    // the message that waited for this round goes out now — after the round-end event,
    // so the view sees the old round close before the new one opens
    const waiting = this.queued.get(id)
    if (waiting) {
      this.queued.delete(id)
      try {
        this.sendMessage(id, waiting.text, { seats: waiting.to })
        this.hooks.emit({ id, type: 'queued', queued: null })
      } catch (err) {
        // refused (a spent ceiling): keep it waiting, and say why, rather than lose it
        this.queued.set(id, waiting)
        this.hooks.emit({
          id,
          type: 'queued',
          queued: waiting,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
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

  /** Spawn one seat's turn. False when nothing is in flight for it: the seat no longer
   *  exists on the table, or its turn could not be started (recorded as its failure). */
  private launchTurn(t: Table, round: Round, seatIndex: number): boolean {
    const seat = t.participants[seatIndex]
    if (!seat) return false
    const speaker = seat.provider
    const startedAt = Date.now()
    this.hooks.emit({ id: t.id, type: 'turn', speaker, seat: seatIndex, at: startedAt })
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
    let turnId: string
    try {
      turnId = this.hooks.sendTurn(req)
    } catch (err) {
      this.appendEntry(t, {
        speaker,
        seat: seatIndex,
        text: err instanceof Error ? err.message : String(err),
        at: Date.now(),
        error: true
      })
      this.save(t)
      this.hooks.emit({ id: t.id, type: 'turn-end', speaker, seat: seatIndex })
      return false
    }
    const turn: TurnState = {
      seatIndex,
      speaker,
      buf: '',
      error: null,
      promptedUpTo: t.entries.length,
      startedAt,
      skipped: null,
      timer: null
    }
    // the table's time limit: past it, the round goes on without this seat. Read now,
    // so a limit changed mid-round applies from the next turn
    const minutes = t.limits.maxTurnMinutes
    if (minutes > 0) {
      turn.timer = setTimeout(
        () => this.cutShort(turnId, turn, `Took longer than ${minutes} min — the table went on without it.`),
        minutes * 60_000
      )
      turn.timer.unref?.()
    }
    round.turns.set(turnId, turn)
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
        if (turn.timer) clearTimeout(turn.timer)
        if (turn.skipped !== null) {
          // cut short: whatever it had streamed is half an answer, so it is not kept;
          // the note says the table went on without it. Its seenUpTo stays, so its next
          // prompt carries everything it missed.
          this.appendEntry(t, { speaker, seat: seatIndex, text: turn.skipped, at: Date.now(), skipped: true })
          this.save(t)
          this.hooks.emit({ id, type: 'turn-end', speaker, seat: seatIndex })
          if (!round.cancelled && round.queue.length > 0) this.launchNext(t, round)
          else if (round.turns.size === 0) this.roundComplete(t, round)
          break
        }
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
