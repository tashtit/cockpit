import type { AttentionAsk, BusySession, Provider } from '../shared/types'
import { contentToText, toMs } from './parsers/util'

/**
 * Is an agent mid-turn in a session, judged from the tail of the session's own log?
 *
 * The IO-free half of liveness.ts: the tracker there reads a bounded tail and applies
 * the freshness window; this decides what the records say. Every provider brackets a
 * turn with records of its own, so the newest *decisive* record tells the state and
 * everything else (titles, attachments, token counts, hooks) is skipped over. A tail
 * with no decisive record at all is `null` — "nothing here", which the reader answers
 * by looking further back — as opposed to IDLE, which is a turn seen ending. Log
 * formats are provider-internal and drift between releases, so every rule errs
 * towards idle: an unrecognised shape never becomes a phantom running row.
 *
 * Two more things the same records say, for the attention desk: a live turn that has
 * stopped to *ask* — a question put to the user, a permission the CLI is waiting on —
 * and the *closing words* of a turn that ended, so a notification can quote them.
 * Both are read only off the newest record (or its immediate neighbours), never
 * searched for: a request the log has moved past is not a request any more.
 */
export type TurnVerdict = {
  readonly live: boolean
  /**
   * Epoch ms the running turn opened, when the record that opened it is inside the
   * tail; null when it scrolled out (a long turn). The tracker then keeps what it
   * already knew, or falls back to the file's last write — a lower bound.
   */
  readonly startedAt: number | null
  /** Live only: the agent is blocked on the user — a question, or a permission prompt */
  readonly asks?: AttentionAsk
  /**
   * Live only: the newest record is a tool call still waiting for its result. A tool
   * can run for minutes without a line written, so the tracker gives it a longer
   * silence window than a turn waiting on the model.
   */
  readonly inTool?: true
  /** Idle only: what the agent said as it ended, when the ending record carries it */
  readonly closing?: string
  /** Idle only: the turn ended on an error the CLI gave up on (an API error, a usage limit) */
  readonly failed?: true
}

export const IDLE: TurnVerdict = { live: false, startedAt: null }

/** The session an observed turn belongs to, as the index knows it. */
export type ObservedSession = {
  readonly id: string
  readonly provider: Provider
  readonly cwd: string | null
}

/**
 * What changed for one observed turn (the tracker in liveness.ts emits these, the
 * attention desk listens) — only ever from a decisive record, never from a timer.
 */
export type ObservedTurn = ObservedSession &
  (
    /** A turn is running (a new one, or the log moved past a question) */
    | { readonly type: 'running' }
    /** The agent stopped to ask the person something */
    | { readonly type: 'asks'; readonly asks: AttentionAsk; readonly startedAt: number }
    /** The log wrote the record that ends a turn seen running */
    | {
        readonly type: 'ended'
        readonly startedAt: number
        readonly endedAt: number
        /** The agent's closing words, when the ending record carried them */
        readonly closing: string | null
        /** It ended on an error rather than an answer */
        readonly failed?: true
      }
    /**
     * A fresh write judged idle with no turn seen running: whatever the log was waiting
     * on is over (a question answered or dismissed while the entry had expired). Never
     * an ending — a title or summary record lands after every turn.
     */
    | { readonly type: 'settled' }
  )

/** How much of a closing answer or a question is worth carrying (a notification quotes one line). */
const CLOSING_MAX = 600
const DETAIL_MAX = 160

/** null: no record in these speaks for the turn — read further back before deciding. */
export function judgeTail(provider: Provider, records: readonly any[]): TurnVerdict | null {
  switch (provider) {
    case 'claude':
      return judgeClaudeTail(records)
    case 'codex':
      return judgeCodexTail(records)
    case 'copilot':
      return judgeCopilotTail(records)
  }
}

/** One line of a possibly long, possibly non-string value; '' when there is nothing to say. */
function oneLine(v: unknown, max = DETAIL_MAX): string {
  if (typeof v !== 'string') return ''
  const line = v.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const flat = line.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** A closing answer, whitespace-trimmed and capped; undefined when empty (keeps verdicts tidy). */
function closingOf(text: string): string | undefined {
  const t = text.trim()
  return t ? t.slice(0, CLOSING_MAX) : undefined
}

/** A field that providers write either as an object or as its JSON text. */
function objectOf(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object') return v as Record<string, unknown>
  if (typeof v !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(v)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/* ---------- claude ---------- */

/** Content blocks of a Claude message record; [] for string content or no message. */
function claudeBlocks(r: any): any[] {
  const c = r?.message?.content
  return Array.isArray(c) ? c : []
}

/**
 * User records that ask the model for nothing: the interrupt marker Esc leaves behind,
 * and local slash-command echoes (`/cost`, `/clear` …) that never start a turn.
 */
const CLAUDE_NON_PROMPT = /^\s*(\[Request interrupted|<command-name>|<local-command-stdout>|<local-command-caveat>)/

/**
 * Tool calls Claude Code never answers on its own: the CLI stops and waits for the
 * person. A permission prompt for an ordinary tool leaves no record while it waits —
 * the log looks exactly like a long-running tool — so only these two can be told.
 * Confirmed against real logs (2026-09): `AskUserQuestion` carries `questions[]`,
 * `ExitPlanMode` waits for the plan to be approved.
 */
const CLAUDE_ASKS: Readonly<Record<string, AttentionAsk['kind']>> = {
  AskUserQuestion: 'question',
  ExitPlanMode: 'permission'
}

/** What a Claude tool_use block is waiting on the user for, if it is one of those. */
function claudeAsk(block: any): AttentionAsk | undefined {
  const kind = typeof block?.name === 'string' ? CLAUDE_ASKS[block.name] : undefined
  if (!kind) return undefined
  if (block.name === 'ExitPlanMode') return { kind, detail: 'Approve the plan' }
  const questions = block?.input?.questions
  const first = Array.isArray(questions) ? questions[0] : null
  return { kind, detail: oneLine(first?.question) || oneLine(first?.header) }
}

function isClaudeToolResult(r: any): boolean {
  return r?.toolUseResult !== undefined || claudeBlocks(r).some((b) => b?.type === 'tool_result')
}

/** A human prompt, as opposed to a tool result or a local command echo. */
function isClaudePrompt(r: any): boolean {
  if (r?.type !== 'user' || isClaudeToolResult(r)) return false
  return !CLAUDE_NON_PROMPT.test(contentToText(r.message?.content))
}

/** When the turn that record `end` belongs to opened: its prompt's timestamp, if in the tail. */
function claudeTurnStart(records: readonly any[], end: number): number | null {
  for (let i = end; i >= 0; i--) {
    if (isClaudePrompt(records[i])) return toMs(records[i].timestamp)
  }
  return null
}

/** The nearest text-only assistant answer at or before `end` (a Stop hook summary follows one). */
function claudeClosing(records: readonly any[], end: number): string | undefined {
  for (let i = end; i >= 0 && i > end - 8; i--) {
    const r = records[i]
    if (r?.type !== 'assistant' || r?.isSidechain === true) continue
    const blocks = claudeBlocks(r)
    if (blocks.some((b) => b?.type === 'tool_use')) return undefined
    const text = contentToText(blocks)
    if (text.trim()) return closingOf(text)
  }
  return undefined
}

/**
 * Claude Code appends one record per message (a tool_use and the text before it are
 * separate lines), so the newest message record says where the turn stands:
 * a prompt or a tool result waits on the model, a tool_use waits on the tool, and
 * a text-only answer is the end — confirmed by the Stop hook's summary record when
 * hooks are configured. `stop_reason` alone can't decide: the desktop app's harness
 * writes `end_turn` on tool_use records too, so the content blocks are the truth.
 */
export function judgeClaudeTail(records: readonly any[]): TurnVerdict | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    // older CLIs inlined subagent transcripts into the parent log — those lines speak
    // for the subagent's turn, never the parent's
    if (r?.isSidechain === true) continue
    if (r?.type === 'system') {
      if (r.subtype === 'stop_hook_summary') return idle(claudeClosing(records, i - 1))
      // an API error the CLI is retrying is a turn still running
      if (r.subtype === 'api_error') return { live: true, startedAt: claudeTurnStart(records, i) }
      continue
    }
    if (r?.type === 'assistant' && r.message) {
      const blocks = claudeBlocks(r)
      const toolPending =
        r.message?.stop_reason === 'tool_use' || blocks.some((b) => b?.type === 'tool_use')
      // streamed thinking with nothing said yet: the answer is still coming
      const thinkingOnly =
        blocks.length > 0 &&
        blocks.every((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking')
      if (!toolPending && !thinkingOnly) {
        const ended = idle(closingOf(contentToText(blocks)))
        // the CLI's own record of an API error or usage limit it stopped on
        return r.isApiErrorMessage === true ? { ...ended, failed: true } : ended
      }
      const startedAt = claudeTurnStart(records, i)
      // a tool_use that is a question to the person: the turn is live, but on them
      for (const b of blocks) {
        const asks = b?.type === 'tool_use' ? claudeAsk(b) : undefined
        if (asks) return { live: true, startedAt, asks }
      }
      // the tool_use line itself waits on its tool; a text line whose stop_reason says
      // tool_use is only the words before that line
      if (blocks.some((b) => b?.type === 'tool_use')) return { live: true, startedAt, inTool: true }
      return { live: true, startedAt }
    }
    if (r?.type === 'user') {
      if (isClaudePrompt(r)) return { live: true, startedAt: toMs(r.timestamp) }
      if (isClaudeToolResult(r)) return { live: true, startedAt: claudeTurnStart(records, i) }
      return IDLE
    }
    // attachment, last-prompt, summary, custom-title, queue-operation, … say nothing
  }
  return null
}

/** IDLE, with the closing words when there are any (an exact IDLE otherwise, for callers comparing). */
function idle(closing: string | undefined): TurnVerdict {
  return closing ? { live: false, startedAt: null, closing } : IDLE
}

/* ---------- codex ---------- */

/**
 * A live Codex turn waiting on the person, read newest-first: the request must be the
 * newest item — anything the rollout wrote after it (its output, the tool it gated,
 * a message) means the turn moved on. `request_user_input` is the collaboration
 * tool that blocks until answered (`request_user_input_async` is answered at once and
 * is not one); the two approval requests are codex-rs's own event names. None of the
 * three has shown up in a rollout on this machine yet, so the shapes come from the
 * protocol and are matched by exact name, never loosely.
 */
function codexAsks(records: readonly any[]): AttentionAsk | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    const p = r?.payload
    if (r?.type === 'event_msg') {
      if (p?.type === 'task_started' || p?.type === 'task_complete' || p?.type === 'turn_aborted') return undefined
      if (p?.type === 'exec_approval_request') return { kind: 'permission', detail: codexCommand(p.command) }
      if (p?.type === 'apply_patch_approval_request') return { kind: 'permission', detail: 'Apply a patch' }
      continue
    }
    if (r?.type === 'response_item') {
      if (p?.type === 'function_call' && p?.name === 'request_user_input') {
        return { kind: 'question', detail: codexQuestion(p.arguments) }
      }
      return undefined
    }
  }
  return undefined
}

/** Response items that wait on a tool, as opposed to its output or a message. */
const CODEX_CALLS: ReadonlySet<string> = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'])

/** Is the newest item of the running turn a tool call without its output? */
function codexInTool(records: readonly any[]): boolean {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    const t = r?.payload?.type
    if (r?.type === 'event_msg' && (t === 'task_started' || t === 'task_complete' || t === 'turn_aborted')) return false
    if (r?.type === 'response_item') return CODEX_CALLS.has(t)
  }
  return false
}

function codexCommand(command: unknown): string {
  if (Array.isArray(command)) return oneLine(command.filter((c) => typeof c === 'string').join(' '))
  return oneLine(command)
}

function codexQuestion(args: unknown): string {
  const a = objectOf(args)
  const q = Array.isArray(a?.questions) ? objectOf(a?.questions[0]) : null
  return oneLine(q?.title) || oneLine(q?.question) || oneLine(q?.prompt)
}

/**
 * codex-rs brackets every turn with event_msg records — `task_started`, then
 * `task_complete` or `turn_aborted` — so the newest of those decides, and its
 * `started_at` is the turn's start. Rollouts from before the envelope (bare
 * ResponseItems, no markers anywhere) fall through to the newest item: a prompt, a
 * tool call, its output or a commentary message means the turn is running; a final
 * answer or a compaction means it is not.
 */
export function judgeCodexTail(records: readonly any[]): TurnVerdict | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r?.type !== 'event_msg') continue
    const p = r.payload
    if (p?.type === 'task_started') {
      const startedAt = toMs(p.started_at) ?? toMs(r.timestamp)
      const asks = codexAsks(records)
      if (asks) return { live: true, startedAt, asks }
      return codexInTool(records) ? { live: true, startedAt, inTool: true } : { live: true, startedAt }
    }
    if (p?.type === 'task_complete') return idle(closingOf(oneLine(p.last_agent_message, CLOSING_MAX)))
    if (p?.type === 'turn_aborted') return IDLE
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!r || typeof r !== 'object') continue
    // a rollout that is only its header is waiting for its first prompt
    if (r.type === 'session_meta') return IDLE
    if (r.type !== 'response_item' && r.payload !== undefined) continue
    const p = r.payload ?? r
    switch (p?.type) {
      case 'message':
        if (p.role === 'user') return { live: true, startedAt: toMs(r.timestamp) }
        if (p.role === 'assistant') {
          return p.phase === 'commentary' ? { live: true, startedAt: null } : idle(closingOf(contentToText(p.content)))
        }
        continue // developer/system instructions ride along with a prompt
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'web_search_call':
        return { live: true, startedAt: null, inTool: true }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'reasoning':
        return { live: true, startedAt: null }
      case 'compaction':
        return IDLE
      default:
        continue
    }
  }
  return null
}

/* ---------- copilot ---------- */

/** When the turn the user sees opened: their message's timestamp, if in the tail. */
function copilotTurnStart(records: readonly any[], end: number): number | null {
  for (let i = end; i >= 0; i--) {
    if (records[i]?.type === 'user.message') return toMs(records[i].timestamp)
  }
  return null
}

/** The assistant message just before a turn_end, if the tail holds one. */
function copilotClosing(records: readonly any[], end: number): string | undefined {
  for (let i = end; i >= 0 && i > end - 8; i--) {
    const r = records[i]
    if (r?.type === 'assistant.message') return closingOf(typeof r.data?.content === 'string' ? r.data.content : '')
    if (r?.type === 'tool.execution_start' || r?.type === 'assistant.turn_start') return undefined
  }
  return undefined
}

/**
 * What a Copilot permission prompt is about, from `permission.requested`'s data —
 * the prompt request (a command, an MCP tool) is written as an object or its JSON.
 * Confirmed against real logs (2026-09): the shell kind carries `fullCommandText`,
 * the mcp kind `serverName` + `toolName`.
 */
function copilotAsk(data: unknown): AttentionAsk {
  const d = objectOf(data)
  const prompt = objectOf(d?.promptRequest) ?? objectOf(d?.permissionRequest)
  const tool = typeof prompt?.toolName === 'string' ? prompt.toolName : ''
  const server = typeof prompt?.serverName === 'string' ? prompt.serverName : ''
  const detail =
    oneLine(prompt?.fullCommandText) ||
    (tool ? oneLine(server ? `${server}: ${tool}` : tool) : '') ||
    oneLine(prompt?.kind)
  return { kind: 'permission', detail }
}

/**
 * Copilot CLI brackets each model round-trip with `assistant.turn_start` /
 * `assistant.turn_end` (a prompt runs several, back to back), closes a session with
 * `session.shutdown`, and writes `user.message` the instant a prompt is sent. Tool
 * and hook events, assistant messages and compaction all sit inside a bracket — and
 * so does a `permission.requested`, answered by a `permission.completed` with the
 * same `requestId` once the person decides (or the session is aborted).
 */
export function judgeCopilotTail(records: readonly any[]): TurnVerdict | null {
  const completed = new Set<string>()
  const toolsDone = new Set<string>()
  let asks: AttentionAsk | undefined
  let askedAt: number | null = null
  let inTool = false
  const live = (startedAt: number | null): TurnVerdict =>
    asks ? { live: true, startedAt, asks } : inTool ? { live: true, startedAt, inTool: true } : { live: true, startedAt }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    switch (r?.type) {
      case 'assistant.turn_start':
        return live(copilotTurnStart(records, i) ?? toMs(r.timestamp))
      case 'user.message':
        return live(toMs(r.timestamp))
      case 'tool.execution_complete': {
        const id = r.data?.toolCallId
        if (typeof id === 'string') toolsDone.add(id)
        continue
      }
      case 'tool.execution_start': {
        // a start with no completion newer than it: the tool is still running
        const id = r.data?.toolCallId
        if (!(typeof id === 'string' && toolsDone.has(id))) inTool = true
        continue
      }
      case 'assistant.turn_end':
        // a request newer than the bracket's end is still a request
        if (asks) return { live: true, startedAt: copilotTurnStart(records, i) ?? askedAt, asks }
        return idle(copilotClosing(records, i - 1))
      case 'session.shutdown':
      case 'session.start':
      case 'session.resume':
        return IDLE
      case 'permission.completed': {
        const id = r.data?.requestId
        if (typeof id === 'string') completed.add(id)
        continue
      }
      case 'permission.requested': {
        const id = r.data?.requestId
        if (asks === undefined && !(typeof id === 'string' && completed.has(id))) {
          asks = copilotAsk(r.data)
          askedAt = toMs(r.timestamp)
        }
        continue
      }
      default:
        continue
    }
  }
  return null
}

/* ---------- copilot's own lock ---------- */

/** `inuse.<pid>.lock`, as Copilot names it while a CLI process holds the session. */
const COPILOT_LOCK = /^inuse\.(\d{1,9})\.lock$/

/**
 * The pids Copilot claims are holding a session, read off the names in its
 * `session-state/<id>/` directory. Copilot writes one `inuse.<pid>.lock` per holding
 * process and, unlike the log, keeps it for as long as the CLI runs — so it answers
 * the one question the records cannot: whether anything is still there. It leaves
 * them behind on a crash too (most of the ones on disk are stale), which is why the
 * pid, not the file, is the evidence; the caller checks each one. Names it does not
 * recognise are skipped — `.workspace-fork.lock` is a different lock entirely.
 */
export function copilotLockPids(names: readonly string[]): number[] {
  const pids: number[] = []
  for (const name of names) {
    const pid = COPILOT_LOCK.exec(name)
    if (pid) pids.push(Number(pid[1]))
  }
  return pids
}

/* ---------- the busy set ---------- */

/**
 * One busy set from both sources. A session Cockpit spawned is also indexed, so its
 * log is observed too — the spawned entry wins: its start is exact and it ends the
 * moment the process does, while the observed one lags the log by a debounce.
 */
export function mergeBusy(
  spawned: readonly BusySession[],
  observed: readonly BusySession[]
): BusySession[] {
  const out = [...spawned]
  const seen = new Set(spawned.map((s) => s.id))
  for (const s of observed) {
    if (!seen.has(s.id)) out.push(s)
  }
  return out
}
