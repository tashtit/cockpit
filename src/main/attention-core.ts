import { basename, normalize } from 'node:path'
import type {
  AttentionFocus,
  AttentionItem,
  AttentionPrefs,
  AttentionReason,
  AttentionTarget,
  ChatEvent,
  PrStatus,
  Provider,
  Roundtable,
  RoundtableEntry,
  SessionMeta
} from '../shared/types'
import { contentToText, shellPreview, toMs } from './parsers/util'

/**
 * Attention, the IO-free half: what needs the user, what the Dock badge counts, and
 * how a burst of news becomes one notification. `attention.ts` feeds it events and
 * carries out what it decides; nothing here touches Electron, the file system or a
 * clock it wasn't handed.
 *
 * The vocabulary is the board's. A turn *lands* when it ends; it stays *unseen*
 * until the user opens it. An agent *waits* when its log's newest record is a
 * question or a tool call needing approval; a pull request on one of the user's
 * branches is *red* while its checks fail or a reviewer sent it back. Every one of
 * those is an item on the same list — the "Needs you" group on the home board, the
 * sidebar's markers, the badge count — and main owns the list because only main sees
 * every log write and every turn end, including for sessions no view has open. The
 * renderer tells it what is on screen.
 */

/** Endings this close together share one notification. */
export const BURST_MS = 1500
/** Items older than this are noise, not news. */
export const ITEM_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * An agent waiting on an answer this long has more likely been closed than
 * forgotten — Claude Code and Codex write nothing when a terminal goes away.
 */
export const WAIT_TTL_MS = 12 * 60 * 60 * 1000
/** Bound the set: a long day of many sessions must not grow the file or the badge forever. */
export const ITEM_MAX = 60
/** Conditions remembered as looked at or already announced — the same one never repeats. */
const MEMORY_MAX = 200
/** Delivered banners remembered for withdrawal once their items are opened. */
const DELIVERED_MAX = 30
/** Renamed keys remembered, so a banner posted under the old one still opens the right thing. */
const ALIAS_MAX = 100
/** A spawned turn's ending is remembered this long, so the log's own ending of it is not news twice. */
const SPAWNED_END_MS = 30_000
/** How much of a turn's closing text is kept to quote from. */
const TEXT_KEEP = 600
const SNIPPET_MAX = 110
const TITLE_MAX = 60
const SUMMARY_LINES = 3
/** Faster than this, a duration says nothing ("failed after 0s"). */
const DURATION_FLOOR_MS = 5_000

const AGENT: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' }
const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']
const REASONS: readonly AttentionReason[] = ['landed', 'failed', 'question', 'permission', 'checks', 'review']

export type Sound = 'finish' | 'fail' | 'ask'

/** Something that needs the user — one per session, table or PR. Persisted. */
export type Unseen = {
  /** The session id, `table:<id>`, `pr:<url>`, or `turn:<turnId>` until the agent names its session */
  readonly key: string
  readonly kind: 'session' | 'roundtable' | 'pr'
  readonly reason: AttentionReason
  /** Session id (null until known — copilot never announces one) or table id; null for a PR */
  readonly id: string | null
  readonly provider?: Provider
  readonly cwd?: string
  /** When the turn started: how an id-less landing finds the session it became */
  readonly startedAt: number
  /** When it was raised */
  readonly at: number
  /** The question, the command, the closing words or the error — one line */
  readonly detail: string
  /** A table's title, or the prompt that started a session the index hasn't named yet */
  readonly title?: string
  /** The condition that raised it: the same one never raises again once looked at */
  readonly signature?: string
  /** PR items: the PR, its repo, and the newest session on its branch */
  readonly pr?: PrStatus
  readonly repoRoot?: string
  readonly sessionId?: string | null
}

export type TurnStart = {
  readonly turnId: string
  readonly provider: Provider
  readonly cwd: string
  readonly prompt: string
  readonly resumeNativeId?: string
}

/** An observed turn (a terminal, the provider's own app) ended: its log says so. */
export type ObservedEnd = {
  readonly id: string
  readonly provider: Provider
  readonly startedAt: number
}

/** An open PR on one of the user's branches, as the sweep found it. */
export type PrSignal = {
  readonly pr: PrStatus
  readonly repoRoot: string
  /** The newest session on the PR's branch, when the index has one */
  readonly session: SessionMeta | null
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
  /** Stable per item, so a second raise replaces its first banner instead of stacking */
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
  readonly sound: Sound | null
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
  /** "Claude finished after 4m", "Codex needs approval", "Checks failing on #57" */
  readonly headline: string
  /** The headline without its duration — a burst's lines, one per item */
  readonly summary: string
  readonly detail: string
  /** Tables and PRs know their title; sessions resolve theirs at flush (the index catches up) */
  readonly title: string | null
  /** The prompt, for a brand-new session the index hasn't seen yet */
  readonly fallbackTitle: string
  readonly failed: boolean
  readonly sound: Sound
  /** How the burst summary counts it */
  readonly tally: 'finished' | 'failed' | 'waiting' | 'pr'
}

const samePath = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && trimSep(normalize(a)) === trimSep(normalize(b))

const trimSep = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s

/** The provider a session id names, or null for a key that is not one. */
export function providerOf(id: string): Provider | null {
  return PROVIDERS.find((p) => id.startsWith(`${p}:`)) ?? null
}

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

/* ---------- what the tail of a log says ---------- */

/** The agent is waiting on the user right now. */
export type TailWait = {
  readonly reason: 'question' | 'permission'
  /** The question's first line, the command awaiting approval, "approve the plan" */
  readonly detail: string
  /** The tool call or request that asks — the same ask never raises twice once looked at */
  readonly signature: string
  readonly at: number | null
}

/** The newest turn ended in an error the log records. */
export type TailFailure = {
  readonly detail: string
  readonly signature: string
  readonly at: number | null
}

/**
 * What the newest records of a session log say the session waits for, or how its
 * turn ended. Read beside liveness-core's verdict — that one says *whether* a turn
 * runs, this one says *what for*. Same protocol: `null` means nothing in these
 * records speaks for it, read further back; `QUIET` means the turn is going about
 * its business, nothing waits and nothing ended. Log formats drift between
 * releases, so every rule errs towards quiet: an unrecognised shape never becomes a
 * phantom question.
 */
export type TailAttention = {
  readonly waiting: TailWait | null
  readonly failed: TailFailure | null
  /** The agent's closing words, when the newest turn ended with an answer */
  readonly closing: string
  /** The newest turn is over — with an answer or a failure — rather than under way */
  readonly ended: boolean
}

export const QUIET: TailAttention = { waiting: null, failed: null, closing: '', ended: false }

const waitOn = (wait: TailWait): TailAttention => ({ waiting: wait, failed: null, closing: '', ended: false })
const failedWith = (failed: TailFailure): TailAttention => ({ waiting: null, failed, closing: '', ended: true })
const closedWith = (closing: string): TailAttention => ({ waiting: null, failed: null, closing, ended: true })

export function judgeAttentionTail(provider: Provider, records: readonly any[]): TailAttention | null {
  switch (provider) {
    case 'claude':
      return judgeClaudeAttention(records)
    case 'codex':
      return judgeCodexAttention(records)
    case 'copilot':
      return judgeCopilotAttention(records)
  }
}

/* claude */

function claudeBlocks(r: any): any[] {
  const c = r?.message?.content
  return Array.isArray(c) ? c : []
}

function isClaudeToolResult(r: any): boolean {
  return r?.toolUseResult !== undefined || claudeBlocks(r).some((b) => b?.type === 'tool_result')
}

/**
 * The tools that stop and ask. A plain permission prompt leaves no record of its own
 * — a tool_use waiting on approval reads exactly like one that is running — so only
 * the explicit asks are named here, never guessed from a pause.
 */
function claudeAsk(block: any): Omit<TailWait, 'at'> | null {
  const id = typeof block?.id === 'string' ? block.id : ''
  if (block?.name === 'AskUserQuestion') {
    const qs = block.input?.questions
    const first = Array.isArray(qs) ? qs.find((q: any) => typeof q?.question === 'string') : null
    return {
      reason: 'question',
      detail: clip(outcomeSnippet(String(first?.question ?? '')) || 'asked a question', SNIPPET_MAX),
      signature: `ask:${id}`
    }
  }
  if (block?.name === 'ExitPlanMode') {
    return { reason: 'permission', detail: 'approve the plan', signature: `plan:${id}` }
  }
  return null
}

/**
 * Newest message record first: a prompt or a tool result means the model is at
 * work; an explicit ask with nothing after it means the user is; a text-only answer
 * is the closing word, and the API-error message the CLI writes when a turn dies is
 * its failure. Thinking-only records and the CLI's bookkeeping lines say nothing.
 */
export function judgeClaudeAttention(records: readonly any[]): TailAttention | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r?.isSidechain === true) continue
    if (r?.type === 'user') {
      // an answered ask arrives as a tool result like any other
      return QUIET
    }
    if (r?.type === 'assistant' && r.message) {
      const blocks = claudeBlocks(r)
      const at = toMs(r.timestamp)
      for (const b of blocks) {
        if (b?.type !== 'tool_use') continue
        const ask = claudeAsk(b)
        if (ask) return waitOn({ ...ask, at })
      }
      if (blocks.some((b) => b?.type === 'tool_use')) return QUIET
      const text = contentToText(r.message.content)
      if (r.isApiErrorMessage === true) {
        return failedWith({
          detail: failureSnippet(text || 'API error'),
          signature: `api:${r.uuid ?? r.timestamp ?? i}`,
          at
        })
      }
      if (!text.trim()) continue // streamed thinking, nothing said yet
      return closedWith(text)
    }
    // stop_hook_summary, api_error (retrying), attachments, titles … say nothing
  }
  return null
}

/* codex */

const CODEX_WAITS: Record<string, 'question' | 'permission'> = {
  exec_approval_request: 'permission',
  apply_patch_approval_request: 'permission',
  request_user_input: 'question',
  elicitation_request: 'question'
}

/** What an approval asks for, in the words the terminal shows. */
function codexAskDetail(kind: 'question' | 'permission', p: any): string {
  if (p?.type === 'exec_approval_request') {
    return clip(shellPreview(p.command) ?? String(p.reason ?? 'run a command'), SNIPPET_MAX)
  }
  if (p?.type === 'apply_patch_approval_request') {
    const files = p.changes && typeof p.changes === 'object' ? Object.keys(p.changes).map((f) => basename(f)) : []
    return clip(files.length > 0 ? `apply_patch ${files.join(', ')}` : 'apply a patch', SNIPPET_MAX)
  }
  const qs = p?.questions
  const first = Array.isArray(qs) ? qs.find((q: any) => typeof q?.question === 'string') : null
  const text = first?.question ?? p?.message ?? p?.prompt ?? ''
  return clip(outcomeSnippet(String(text)) || (kind === 'question' ? 'asked a question' : 'needs approval'), SNIPPET_MAX)
}

/**
 * codex-rs streams an `event_msg` per turn event and a `response_item` per model
 * item. The newest decides: `task_complete` carries the final message, `error` the
 * failure, an approval request or an input request means the user's turn; anything
 * the model or a tool produced after those means the turn moved on. Approval events
 * are named from the protocol — rollouts on hand carry none, so that rule is
 * best-effort by design.
 */
export function judgeCodexAttention(records: readonly any[]): TailAttention | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!r || typeof r !== 'object') continue
    const p = r.payload
    if (r.type === 'event_msg' && p && typeof p === 'object') {
      const at = toMs(r.timestamp)
      switch (p.type) {
        case 'task_complete':
          return closedWith(typeof p.last_agent_message === 'string' ? p.last_agent_message : '')
        case 'turn_aborted':
        case 'task_started':
        case 'user_message':
        case 'item_completed':
          return QUIET
        case 'agent_message':
          return closedWith(typeof p.message === 'string' ? p.message : '')
        case 'error':
          return failedWith({
            detail: failureSnippet(String(p.message ?? 'Codex reported an error')),
            signature: `error:${r.timestamp ?? i}`,
            at
          })
        default: {
          const kind = CODEX_WAITS[String(p.type)]
          if (kind) {
            const id = p.call_id ?? p.request_id ?? p.id ?? r.timestamp ?? i
            return waitOn({ reason: kind, detail: codexAskDetail(kind, p), signature: `${p.type}:${id}`, at })
          }
          continue // token_count, thread settings, reasoning …
        }
      }
    }
    if (r.type === 'response_item' && p && typeof p === 'object') {
      switch (p.type) {
        case 'message':
          if (p.role === 'assistant' && p.phase !== 'commentary') return closedWith(contentToText(p.content))
          return QUIET
        case 'function_call':
        case 'custom_tool_call':
        case 'local_shell_call':
        case 'web_search_call':
        case 'function_call_output':
        case 'custom_tool_call_output':
        case 'reasoning':
        case 'compaction':
          return QUIET
        default:
          continue
      }
    }
    if (r.type === 'session_meta') return QUIET
  }
  return null
}

/* copilot */

/** What a permission request wants, the way the CLI's own prompt says it. */
function copilotAskDetail(d: any): string {
  const req = d?.permissionRequest
  const intention = typeof req?.intention === 'string' ? req.intention.trim() : ''
  if (intention) return clip(intention, SNIPPET_MAX)
  const command = typeof req?.fullCommandText === 'string' ? req.fullCommandText.trim().split('\n', 1)[0] : ''
  if (command) return clip(command, SNIPPET_MAX)
  return typeof req?.kind === 'string' ? `${req.kind} permission` : 'needs approval'
}

/**
 * Copilot CLI writes `permission.requested` the moment it asks and
 * `permission.completed` (same requestId) when the user answers — granted, denied
 * or cancelled alike. `session.error` is a turn that gave up; `assistant.message`
 * and `session.task_complete` carry the closing words. Tool and turn brackets mean
 * the turn moved on.
 */
export function judgeCopilotAttention(records: readonly any[]): TailAttention | null {
  const answered = new Set<string>()
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    const d = r?.data
    const at = toMs(r?.timestamp)
    switch (r?.type) {
      case 'permission.completed':
        if (typeof d?.requestId === 'string') answered.add(d.requestId)
        continue
      case 'permission.requested': {
        const id = typeof d?.requestId === 'string' ? d.requestId : ''
        if (id && answered.has(id)) continue
        return waitOn({
          reason: 'permission',
          detail: copilotAskDetail(d),
          signature: `permission:${id || r.id || r.timestamp || i}`,
          at
        })
      }
      case 'session.error':
        return failedWith({
          detail: failureSnippet(String(d?.message ?? 'Copilot reported an error')),
          signature: `error:${r.id ?? r.timestamp ?? i}`,
          at
        })
      case 'assistant.message':
        return closedWith(typeof d?.content === 'string' ? d.content : '')
      case 'session.task_complete':
        return closedWith(typeof d?.summary === 'string' ? d.summary : '')
      case 'user.message':
      case 'abort':
      case 'assistant.turn_start':
      case 'tool.execution_start':
      case 'tool.execution_complete':
        return QUIET
      default:
        continue // turn_end, shutdown, hooks, usage checkpoints … the record before says how
    }
  }
  return null
}

/* ---------- roundtables ---------- */

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

/* ---------- pull requests ---------- */

const PR_STATES = new Set(['OPEN', 'MERGED', 'CLOSED'])
const PR_CHECKS = new Set(['passing', 'failing', 'pending', 'none'])
const PR_REVIEWS = new Set(['approved', 'changes_requested', 'review_required', 'none'])

/** Why an open PR needs its author, or null while it is fine. Failing checks outrank a review. */
export function prReason(pr: PrStatus): 'checks' | 'review' | null {
  if (pr.state !== 'OPEN') return null
  if (pr.checks === 'failing') return 'checks'
  if (pr.review === 'changes_requested') return 'review'
  return null
}

/** The condition on the PR: a new one after a recovery raises it again. */
const prSignature = (pr: PrStatus, reason: 'checks' | 'review'): string =>
  `${reason}:${pr.checks}:${pr.review}`

/** A persisted PR, shaped like the sidebar's rows; null for anything a PrBadge could not render. */
function sanitizePr(raw: unknown): PrStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['number'] !== 'number' || typeof o['url'] !== 'string') return null
  if (typeof o['state'] !== 'string' || !PR_STATES.has(o['state'])) return null
  if (typeof o['checks'] !== 'string' || !PR_CHECKS.has(o['checks'])) return null
  if (typeof o['review'] !== 'string' || !PR_REVIEWS.has(o['review'])) return null
  return {
    number: o['number'],
    title: typeof o['title'] === 'string' ? o['title'].slice(0, 512) : '',
    state: o['state'] as PrStatus['state'],
    isDraft: o['isDraft'] === true,
    headRefName: typeof o['headRefName'] === 'string' ? o['headRefName'].slice(0, 512) : '',
    url: o['url'].slice(0, 2048),
    checks: o['checks'] as PrStatus['checks'],
    review: o['review'] as PrStatus['review'],
    unresolvedThreads: typeof o['unresolvedThreads'] === 'number' ? o['unresolvedThreads'] : 0
  }
}

/* ---------- the persisted file ---------- */

/** The persisted file is untrusted input: keep only well-formed, fresh entries, newest last. */
export function sanitizeUnseen(raw: unknown, now: number): Unseen[] {
  const list = Array.isArray(raw) ? raw : []
  const out: Unseen[] = []
  for (const r of list.slice(-ITEM_MAX * 4)) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const key = typeof o['key'] === 'string' ? o['key'].slice(0, 2100) : ''
    const kind =
      o['kind'] === 'roundtable' ? 'roundtable' : o['kind'] === 'session' ? 'session' : o['kind'] === 'pr' ? 'pr' : null
    const at = typeof o['at'] === 'number' && Number.isFinite(o['at']) ? o['at'] : NaN
    if (!key || !kind || !(at > now - ITEM_TTL_MS)) continue
    // older files carried landings only
    const reason = REASONS.find((x) => x === o['reason']) ?? 'landed'
    if (kind === 'pr' && reason !== 'checks' && reason !== 'review') continue
    if (kind !== 'pr' && (reason === 'checks' || reason === 'review')) continue
    if (kind === 'roundtable' && reason !== 'landed' && reason !== 'failed') continue
    if ((reason === 'question' || reason === 'permission') && !(at > now - WAIT_TTL_MS)) continue
    const provider = PROVIDERS.find((p) => p === o['provider'])
    const pr = kind === 'pr' ? sanitizePr(o['pr']) : null
    if (kind === 'pr' && (!pr || typeof o['repoRoot'] !== 'string')) continue
    out.push({
      key,
      kind,
      reason,
      id: typeof o['id'] === 'string' ? o['id'].slice(0, 512) : null,
      ...(provider ? { provider } : {}),
      ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'].slice(0, 4096) } : {}),
      startedAt: typeof o['startedAt'] === 'number' ? o['startedAt'] : at,
      at,
      detail: typeof o['detail'] === 'string' ? o['detail'].slice(0, SNIPPET_MAX * 2) : '',
      ...(typeof o['title'] === 'string' ? { title: o['title'].slice(0, 512) } : {}),
      ...(typeof o['signature'] === 'string' ? { signature: o['signature'].slice(0, 512) } : {}),
      ...(pr ? { pr, repoRoot: (o['repoRoot'] as string).slice(0, 4096) } : {}),
      ...(typeof o['sessionId'] === 'string' ? { sessionId: o['sessionId'].slice(0, 512) } : {})
    })
  }
  return out.sort((a, b) => a.at - b.at).slice(-ITEM_MAX)
}

/** key → signature pairs from the file, bounded; anything malformed is forgotten. */
export function sanitizeMemory(raw: unknown): Array<[string, string]> {
  const list = Array.isArray(raw) ? raw : []
  const out: Array<[string, string]> = []
  for (const r of list.slice(-MEMORY_MAX)) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string') continue
    out.push([r[0].slice(0, 2100), r[1].slice(0, 512)])
  }
  return out
}

export type AttentionTrackerInit = {
  readonly now?: () => number
  readonly burstMs?: number
  /** What was still unseen when the app last saved */
  readonly unseen?: readonly Unseen[]
  /** Conditions the user had looked at */
  readonly seen?: ReadonlyArray<[string, string]>
  /** Conditions already announced */
  readonly noticed?: ReadonlyArray<[string, string]>
}

/** How a session waits, as last read from its log — kept so leaving it can raise it. */
type Wait = {
  readonly provider: Provider
  readonly wait: TailWait
  readonly written: number
}

export class AttentionTracker {
  private readonly now: () => number
  private readonly burstMs: number
  private readonly flights = new Map<string, Flight>()
  /** Insertion order is age: re-raising deletes and re-inserts */
  private readonly unseen = new Map<string, Unseen>()
  /** key → the condition the user looked at: it never raises again */
  private readonly seen = new Map<string, string>()
  /** key → the condition last announced: a silent re-add is not news */
  private readonly noticed = new Map<string, string>()
  /** Sessions whose logs say they wait on the user, watched or not */
  private readonly waits = new Map<string, Wait>()
  /** The closing words or failure of the newest turn, per observed session */
  private readonly endings = new Map<string, Pick<TailAttention, 'failed' | 'closing'>>()
  /** Spawned turns that landed lately: their logs' own endings are the same news */
  private readonly spawnedEnds = new Map<string, number>()
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
    for (const [k, s] of init.seen ?? []) this.seen.set(k, s)
    for (const [k, s] of init.noticed ?? []) this.noticed.set(k, s)
    this.trim()
  }

  /* ---------- what the user is looking at ---------- */

  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused
    // coming back to a session that landed while the window was in the background
    if (focused) this.see(this.focus)
    else this.raiseLeft()
  }

  /** Opening something is looking at it, focused window or not — that clears its item. */
  setFocus(focus: AttentionFocus): void {
    this.focus = focus
    this.see(focus)
    this.raiseLeft()
  }

  /** The user looked at an item some way other than opening its session — a PR row's link. */
  markSeen(key: string): void {
    const u = this.unseen.get(key)
    if (!u) return
    if (u.signature) this.remember(this.seen, key, u.signature)
    this.drop(key)
  }

  /* ---------- turns Cockpit spawned ---------- */

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

  /** Session ids with a spawned turn in flight — their logs are never read for asks. */
  spawnedIds(): Set<string> {
    const ids = new Set<string>()
    for (const f of this.flights.values()) for (const id of f.ids) ids.add(id)
    return ids
  }

  turnDone(turnId: string): void {
    const f = this.flights.get(turnId)
    if (!f) return
    this.flights.delete(turnId)
    const at = this.now()
    const key = f.latest ?? `turn:${f.turnId}`
    this.spawnedEnds.set(key, at)
    for (const [k, t] of this.spawnedEnds) if (at - t > SPAWNED_END_MS) this.spawnedEnds.delete(k)
    if (f.cancelled || this.watching(f)) return
    // a resumed claude turn forks a fresh id: an older landing under the id it
    // resumed is the same conversation, and must not count twice. Landing again is
    // not opening, so its banner moves with it rather than being withdrawn.
    for (const id of f.ids) this.rekey(id, key)
    const failed = f.error !== null
    this.raise(
      {
        key,
        kind: 'session',
        reason: failed ? 'failed' : 'landed',
        id: f.latest,
        provider: f.provider,
        cwd: f.cwd,
        startedAt: f.startedAt,
        at,
        detail: failed ? failureSnippet(f.error ?? '') : outcomeSnippet(f.text),
        title: clip(outcomeSnippet(f.prompt, TITLE_MAX) || 'New session', TITLE_MAX)
      },
      {
        headline: `${AGENT[f.provider]} ${failed ? 'failed' : 'finished'}${afterLabel(at - f.startedAt)}`,
        summary: `${AGENT[f.provider]} ${failed ? 'failed' : 'finished'}`,
        sound: failed ? 'fail' : 'finish',
        tally: failed ? 'failed' : 'finished'
      }
    )
  }

  /* ---------- turns observed in their logs ---------- */

  /**
   * A session's log was written: what its tail says. An ask raises the session
   * (unless the user is looking at it, or already looked at this very ask); a tail
   * that has moved on resolves one. Endings are kept for `observedEnd`, which the
   * liveness tracker reports once the log says the turn is over.
   */
  observed(id: string, provider: Provider, tail: TailAttention, written = this.now()): void {
    this.endings.set(id, { failed: tail.failed, closing: tail.closing })
    const open = this.unseen.get(id)
    if (!tail.waiting) {
      this.waits.delete(id)
      if (open && (open.reason === 'question' || open.reason === 'permission')) {
        // the ask was answered (or withdrawn): it needs nobody now
        this.drop(id)
      } else if (open && !tail.ended) {
        // a landing the user drove past in the terminal — a new turn is under way
        this.drop(id)
      }
      return
    }
    this.waits.set(id, { provider, wait: tail.waiting, written })
    this.raiseWait(id)
  }

  /** The liveness tracker saw the log end the turn: an ending nobody watched lands. */
  observedEnd(end: ObservedEnd): void {
    const at = this.now()
    const spawned = this.spawnedEnds.get(end.id)
    if (spawned !== undefined && at - spawned <= SPAWNED_END_MS) return
    if (this.flights.size > 0 && this.spawnedIds().has(end.id)) return
    if (this.watchingId(end.id)) return
    const ending = this.endings.get(end.id) ?? { failed: null, closing: '' }
    const failed = ending.failed !== null
    const signature = failed ? ending.failed?.signature : undefined
    if (signature && (this.seen.get(end.id) === signature || this.unseen.get(end.id)?.signature === signature)) return
    this.waits.delete(end.id)
    this.raise(
      {
        key: end.id,
        kind: 'session',
        reason: failed ? 'failed' : 'landed',
        id: end.id,
        provider: end.provider,
        startedAt: end.startedAt,
        at,
        detail: failed ? (ending.failed?.detail ?? '') : outcomeSnippet(ending.closing),
        ...(signature ? { signature } : {})
      },
      {
        headline: `${AGENT[end.provider]} ${failed ? 'failed' : 'finished'}${afterLabel(at - end.startedAt)}`,
        summary: `${AGENT[end.provider]} ${failed ? 'failed' : 'finished'}`,
        sound: failed ? 'fail' : 'finish',
        tally: failed ? 'failed' : 'finished'
      }
    )
  }

  /* ---------- roundtables ---------- */

  tableEnded(end: TableEnd): void {
    const f = this.focus
    if (this.windowFocused && f.kind === 'roundtable' && f.id === end.id) return
    const key = `table:${end.id}`
    const at = this.now()
    const failed = end.outcome.kind === 'failed'
    this.raise(
      {
        key,
        kind: 'roundtable',
        reason: failed ? 'failed' : 'landed',
        id: end.id,
        startedAt: at,
        at,
        detail: end.outcome.detail,
        title: clip(end.title, TITLE_MAX)
      },
      {
        headline: `Roundtable ${TABLE_VERB[end.outcome.kind]}`,
        sound: failed ? 'fail' : 'finish',
        tally: failed ? 'failed' : 'finished'
      }
    )
  }

  /* ---------- pull requests ---------- */

  /**
   * The sweep's reading of every open PR on the user's branches. A PR gone red is
   * raised (once per condition, and not while its session is on screen); one that
   * recovered, merged, or left the list is resolved — the user need do nothing.
   */
  setPrs(signals: readonly PrSignal[]): void {
    const at = this.now()
    const red = new Map<string, { signal: PrSignal; reason: 'checks' | 'review' }>()
    for (const signal of signals) {
      const reason = prReason(signal.pr)
      if (reason) red.set(`pr:${signal.pr.url}`, { signal, reason })
    }
    for (const u of [...this.unseen.values()]) {
      if (u.kind === 'pr' && !red.has(u.key)) this.drop(u.key)
    }
    // a PR that recovered starts over: going red again later is news, looked at or not
    for (const memory of [this.seen, this.noticed]) {
      for (const key of [...memory.keys()]) {
        if (key.startsWith('pr:') && !red.has(key)) memory.delete(key)
      }
    }
    for (const [key, { signal, reason }] of red) {
      const signature = prSignature(signal.pr, reason)
      const open = this.unseen.get(key)
      if (open?.signature === signature) continue
      if (this.seen.get(key) === signature) continue
      const sessionId = signal.session?.id ?? null
      if (sessionId && this.watchingId(sessionId)) continue
      const provider = signal.session?.provider
      this.raise(
        {
          key,
          kind: 'pr',
          reason,
          id: null,
          ...(provider ? { provider } : {}),
          startedAt: at,
          at,
          detail: `${basename(signal.repoRoot)} · ${signal.pr.headRefName}`,
          title: clip(signal.pr.title, TITLE_MAX),
          signature,
          pr: signal.pr,
          repoRoot: signal.repoRoot,
          sessionId
        },
        {
          headline:
            reason === 'checks'
              ? `Checks failing on #${signal.pr.number}`
              : `Changes requested on #${signal.pr.number}`,
          sound: reason === 'checks' ? 'fail' : 'ask',
          tally: 'pr'
        }
      )
    }
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
    const sound: Sound | null = prefs.sound
      ? live.some((p) => p.sound === 'fail')
        ? 'fail'
        : live.some((p) => p.sound === 'ask')
          ? 'ask'
          : 'finish'
      : null
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
        title: p.headline,
        subtitle: clip(nameOf(p), TITLE_MAX),
        body: p.detail,
        failed,
        target: this.targetOf(p.key),
        keys: [p.key]
      }
    } else {
      const tally = { finished: 0, failed: 0, waiting: 0, pr: 0 }
      for (const p of live) tally[p.tally] += 1
      const endingsOnly = tally.waiting === 0 && tally.pr === 0
      const title = !endingsOnly
        ? `${live.length} need you`
        : tally.failed === 0
          ? `${tally.finished} sessions finished`
          : tally.finished === 0
            ? `${tally.failed} sessions failed`
            : `${tally.finished} finished · ${tally.failed} failed`
      const lines = live.slice(0, SUMMARY_LINES).map((p) => `${p.summary} · ${clip(nameOf(p), TITLE_MAX)}`)
      if (live.length > SUMMARY_LINES) lines.push(`+${live.length - SUMMARY_LINES} more`)
      notice = {
        id: `cockpit:burst:${this.now()}`,
        title,
        subtitle: '',
        body: lines.join('\n'),
        failed,
        // several things at once: the board is where they all are
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

  /** Banner ids whose items have all been looked at since — take them out of Notification Center. */
  takeWithdrawn(): string[] {
    const ids = this.withdrawn
    this.withdrawn = []
    return ids
  }

  /**
   * The list as the renderer shows it, newest first. `sessionFor` is the index: a
   * session's row names the item; one the index doesn't know yet (a brand-new spawn,
   * a copilot landing not yet resolved) waits its turn rather than showing blank.
   */
  items(sessionFor: (id: string) => SessionMeta | null): AttentionItem[] {
    const out: AttentionItem[] = []
    for (const u of [...this.unseen.values()].sort((a, b) => b.at - a.at)) {
      if (u.kind === 'session') {
        if (u.id === null || !isSessionReason(u.reason)) continue
        const s = sessionFor(u.id)
        const provider = s?.provider ?? u.provider ?? providerOf(u.id)
        if (!provider) continue
        out.push({
          kind: 'session',
          key: u.key,
          id: u.id,
          provider,
          reason: u.reason,
          title: s?.title ?? u.title ?? 'New session',
          branch: s?.gitBranch ?? null,
          repo: s?.repo?.name ?? null,
          detail: u.detail,
          at: u.at
        })
      } else if (u.kind === 'roundtable') {
        if (u.id === null || (u.reason !== 'landed' && u.reason !== 'failed')) continue
        out.push({
          kind: 'roundtable',
          key: u.key,
          id: u.id,
          title: u.title ?? 'Roundtable',
          reason: u.reason,
          detail: u.detail,
          at: u.at
        })
      } else if (u.pr && u.repoRoot && (u.reason === 'checks' || u.reason === 'review')) {
        out.push({
          kind: 'pr',
          key: u.key,
          pr: u.pr,
          repoRoot: u.repoRoot,
          repo: basename(u.repoRoot),
          sessionId: u.sessionId ?? null,
          provider: u.provider ?? null,
          reason: u.reason,
          at: u.at
        })
      }
    }
    return out
  }

  /** What the Dock badge shows: everything open, tables and not-yet-named sessions included. */
  badgeCount(prefs: AttentionPrefs): number {
    return prefs.badge ? this.unseen.size : 0
  }

  /** The state worth keeping across a restart, oldest first. */
  entries(): Unseen[] {
    return [...this.unseen.values()]
  }

  /** Conditions the user looked at, oldest first. */
  seenEntries(): Array<[string, string]> {
    return [...this.seen]
  }

  /** Conditions already announced, oldest first. */
  noticedEntries(): Array<[string, string]> {
    return [...this.noticed]
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

  /** Is this session on screen in a focused window? Then what it asks is in front of the user. */
  private watchingId(id: string): boolean {
    const v = this.focus
    return this.windowFocused && v.kind === 'session' && v.id === id
  }

  /** A session's ask, raised unless the user is looking at it or has looked at this very ask. */
  private raiseWait(id: string): void {
    const w = this.waits.get(id)
    if (!w || this.watchingId(id)) return
    const { wait } = w
    if (this.seen.get(id) === wait.signature) return
    const open = this.unseen.get(id)
    if (open?.signature === wait.signature) return
    const verb = wait.reason === 'question' ? 'is asking' : 'needs approval'
    this.raise(
      {
        key: id,
        kind: 'session',
        reason: wait.reason,
        id,
        provider: w.provider,
        startedAt: w.written,
        at: this.now(),
        detail: wait.detail,
        signature: wait.signature
      },
      { headline: `${AGENT[w.provider]} ${verb}`, sound: 'ask', tally: 'waiting' }
    )
  }

  /** Asks the user was looking at when they came in are news once they leave. */
  private raiseLeft(): void {
    for (const id of this.waits.keys()) this.raiseWait(id)
  }

  /**
   * Put an item on the list and, unless this very condition was announced already,
   * in the next burst. Re-raising the same key replaces its entry — later news wins.
   */
  private raise(u: Unseen, news: Pick<Pending, 'headline' | 'sound' | 'tally'> & { summary?: string }): void {
    this.unseen.delete(u.key)
    this.unseen.set(u.key, u)
    if (u.signature && this.noticed.get(u.key) === u.signature) {
      this.trim()
      return
    }
    if (u.signature) this.remember(this.noticed, u.key, u.signature)
    this.enqueue({
      key: u.key,
      headline: news.headline,
      summary: news.summary ?? news.headline,
      detail: u.detail,
      title: u.kind === 'session' ? null : (u.title ?? null),
      fallbackTitle: u.title ?? (u.kind === 'roundtable' ? 'Roundtable' : 'New session'),
      failed: u.reason === 'failed' || u.reason === 'checks',
      sound: news.sound,
      tally: news.tally
    })
    this.trim()
  }

  private see(focus: AttentionFocus): void {
    if (focus.kind === 'none') return
    for (const u of [...this.unseen.values()]) {
      const seen =
        focus.kind === 'roundtable'
          ? u.kind === 'roundtable' && u.id === focus.id
          : u.kind === 'pr'
            ? u.sessionId !== undefined && u.sessionId !== null && u.sessionId === focus.id
            : u.kind === 'session' &&
              (u.id !== null
                ? u.id === focus.id
                : u.provider === focus.provider && samePath(u.cwd, focus.cwd))
      if (!seen) continue
      if (u.signature) this.remember(this.seen, u.key, u.signature)
      this.drop(u.key)
    }
  }

  /** A key names its own target — opened or not — except a `turn:` nobody has resolved yet. */
  private targetOf(key: string): AttentionTarget {
    let k = key
    for (let hops = 0; hops < 4 && this.aliases.has(k); hops++) k = this.aliases.get(k) as string
    if (k.startsWith('turn:')) return { kind: 'home' }
    if (k.startsWith('table:')) return { kind: 'roundtable', id: k.slice('table:'.length) }
    if (k.startsWith('pr:')) {
      const u = this.unseen.get(k)
      if (u?.sessionId) return { kind: 'session', id: u.sessionId }
      return u?.pr ? { kind: 'url', url: u.pr.url } : { kind: 'home' }
    }
    return { kind: 'session', id: k }
  }

  private enqueue(p: Pending): void {
    // the same item raised twice inside one burst speaks once, with its latest news
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

  /** Looked at, resolved or expired: gone from the badge, and banners with nothing left to say are withdrawn. */
  private drop(key: string): void {
    if (!this.unseen.delete(key)) return
    for (const [id, keys] of this.delivered) {
      if (keys.delete(key) && keys.size === 0) {
        this.delivered.delete(id)
        this.withdrawn.push(id)
      }
    }
  }

  private remember(memory: Map<string, string>, key: string, signature: string): void {
    memory.delete(key)
    memory.set(key, signature)
    while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string)
  }

  private trim(): void {
    const now = this.now()
    for (const u of [...this.unseen.values()]) {
      const ttl = u.reason === 'question' || u.reason === 'permission' ? WAIT_TTL_MS : ITEM_TTL_MS
      if (u.at <= now - ttl) this.drop(u.key)
    }
    while (this.unseen.size > ITEM_MAX) {
      this.drop(this.unseen.keys().next().value as string)
    }
    for (const [id, w] of this.waits) if (w.written <= now - WAIT_TTL_MS) this.waits.delete(id)
  }
}

const afterLabel = (ms: number): string => {
  const label = elapsedLabel(ms)
  return label ? ` after ${label}` : ''
}

const isSessionReason = (r: AttentionReason): r is 'landed' | 'failed' | 'question' | 'permission' =>
  r === 'landed' || r === 'failed' || r === 'question' || r === 'permission'
