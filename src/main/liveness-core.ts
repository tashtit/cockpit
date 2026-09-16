import type { BusySession, Provider } from '../shared/types'
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
 */
export type TurnVerdict = {
  readonly live: boolean
  /**
   * Epoch ms the running turn opened, when the record that opened it is inside the
   * tail; null when it scrolled out (a long turn). The tracker then keeps what it
   * already knew, or falls back to the file's last write — a lower bound.
   */
  readonly startedAt: number | null
}

export const IDLE: TurnVerdict = { live: false, startedAt: null }

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
      if (r.subtype === 'stop_hook_summary') return IDLE
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
      if (!toolPending && !thinkingOnly) return IDLE
      return { live: true, startedAt: claudeTurnStart(records, i) }
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

/* ---------- codex ---------- */

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
      return { live: true, startedAt: toMs(p.started_at) ?? toMs(r.timestamp) }
    }
    if (p?.type === 'task_complete' || p?.type === 'turn_aborted') return IDLE
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
        if (p.role === 'assistant') return p.phase === 'commentary' ? { live: true, startedAt: null } : IDLE
        continue // developer/system instructions ride along with a prompt
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'web_search_call':
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

/**
 * Copilot CLI brackets each model round-trip with `assistant.turn_start` /
 * `assistant.turn_end` (a prompt runs several, back to back), closes a session with
 * `session.shutdown`, and writes `user.message` the instant a prompt is sent. Tool
 * and hook events, assistant messages and compaction all sit inside a bracket.
 */
export function judgeCopilotTail(records: readonly any[]): TurnVerdict | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    switch (r?.type) {
      case 'assistant.turn_start':
        return { live: true, startedAt: copilotTurnStart(records, i) ?? toMs(r.timestamp) }
      case 'user.message':
        return { live: true, startedAt: toMs(r.timestamp) }
      case 'assistant.turn_end':
      case 'session.shutdown':
      case 'session.start':
      case 'session.resume':
        return IDLE
      default:
        continue
    }
  }
  return null
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
