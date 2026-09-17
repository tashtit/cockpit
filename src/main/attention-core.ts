import { normalize } from 'node:path'
import type {
  AttentionAsk,
  AttentionFocus,
  AttentionPr,
  AttentionPrefs,
  AttentionTarget,
  ChatEvent,
  Landing,
  PrChecks,
  PrReview,
  PrStatus,
  Provider,
  Roundtable,
  RoundtableEntry
} from '../shared/types'
import type { ObservedTurn } from './liveness-core'

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
 *
 * Three inputs feed it. Turns Cockpit spawned (ChatManager's events) and roundtable
 * runs; turns *observed* in the logs of sessions run elsewhere — a terminal, the
 * provider's own app — which the liveness tracker reports as they end, and as they
 * stop to ask the person something; and the PR badges' own refreshes, when an open
 * pull request on a session's branch turns red. Every one lands under the same rule:
 * on screen in a focused window, it is not news.
 */

/** Endings this close together share one notification. */
export const BURST_MS = 1500
/** Landings older than this are noise, not news. */
export const LANDING_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * A question nobody answered for this long is not waiting any more: the CLI was closed,
 * or the answer went in somewhere the log never showed. Real waits run minutes, not hours.
 */
export const WAIT_TTL_MS = 12 * 60 * 60 * 1000
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
/**
 * A spawned turn's log is observed too, and its ending record reaches the tracker a
 * debounce after the process exit landed it: an observed ending this soon after one
 * of Cockpit's own is that echo, not a second landing.
 */
export const OBSERVED_ECHO_MS = 15_000
/** Pull requests already raised, by head commit — bounded like everything else here. */
const SEEN_PRS_MAX = 200

const AGENT: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }

/**
 * Something that needs the user and hasn't been looked at — a session's ended turn, a
 * concluded table, an agent's question, a red pull request. Persisted.
 */
export type Unseen = {
  /**
   * The session id, `table:<id>`, `turn:<turnId>` until the agent names its session,
   * `asks:<session id>` for a question, `pr:<repo root>#<number>` for a pull request
   */
  readonly key: string
  readonly kind: 'session' | 'roundtable' | 'asks' | 'pr'
  /** Session id (null until known — copilot never announces one) or table id */
  readonly id: string | null
  readonly provider?: Provider
  readonly cwd?: string
  /** When the turn started: how an id-less landing finds the session it became */
  readonly startedAt: number
  /** When it became news */
  readonly at: number
  /** `asks`: what the agent is waiting for */
  readonly asks?: AttentionAsk
  /** `pr`: the pull request, and the head commit it went red on */
  readonly pr?: AttentionPr
  readonly sha?: string
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

/** What a burst counts: how each pending banner reads in a summary title. */
type Group = 'finished' | 'failed' | 'asks' | 'pr'

/** A notification waiting out the burst window. */
type Pending = {
  readonly key: string
  /** "Claude", "Roundtable", "PR #57" */
  readonly who: string
  /** "finished", "failed", "reached consensus", "asks you" */
  readonly verb: string
  /** "4m", or null when too quick to be worth saying */
  readonly after: string | null
  readonly detail: string
  /** Tables know their title; sessions resolve theirs at flush (the index catches up) */
  readonly title: string | null
  /** The prompt, for a brand-new session the index hasn't seen yet */
  readonly fallbackTitle: string
  readonly failed: boolean
  /** Which sound speaks for it — a red PR sounds like a failure without being one */
  readonly tone: 'finish' | 'fail'
  readonly group: Group
}

const sameAsk = (a: AttentionAsk, b: AttentionAsk): boolean => a.kind === b.kind && a.detail === b.detail

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
const KINDS: readonly Unseen['kind'][] = ['session', 'roundtable', 'asks', 'pr']
const CHECKS: readonly PrChecks[] = ['passing', 'failing', 'pending', 'none']
const REVIEWS: readonly PrReview[] = ['approved', 'changes_requested', 'review_required', 'none']

/** The provider a session id names, or undefined for a shape this code doesn't know. */
function providerOf(id: string): Provider | undefined {
  return PROVIDERS.find((p) => id.startsWith(`${p}:`))
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

function sanitizeAsk(raw: unknown): AttentionAsk | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const kind = o?.['kind'] === 'question' ? 'question' : o?.['kind'] === 'permission' ? 'permission' : null
  return kind ? { kind, detail: str(o?.['detail'], 512) ?? '' } : null
}

function sanitizePr(raw: unknown): AttentionPr | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const number = o?.['number']
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null
  const checks = CHECKS.find((c) => c === o?.['checks'])
  const review = REVIEWS.find((r) => r === o?.['review'])
  if (!checks || !review) return null
  return { number, title: str(o?.['title'], 512) ?? '', url: str(o?.['url'], 2048) ?? '', checks, review }
}

/** The persisted file is untrusted input: keep only well-formed, fresh entries, newest last. */
export function sanitizeUnseen(raw: unknown, now: number): Unseen[] {
  const list = Array.isArray(raw) ? raw : []
  const out: Unseen[] = []
  for (const r of list.slice(-LANDING_MAX * 4)) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const key = str(o['key'], 512) ?? ''
    const kind = KINDS.find((k) => k === o['kind'])
    const at = typeof o['at'] === 'number' && Number.isFinite(o['at']) ? o['at'] : NaN
    if (!key || !kind || !(at > now - (kind === 'asks' ? WAIT_TTL_MS : LANDING_TTL_MS))) continue
    const provider = PROVIDERS.find((p) => p === o['provider'])
    const id = str(o['id'], 512)
    const cwd = str(o['cwd'], 4096)
    const base = {
      key,
      kind,
      id,
      ...(provider ? { provider } : {}),
      ...(cwd !== null ? { cwd } : {}),
      startedAt: typeof o['startedAt'] === 'number' ? o['startedAt'] : at,
      at
    }
    if (kind === 'asks') {
      const asks = sanitizeAsk(o['asks'])
      if (!asks || id === null) continue
      out.push({ ...base, asks })
    } else if (kind === 'pr') {
      const pr = sanitizePr(o['pr'])
      if (!pr || id === null) continue
      out.push({ ...base, pr, sha: str(o['sha'], 64) ?? '' })
    } else {
      out.push(base)
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(-LANDING_MAX)
}

/** The pull requests already raised (`[key, head sha]` pairs), from the same untrusted file. */
export function sanitizeSeenPrs(raw: unknown): Array<[string, string]> {
  const list = Array.isArray(raw) ? raw : []
  const out: Array<[string, string]> = []
  for (const r of list.slice(-SEEN_PRS_MAX)) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string') continue
    out.push([r[0].slice(0, 512), r[1].slice(0, 64)])
  }
  return out
}

/** The "needs you" row a persisted entry makes, or null for a table or a still-unnamed session. */
function toLanding(u: Unseen): Landing | null {
  if (u.id === null) return null
  switch (u.kind) {
    case 'session':
      return { id: u.id, at: u.at, kind: 'landed' }
    case 'asks':
      return u.asks ? { id: u.id, at: u.at, kind: 'asks', asks: u.asks } : null
    case 'pr':
      return u.pr ? { id: u.id, at: u.at, kind: 'pr', pr: u.pr } : null
    case 'roundtable':
      return null
  }
}

/** Which reason a session row carries when it has several: a question beats a red PR beats an ending. */
const URGENCY: Record<Landing['kind'], number> = { asks: 0, pr: 1, landed: 2 }

/** A pull request GitHub's own merge box would show red. */
export function prIsRed(pr: Pick<PrStatus, 'state' | 'checks' | 'review'>): boolean {
  return pr.state === 'OPEN' && (pr.checks === 'failing' || pr.review === 'changes_requested')
}

export type AttentionTrackerInit = {
  readonly now?: () => number
  readonly burstMs?: number
  /** What was still unseen when the app last saved */
  readonly unseen?: readonly Unseen[]
  /** Pull requests already raised, by head commit, so a restart never repeats them */
  readonly seenPrs?: ReadonlyArray<readonly [string, string]>
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
  /** Spawned turns that ended lately, by session id and by `provider|cwd` — observed echoes of them are skipped */
  private readonly recentEnds = new Map<string, number>()
  /** PR key → the head commit it was last raised for (insertion order is age) */
  private readonly seenPrs = new Map<string, string>()

  constructor(init: AttentionTrackerInit = {}) {
    this.now = init.now ?? Date.now
    this.burstMs = init.burstMs ?? BURST_MS
    for (const u of init.unseen ?? []) this.unseen.set(u.key, u)
    for (const [key, sha] of init.seenPrs ?? []) this.seenPrs.set(key, sha)
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
    const at = this.now()
    // the log's own ending record follows within a debounce — that is not a second ending
    for (const id of f.ids) this.recentEnds.set(id, at)
    this.recentEnds.set(`${f.provider}|${trimSep(normalize(f.cwd))}`, at)
    while (this.recentEnds.size > LANDING_MAX) {
      this.recentEnds.delete(this.recentEnds.keys().next().value as string)
    }
    if (f.cancelled || this.watching(f)) return
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
      failed,
      tone: failed ? 'fail' : 'finish',
      group: failed ? 'failed' : 'finished'
    })
    this.trim()
  }

  /* ---------- turns observed in the logs (a terminal, the provider's own app) ---------- */

  /**
   * The liveness tracker saw a session's log move: a turn running, stopped on a
   * question, or ended. Sessions Cockpit is running itself are its flights' business
   * — their process exit lands them with better information, and the log's ending
   * record arrives right after as an echo. Everything else lands under the same rule
   * as a spawned turn: on screen in a focused window, it is not news.
   */
  observedTurn(ev: ObservedTurn): void {
    if (this.spawned(ev)) return
    const askKey = `asks:${ev.id}`
    switch (ev.type) {
      case 'running':
        // the person is at that keyboard: the last landing is seen, the question answered
        this.drop(askKey)
        this.drop(ev.id)
        return
      case 'settled':
        // the log is idle, so no question is open — but a landing stays: the records a
        // turn writes after it ends (a title, a summary) must not clear fresh news
        this.drop(askKey)
        return
      case 'asks': {
        this.drop(ev.id)
        const prior = this.unseen.get(askKey)
        if (prior?.asks && sameAsk(prior.asks, ev.asks)) return
        this.drop(askKey)
        if (this.watchingId(ev.id)) return
        const at = this.now()
        this.unseen.set(askKey, {
          key: askKey,
          kind: 'asks',
          id: ev.id,
          provider: ev.provider,
          ...(ev.cwd ? { cwd: ev.cwd } : {}),
          startedAt: ev.startedAt,
          at,
          asks: ev.asks
        })
        const question = ev.asks.kind === 'question'
        this.enqueue({
          key: askKey,
          who: AGENT[ev.provider],
          verb: question ? 'asks you' : 'needs permission',
          after: null,
          detail: clip(ev.asks.detail, SNIPPET_MAX) || (question ? 'Answer in the session.' : 'Approve it where the agent runs.'),
          title: null,
          fallbackTitle: 'Session',
          failed: false,
          tone: 'finish',
          group: 'asks'
        })
        this.trim()
        return
      }
      case 'ended': {
        this.drop(askKey)
        if (this.watchingId(ev.id) || this.echoed(ev)) return
        const at = this.now()
        this.unseen.delete(ev.id)
        this.unseen.set(ev.id, {
          key: ev.id,
          kind: 'session',
          id: ev.id,
          provider: ev.provider,
          ...(ev.cwd ? { cwd: ev.cwd } : {}),
          startedAt: ev.startedAt,
          at
        })
        const failed = ev.failed === true
        this.enqueue({
          key: ev.id,
          who: AGENT[ev.provider],
          verb: failed ? 'failed' : 'finished',
          after: elapsedLabel(ev.endedAt - ev.startedAt),
          detail: failed ? failureSnippet(ev.closing ?? '') : outcomeSnippet(ev.closing ?? ''),
          title: null,
          fallbackTitle: 'Session',
          failed,
          tone: failed ? 'fail' : 'finish',
          group: failed ? 'failed' : 'finished'
        })
        this.trim()
        return
      }
    }
  }

  /** Drop the questions that are no longer waiting — the desk re-reads their logs once after launch. */
  settleAsks(stillWaiting: (u: Unseen) => boolean): void {
    for (const u of [...this.unseen.values()]) {
      if (u.kind === 'asks' && !stillWaiting(u)) this.drop(u.key)
    }
  }

  /* ---------- pull requests (the badges' refreshes, never a poller of its own) ---------- */

  /**
   * One repo's PR list came back from gh. A red open PR — failing checks, or changes
   * requested — on a branch some session is working on is news once per head commit:
   * the list refreshes every minute, and a push is what makes it new again. `carrierFor`
   * names the session whose row carries it (main knows the index); a PR nobody's
   * session is on has no row and waits for one. A PR that went green, or left the
   * list, waits on nobody.
   */
  prsUpdated(repoRoot: string, prs: readonly PrStatus[], carrierFor: (pr: PrStatus) => string | null): void {
    // the list is `--state all`, so an empty one is a failed gh call (answered [] and cached)
    // or a repo with no PRs at all — nothing to clear either way, and a failure must not
    // forget a PR that is still red
    if (prs.length === 0) return
    const prefix = `pr:${trimSep(normalize(repoRoot))}#`
    const listed = new Set<string>()
    for (const pr of prs) {
      const key = `${prefix}${pr.number}`
      listed.add(key)
      if (!prIsRed(pr)) {
        this.drop(key)
        // green in between: the same commit turning red again (a review after a pass) is news
        this.seenPrs.delete(key)
        continue
      }
      const item: AttentionPr = {
        number: pr.number,
        title: clip(pr.title, TITLE_MAX * 2),
        url: pr.url,
        checks: pr.checks,
        review: pr.review
      }
      if (this.seenPrs.get(key) === pr.headSha) {
        // already raised for this push — keep what the row says current, say nothing new
        const u = this.unseen.get(key)
        if (u?.pr && (u.pr.checks !== item.checks || u.pr.review !== item.review)) {
          this.unseen.set(key, { ...u, pr: item })
        }
        continue
      }
      const id = carrierFor(pr)
      if (!id) continue
      this.rememberPr(key, pr.headSha)
      this.drop(key)
      // the badge on screen already says it
      if (this.watchingId(id)) continue
      const at = this.now()
      this.unseen.set(key, {
        key,
        kind: 'pr',
        id,
        ...(providerOf(id) ? { provider: providerOf(id) } : {}),
        startedAt: at,
        at,
        pr: item,
        sha: pr.headSha
      })
      this.enqueue({
        key,
        who: `PR #${pr.number}`,
        verb: pr.checks === 'failing' ? 'has failing checks' : 'has changes requested',
        after: null,
        detail: pr.headRefName,
        title: clip(pr.title, TITLE_MAX),
        fallbackTitle: `PR #${pr.number}`,
        failed: false,
        tone: 'fail',
        group: 'pr'
      })
    }
    for (const u of [...this.unseen.values()]) {
      if (u.kind === 'pr' && u.key.startsWith(prefix) && !listed.has(u.key)) this.drop(u.key)
    }
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
    const failed = end.outcome.kind === 'failed'
    this.enqueue({
      key,
      who: 'Roundtable',
      verb: TABLE_VERB[end.outcome.kind],
      after: null,
      detail: end.outcome.detail,
      title: clip(end.title, TITLE_MAX),
      fallbackTitle: 'Roundtable',
      failed,
      tone: failed ? 'fail' : 'finish',
      group: failed ? 'failed' : 'finished'
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
    const sound = prefs.sound ? (live.some((p) => p.tone === 'fail') ? 'fail' : 'finish') : null
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
      const count = (g: Group): number => live.filter((p) => p.group === g).length
      const [ok, bad, asks, prs] = [count('finished'), count('failed'), count('asks'), count('pr')]
      const parts = [
        ok > 0 && `${ok} finished`,
        bad > 0 && `${bad} failed`,
        asks > 0 && `${asks} waiting on you`,
        prs > 0 && `${prs} ${prs === 1 ? 'PR' : 'PRs'} red`
      ].filter((s): s is string => typeof s === 'string')
      const title =
        ok === live.length
          ? `${ok} sessions finished`
          : bad === live.length
            ? `${bad} sessions failed`
            : parts.join(' · ')
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

  /**
   * The board's "needs you" rows, newest first: one per session, carrying its most
   * urgent reason — a question over a red PR over an ended turn.
   */
  landings(): Landing[] {
    const best = new Map<string, Landing>()
    for (const u of this.unseen.values()) {
      const l = toLanding(u)
      if (!l) continue
      const prev = best.get(l.id)
      if (!prev || URGENCY[l.kind] < URGENCY[prev.kind] || (URGENCY[l.kind] === URGENCY[prev.kind] && l.at > prev.at)) {
        best.set(l.id, l)
      }
    }
    return [...best.values()].sort((a, b) => b.at - a.at)
  }

  /** What the Dock badge shows: everything unseen, tables and not-yet-named sessions included. */
  badgeCount(prefs: AttentionPrefs): number {
    return prefs.badge ? this.unseen.size : 0
  }

  /** The state worth keeping across a restart, oldest first. */
  entries(): Unseen[] {
    return [...this.unseen.values()]
  }

  /** Pull requests already raised, by head commit — kept across a restart with the entries. */
  seenPrEntries(): Array<[string, string]> {
    return [...this.seenPrs.entries()]
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

  /** Is this session on screen in a focused window? Then what happens in it is not news. */
  private watchingId(id: string): boolean {
    const v = this.focus
    return this.windowFocused && v.kind === 'session' && v.id === id
  }

  /** Is Cockpit itself running a turn in this session? Its flight lands it. */
  private spawned(ev: ObservedTurn): boolean {
    for (const f of this.flights.values()) {
      if (f.ids.has(ev.id)) return true
      if (f.ids.size === 0 && f.provider === ev.provider && samePath(f.cwd, ev.cwd ?? undefined)) return true
    }
    return false
  }

  /** Did one of Cockpit's own turns in this session just end? Then this ending is its echo in the log. */
  private echoed(ev: ObservedTurn): boolean {
    const since = this.now() - OBSERVED_ECHO_MS
    const byId = this.recentEnds.get(ev.id)
    if (byId !== undefined && byId > since) return true
    if (!ev.cwd) return false
    const byPlace = this.recentEnds.get(`${ev.provider}|${trimSep(normalize(ev.cwd))}`)
    return byPlace !== undefined && byPlace > since
  }

  private rememberPr(key: string, sha: string): void {
    this.seenPrs.delete(key)
    this.seenPrs.set(key, sha)
    while (this.seenPrs.size > SEEN_PRS_MAX) {
      this.seenPrs.delete(this.seenPrs.keys().next().value as string)
    }
  }

  private see(focus: AttentionFocus): void {
    if (focus.kind === 'none') return
    for (const u of [...this.unseen.values()]) {
      const seen =
        focus.kind === 'roundtable'
          ? u.kind === 'roundtable' && u.id === focus.id
          : u.kind !== 'roundtable' &&
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
    if (k.startsWith('asks:')) return { kind: 'session', id: k.slice('asks:'.length) }
    if (k.startsWith('pr:')) {
      // the row that carries it, if it is still unseen; the board otherwise
      const id = this.unseen.get(k)?.id
      return id ? { kind: 'session', id } : { kind: 'home' }
    }
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
    const now = this.now()
    for (const u of [...this.unseen.values()]) {
      if (u.at <= now - (u.kind === 'asks' ? WAIT_TTL_MS : LANDING_TTL_MS)) this.drop(u.key)
    }
    while (this.unseen.size > LANDING_MAX) {
      this.drop(this.unseen.keys().next().value as string)
    }
  }
}
