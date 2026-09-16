import { normalize } from 'node:path'
import type {
  AttentionFocus,
  AttentionPrefs,
  AttentionTarget,
  ChatEvent,
  Landing,
  Provider,
  Roundtable,
  RoundtableEntry
} from '../shared/types'

/**
 * Attention, the IO-free half: which ended turns are news, what the Dock badge
 * counts, and how a burst of endings becomes one notification. `attention.ts`
 * feeds it events and carries out what it decides; nothing here touches Electron,
 * the file system or a clock it wasn't handed.
 *
 * The vocabulary is the board's. A turn *lands* when its process ends; it stays
 * *unseen* until the user opens it. Main owns that state because only main sees
 * every turn end — including the ones for sessions no view has open — and the
 * renderer tells it what is on screen.
 */

/** Endings this close together share one notification. */
export const BURST_MS = 1500
/** Landings older than this are noise, not news. */
export const LANDING_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Bound the set: a long day of many sessions must not grow the file or the badge forever. */
export const LANDING_MAX = 60
/** Delivered banners remembered for withdrawal once their sessions are opened. */
const DELIVERED_MAX = 30
/** Renamed keys remembered, so a banner posted under the old one still opens the right thing. */
const ALIAS_MAX = 100
/** How much of a turn's closing text is kept to quote from. */
const TEXT_KEEP = 600
const SNIPPET_MAX = 110
const TITLE_MAX = 60
const SUMMARY_LINES = 3
/** Faster than this, a duration says nothing ("failed after 0s"). */
const DURATION_FLOOR_MS = 5_000

const AGENT: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }

/** Something that ended while nobody was looking — one per session or table. Persisted. */
export type Unseen = {
  /** The session id, `table:<id>`, or `turn:<turnId>` until the agent names its session */
  readonly key: string
  readonly kind: 'session' | 'roundtable'
  /** Session id (null until known — copilot never announces one) or table id */
  readonly id: string | null
  readonly provider?: Provider
  readonly cwd?: string
  /** When the turn started: how an id-less landing finds the session it became */
  readonly startedAt: number
  /** When it ended */
  readonly at: number
}

export type TurnStart = {
  readonly turnId: string
  readonly provider: Provider
  readonly cwd: string
  readonly prompt: string
  readonly resumeNativeId?: string
}

/** How a roundtable's run ended, in words a notification can carry. */
export type TableOutcome = {
  readonly kind: 'consensus' | 'no-consensus' | 'replied' | 'failed'
  readonly detail: string
}

export type TableEnd = {
  readonly id: string
  readonly title: string
  readonly outcome: TableOutcome
}

/** One banner to post. */
export type Notice = {
  /** Stable per session, so a second landing replaces its first banner instead of stacking */
  readonly id: string
  readonly title: string
  readonly subtitle: string
  readonly body: string
  readonly failed: boolean
  readonly target: AttentionTarget
  /** The unseen keys this banner speaks for — it is withdrawn once all of them are opened */
  readonly keys: readonly string[]
}

/** What a flush asks the IO layer to do. */
export type Flush = {
  /** null when notifications are off, or nothing is news any more */
  readonly notice: Notice | null
  readonly sound: 'finish' | 'fail' | null
}

/** A turn followed from spawn to exit — mutable accumulator on purpose. */
type Flight = {
  readonly turnId: string
  readonly provider: Provider
  readonly cwd: string
  readonly prompt: string
  readonly startedAt: number
  /** Resumed an existing conversation (so it is never "the new chat on screen") */
  readonly resumed: boolean
  /** Every session id the turn is known under — claude forks one per resumed turn */
  readonly ids: Set<string>
  latest: string | null
  /** Text since the last tool call: the agent's closing words */
  text: string
  error: string | null
  cancelled: boolean
}

/** A notification waiting out the burst window. */
type Pending = {
  readonly key: string
  /** "Claude", "Roundtable" */
  readonly who: string
  /** "finished", "failed", "reached consensus" */
  readonly verb: string
  /** "4m", or null when too quick to be worth saying */
  readonly after: string | null
  readonly detail: string
  /** Tables know their title; sessions resolve theirs at flush (the index catches up) */
  readonly title: string | null
  /** The prompt, for a brand-new session the index hasn't seen yet */
  readonly fallbackTitle: string
  readonly failed: boolean
}

const samePath = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && trimSep(normalize(a)) === trimSep(normalize(b))

const trimSep = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s

/** The first readable line of an agent's closing text, markdown stripped. */
export function outcomeSnippet(text: string, max = SNIPPET_MAX): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line) return clip(line, max)
  }
  return ''
}

/** The error in one line: "codex exited with code 1:" borrows the stderr line that follows. */
export function failureSnippet(message: string, max = SNIPPET_MAX): string {
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  const first = lines[0].endsWith(':') && lines[1] ? `${lines[0]} ${lines[1]}` : lines[0]
  return clip(first.replace(/\s+/g, ' '), max)
}

/** "42s", "4m", "1h 5m" — or null under the floor. */
export function elapsedLabel(ms: number): string | null {
  if (!(ms >= DURATION_FLOOR_MS)) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** How a roundtable's run ended, from its own transcript — each seat's latest word this cycle. */
export function tableOutcome(
  t: Pick<Roundtable, 'mode' | 'concluded' | 'roundsRun' | 'participants' | 'entries'>
): TableOutcome {
  const latest = new Map<number, RoundtableEntry>()
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = t.entries[i]
    if (e.speaker === 'user') break
    // older files carry no seat index — fall back to the provider's first seat
    const seat = e.seat ?? t.participants.findIndex((p) => p.provider === e.speaker)
    if (!latest.has(seat)) latest.set(seat, e)
  }
  const said = [...latest.values()]
  const seats = t.participants.length
  if (said.length === 0) return { kind: 'failed', detail: 'No seat replied.' }
  if (said.every((e) => e.error)) {
    return {
      kind: 'failed',
      detail: said.length === 1 ? failureSnippet(said[0].text) : "Every seat's turn failed."
    }
  }
  if (t.mode === 'consensus' && t.concluded) {
    const agreed = t.participants.every((_, i) => {
      const e = latest.get(i)
      return e !== undefined && !e.error && e.stance === 'agree'
    })
    if (agreed) {
      const note = said.find((e) => e.stanceNote)?.stanceNote
      return {
        kind: 'consensus',
        detail: note ? clip(`All ${seats} agree: ${note}`, SNIPPET_MAX) : `All ${seats} seats agree.`
      }
    }
    const rounds = t.roundsRun === 1 ? '1 round' : `${t.roundsRun} rounds`
    return { kind: 'no-consensus', detail: `No agreement after ${rounds}.` }
  }
  const replies = said.filter((e) => !e.error).length
  return { kind: 'replied', detail: `${replies} of ${seats} seats replied.` }
}

const TABLE_VERB: Record<TableOutcome['kind'], string> = {
  consensus: 'reached consensus',
  'no-consensus': 'ended without consensus',
  replied: 'finished a round',
  failed: 'failed'
}

const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']

/** The persisted file is untrusted input: keep only well-formed, fresh entries, newest last. */
export function sanitizeUnseen(raw: unknown, now: number): Unseen[] {
  const list = Array.isArray(raw) ? raw : []
  const out: Unseen[] = []
  for (const r of list.slice(-LANDING_MAX * 4)) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const key = typeof o['key'] === 'string' ? o['key'].slice(0, 512) : ''
    const kind = o['kind'] === 'roundtable' ? 'roundtable' : o['kind'] === 'session' ? 'session' : null
    const at = typeof o['at'] === 'number' && Number.isFinite(o['at']) ? o['at'] : NaN
    if (!key || !kind || !(at > now - LANDING_TTL_MS)) continue
    const provider = PROVIDERS.find((p) => p === o['provider'])
    out.push({
      key,
      kind,
      id: typeof o['id'] === 'string' ? o['id'].slice(0, 512) : null,
      ...(provider ? { provider } : {}),
      ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'].slice(0, 4096) } : {}),
      startedAt: typeof o['startedAt'] === 'number' ? o['startedAt'] : at,
      at
    })
  }
  return out.sort((a, b) => a.at - b.at).slice(-LANDING_MAX)
}

export type AttentionTrackerInit = {
  readonly now?: () => number
  readonly burstMs?: number
  /** What was still unseen when the app last saved */
  readonly unseen?: readonly Unseen[]
}

export class AttentionTracker {
  private readonly now: () => number
  private readonly burstMs: number
  private readonly flights = new Map<string, Flight>()
  /** Insertion order is age: re-landing deletes and re-inserts */
  private readonly unseen = new Map<string, Unseen>()
  private pending: Pending[] = []
  private due: number | null = null
  private focus: AttentionFocus = { kind: 'none' }
  private windowFocused = false
  /** Banner id → keys it still speaks for */
  private readonly delivered = new Map<string, Set<string>>()
  /** Old key → the key that landing moved to (`turn:` → its session, a forked id → the new one) */
  private readonly aliases = new Map<string, string>()
  private withdrawn: string[] = []

  constructor(init: AttentionTrackerInit = {}) {
    this.now = init.now ?? Date.now
    this.burstMs = init.burstMs ?? BURST_MS
    for (const u of init.unseen ?? []) this.unseen.set(u.key, u)
    this.trim()
  }

  /* ---------- what the user is looking at ---------- */

  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused
    // coming back to a session that landed while the window was in the background
    if (focused) this.see(this.focus)
  }

  /** Opening something is looking at it, focused window or not — that clears its landing. */
  setFocus(focus: AttentionFocus): void {
    this.focus = focus
    this.see(focus)
  }

  /* ---------- turns ---------- */

  turnStarted(start: TurnStart): void {
    const resumeId = start.resumeNativeId ? `${start.provider}:${start.resumeNativeId}` : null
    this.flights.set(start.turnId, {
      turnId: start.turnId,
      provider: start.provider,
      cwd: start.cwd,
      prompt: start.prompt,
      startedAt: this.now(),
      resumed: resumeId !== null,
      ids: new Set(resumeId ? [resumeId] : []),
      latest: resumeId,
      text: '',
      error: null,
      cancelled: false
    })
  }

  /** Follow one ChatManager stream event; turns the tracker never saw start are ignored. */
  chatEvent(ev: ChatEvent): void {
    switch (ev.type) {
      case 'session':
        return this.turnSession(ev.turnId, ev.nativeSessionId)
      case 'text':
        return this.turnText(ev.turnId, ev.text)
      case 'tool':
        return this.turnTool(ev.turnId)
      case 'error':
        return this.turnError(ev.turnId, ev.message)
      case 'done':
        return this.turnDone(ev.turnId)
    }
  }

  turnSession(turnId: string, nativeSessionId: string): void {
    const f = this.flights.get(turnId)
    if (!f) return
    const id = `${f.provider}:${nativeSessionId}`
    f.ids.add(id)
    f.latest = id
  }

  turnText(turnId: string, text: string): void {
    const f = this.flights.get(turnId)
    if (f && f.text.length < TEXT_KEEP) f.text = (f.text + text).slice(0, TEXT_KEEP)
  }

  /** A tool call: whatever the agent said before it was not its closing word. */
  turnTool(turnId: string): void {
    const f = this.flights.get(turnId)
    if (f) f.text = ''
  }

  turnError(turnId: string, message: string): void {
    const f = this.flights.get(turnId)
    if (f) f.error = f.error ?? message
  }

  /** The user stopped it (or closed the window): an ending they caused is not news. */
  turnCancelled(turnId: string): void {
    const f = this.flights.get(turnId)
    if (f) f.cancelled = true
  }

  turnDone(turnId: string): void {
    const f = this.flights.get(turnId)
    if (!f) return
    this.flights.delete(turnId)
    if (f.cancelled || this.watching(f)) return
    const at = this.now()
    const key = f.latest ?? `turn:${f.turnId}`
    // a resumed claude turn forks a fresh id: an older landing under the id it
    // resumed is the same conversation, and must not count twice. Landing again is
    // not opening, so its banner moves with it rather than being withdrawn.
    for (const id of f.ids) this.rekey(id, key)
    this.unseen.delete(key)
    this.unseen.set(key, {
      key,
      kind: 'session',
      id: f.latest,
      provider: f.provider,
      cwd: f.cwd,
      startedAt: f.startedAt,
      at
    })
    const failed = f.error !== null
    this.enqueue({
      key,
      who: AGENT[f.provider],
      verb: failed ? 'failed' : 'finished',
      after: elapsedLabel(at - f.startedAt),
      detail: failed ? failureSnippet(f.error ?? '') : outcomeSnippet(f.text),
      title: null,
      fallbackTitle: clip(outcomeSnippet(f.prompt, TITLE_MAX) || 'New session', TITLE_MAX),
      failed
    })
    this.trim()
  }

  /* ---------- roundtables ---------- */

  tableEnded(end: TableEnd): void {
    const f = this.focus
    if (this.windowFocused && f.kind === 'roundtable' && f.id === end.id) return
    const key = `table:${end.id}`
    this.unseen.delete(key)
    const at = this.now()
    this.unseen.set(key, { key, kind: 'roundtable', id: end.id, startedAt: at, at })
    this.enqueue({
      key,
      who: 'Roundtable',
      verb: TABLE_VERB[end.outcome.kind],
      after: null,
      detail: end.outcome.detail,
      title: clip(end.title, TITLE_MAX),
      fallbackTitle: 'Roundtable',
      failed: end.outcome.kind === 'failed'
    })
    this.trim()
  }

  /* ---------- id-less landings (copilot never names its session) ---------- */

  /** Give id-less session landings the session the index has since found for them. */
  resolve(find: (u: Unseen) => string | null): void {
    for (const u of [...this.unseen.values()]) {
      if (u.kind !== 'session' || u.id !== null) continue
      const id = find(u)
      if (!id || id === u.key) continue
      // an existing landing for that id is the same session — keep the newer one
      const prior = this.unseen.get(id)
      this.rekey(u.key, id)
      if (!prior || prior.at <= u.at) this.unseen.set(id, { ...u, key: id, id })
      else this.unseen.set(id, prior)
    }
  }

  /* ---------- output ---------- */

  /** Epoch ms the pending burst is due, or null when nothing waits. */
  flushAt(): number | null {
    return this.due
  }

  /**
   * Turn the burst into at most one banner and one sound. Anything opened while it
   * waited is dropped — the user got there first. `titleFor` names a session from
   * the index, which by now has usually caught up with a brand-new one.
   */
  flush(prefs: AttentionPrefs, titleFor: (u: Unseen) => string | null): Flush {
    this.due = null
    const live = this.pending.filter((p) => this.unseen.has(p.key))
    this.pending = []
    if (live.length === 0) return { notice: null, sound: null }
    const failed = live.some((p) => p.failed)
    const sound = prefs.sound ? (failed ? 'fail' : 'finish') : null
    if (!prefs.notifications) return { notice: null, sound }
    const nameOf = (p: Pending): string => {
      const u = this.unseen.get(p.key)
      return p.title ?? (u ? titleFor(u) : null) ?? p.fallbackTitle
    }
    let notice: Notice
    if (live.length === 1) {
      const p = live[0]
      notice = {
        id: `cockpit:${p.key}`,
        title: `${p.who} ${p.verb}${p.after ? ` after ${p.after}` : ''}`,
        subtitle: clip(nameOf(p), TITLE_MAX),
        body: p.detail,
        failed,
        target: this.targetOf(p.key),
        keys: [p.key]
      }
    } else {
      const bad = live.filter((p) => p.failed).length
      const ok = live.length - bad
      const title =
        bad === 0
          ? `${ok} sessions finished`
          : ok === 0
            ? `${bad} sessions failed`
            : `${ok} finished · ${bad} failed`
      const lines = live
        .slice(0, SUMMARY_LINES)
        .map((p) => `${p.who} ${p.verb} · ${clip(nameOf(p), TITLE_MAX)}`)
      if (live.length > SUMMARY_LINES) lines.push(`+${live.length - SUMMARY_LINES} more`)
      notice = {
        id: `cockpit:burst:${this.now()}`,
        title,
        subtitle: '',
        body: lines.join('\n'),
        failed,
        // several things landed: the board is where they all are
        target: { kind: 'home' },
        keys: live.map((p) => p.key)
      }
    }
    this.delivered.set(notice.id, new Set(notice.keys))
    while (this.delivered.size > DELIVERED_MAX) {
      this.delivered.delete(this.delivered.keys().next().value as string)
    }
    return { notice, sound }
  }

  /** Where a clicked banner goes now — a copilot landing may have found its session since. */
  targetFor(notice: Notice): AttentionTarget {
    return notice.keys.length === 1 ? this.targetOf(notice.keys[0]) : notice.target
  }

  /** Banner ids whose sessions have all been opened since — take them out of Notification Center. */
  takeWithdrawn(): string[] {
    const ids = this.withdrawn
    this.withdrawn = []
    return ids
  }

  /** The board's landed sessions, newest first. */
  landings(): Landing[] {
    return [...this.unseen.values()]
      .filter((u): u is Unseen & { id: string } => u.kind === 'session' && u.id !== null)
      .sort((a, b) => b.at - a.at)
      .map((u) => ({ id: u.id, at: u.at }))
  }

  /** What the Dock badge shows: everything unseen, tables and not-yet-named sessions included. */
  badgeCount(prefs: AttentionPrefs): number {
    return prefs.badge ? this.unseen.size : 0
  }

  /** The state worth keeping across a restart, oldest first. */
  entries(): Unseen[] {
    return [...this.unseen.values()]
  }

  /* ---------- internals ---------- */

  /** Is the user watching this turn right now? Then its ending is not news. */
  private watching(f: Flight): boolean {
    const v = this.focus
    if (!this.windowFocused || v.kind !== 'session') return false
    if (v.id === null) {
      // a brand-new chat: nothing to match but where it runs and who runs it
      return !f.resumed && v.provider === f.provider && samePath(v.cwd, f.cwd)
    }
    if (f.ids.has(v.id)) return true
    return f.ids.size === 0 && v.provider === f.provider && samePath(v.cwd, f.cwd)
  }

  private see(focus: AttentionFocus): void {
    if (focus.kind === 'none') return
    for (const u of [...this.unseen.values()]) {
      const seen =
        focus.kind === 'roundtable'
          ? u.kind === 'roundtable' && u.id === focus.id
          : u.kind === 'session' &&
            (u.id !== null
              ? u.id === focus.id
              : u.provider === focus.provider && samePath(u.cwd, focus.cwd))
      if (seen) this.drop(u.key)
    }
  }

  /** A key names its own target — opened or not — except a `turn:` nobody has resolved yet. */
  private targetOf(key: string): AttentionTarget {
    let k = key
    for (let hops = 0; hops < 4 && this.aliases.has(k); hops++) k = this.aliases.get(k) as string
    if (k.startsWith('turn:')) return { kind: 'home' }
    if (k.startsWith('table:')) return { kind: 'roundtable', id: k.slice('table:'.length) }
    return { kind: 'session', id: k }
  }

  private enqueue(p: Pending): void {
    // the same session landing twice inside one burst speaks once, with its latest news
    this.pending = [...this.pending.filter((q) => q.key !== p.key), p]
    if (this.due === null) this.due = this.now() + this.burstMs
  }

  /** The same landing under a new key: its pending banner and delivered banners follow. */
  private rekey(from: string, to: string): void {
    if (from === to) return
    this.aliases.delete(from)
    this.aliases.set(from, to)
    while (this.aliases.size > ALIAS_MAX) {
      this.aliases.delete(this.aliases.keys().next().value as string)
    }
    this.unseen.delete(from)
    const moved = this.pending.map((p) => (p.key === from ? { ...p, key: to } : p))
    // one line per session: the later news wins
    this.pending = moved.filter((p, i) => !moved.slice(i + 1).some((q) => q.key === p.key))
    for (const keys of this.delivered.values()) {
      if (keys.delete(from)) keys.add(to)
    }
  }

  /** Opened (or expired): gone from the badge, and banners with nothing left to say are withdrawn. */
  private drop(key: string): void {
    if (!this.unseen.delete(key)) return
    for (const [id, keys] of this.delivered) {
      if (keys.delete(key) && keys.size === 0) {
        this.delivered.delete(id)
        this.withdrawn.push(id)
      }
    }
  }

  private trim(): void {
    const cutoff = this.now() - LANDING_TTL_MS
    for (const u of [...this.unseen.values()]) {
      if (u.at <= cutoff) this.drop(u.key)
    }
    while (this.unseen.size > LANDING_MAX) {
      this.drop(this.unseen.keys().next().value as string)
    }
  }
}
