import type { AcpPermissionOption, ChatEvent } from '../shared/types'
import { parseAsks } from '../shared/asks'
import { asRecord } from '../shared/guards'
import { clip } from '../shared/text'
import { permissionDetail } from './acp-core'
import { capText, jsonText, toolPreview, truncate } from './parsers/util'

/**
 * Claude's permission prompts, answered by the person in Cockpit's chat.
 *
 * Headless `claude -p` has nobody to ask, so every call its permission mode does not
 * already allow was refused with "This command requires approval" — in auto-edit that is
 * every command, `npm test` and `git commit` included. Started with
 * `--permission-prompt-tool stdio`, the CLI instead puts each such call to its host as a
 * `can_use_tool` control request on stdout and waits for the answer on stdin, which is
 * why the prompt then travels on stdin too, as a stream-json user message. Cockpit shows
 * the request on the card an ACP agent's request gets, with what the request says of
 * itself: the command whole or the tool's input, why the CLI asks (`decision_reason`), the
 * path that made it ask (`blocked_path`), and a command asking to run outside the sandbox.
 *
 * IO-free: chat.ts owns the process and its pipes; this is what the unit tests drive.
 */

/** The flags that make Cockpit the one Claude asks; the prompt goes on stdin (`userMessageLine`). */
export const CLAUDE_HOST_ARGS: readonly string[] = [
  '--input-format',
  'stream-json',
  '--permission-prompt-tool',
  'stdio'
]

export const CLAUDE_ALLOW = 'allow'
export const CLAUDE_DENY = 'deny'

/**
 * Once or not at all. Claude also offers to write an allow rule into the checkout's
 * `.claude/settings.local.json`; that outlives the turn inside the person's own config,
 * which is theirs to write, not a card's.
 */
const OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: CLAUDE_ALLOW, name: 'Allow', kind: 'allow_once' },
  { optionId: CLAUDE_DENY, name: 'Deny', kind: 'reject_once' }
]

/** What the model reads when the person says no. */
const DECLINED = 'The person declined this in Cockpit.'

/**
 * What the model reads for a question it put to the person. The chat already offers the
 * question's options as picks, and a pick is the person's next message (asks.ts) — held
 * open here, the turn would still be running when that message was sent, and a session
 * runs one turn at a time.
 */
const ASKED =
  'Cockpit shows this to the person in the chat, and their answer arrives as their next message. End your turn here and wait for it.'

/**
 * How much of a tool's input the card shows before it says how much is left. Enough for a
 * file edit's change or an MCP call's arguments, and the card scrolls past a few lines.
 */
const INPUT_MAX = 4_000

/** Why it asks, and the path it names: kept whole up to this, and never past it */
const NOTE_MAX = 500

/** Request ids come from the CLI's own stdout; anything past this is not one of its UUIDs. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/** The prompt as the one stream-json user message a turn starts from. */
export function userMessageLine(prompt: string): string {
  const message = { role: 'user', content: prompt }
  return `${JSON.stringify({ type: 'user', message, parent_tool_use_id: null, session_id: '' })}\n`
}

/** What one line of Claude's stdout asks of its host. */
export type ClaudeControl =
  /** A call waiting on the person: show `event`; an allow sends `input` back unchanged */
  | {
      readonly kind: 'ask'
      readonly requestId: string
      readonly event: Extract<ChatEvent, { type: 'permission' }>
      readonly input: unknown
    }
  /** Answered without the person: write `line` to stdin */
  | { readonly kind: 'reply'; readonly line: string }
  /** The CLI gave up on a request (the call was aborted) — its card has nothing left to
   *  answer, and `event` takes it down */
  | {
      readonly kind: 'withdrawn'
      readonly requestId: string
      readonly event: Extract<ChatEvent, { type: 'permission-withdrawn' }>
    }

/**
 * The control message a stdout line carries, or null for an ordinary stream event.
 * Unknown request kinds are refused rather than left unanswered — the CLI waits on each.
 */
export function claudeControl(turnId: string, line: unknown): ClaudeControl | null {
  const msg = asRecord(line)
  if (msg?.['type'] === 'control_cancel_request') {
    const requestId = msg['request_id']
    return typeof requestId === 'string' && REQUEST_ID.test(requestId)
      ? { kind: 'withdrawn', requestId, event: { turnId, type: 'permission-withdrawn', requestId } }
      : null
  }
  if (msg?.['type'] !== 'control_request') return null
  const requestId = msg['request_id']
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return null
  const request = (msg['request'] ?? {}) as Record<string, unknown>
  if (request['subtype'] !== 'can_use_tool') {
    return { kind: 'reply', line: controlError(requestId, `Cockpit does not handle ${String(request['subtype'])}`) }
  }
  const toolName = typeof request['tool_name'] === 'string' ? request['tool_name'] : 'tool'
  const input = request['input'] ?? {}
  if (parseAsks(toolName, input)) return { kind: 'reply', line: deny(requestId, ASKED) }
  const shell = toolName === 'Bash'
  const description = typeof request['description'] === 'string' ? request['description'].trim() : ''
  const title = description || toolPreview(toolName, input) || toolName
  const reason = note(request['decision_reason'])
  const blockedPath = note(request['blocked_path'])
  return {
    kind: 'ask',
    requestId,
    input,
    event: {
      turnId,
      type: 'permission',
      requestId,
      // named the way the card knows a command by, so it shows the command whole
      toolName: shell ? 'shell' : toolName,
      // anything else shows its input on the card: an MCP tool's name alone says nothing
      // of what it would do, and a hover tooltip is out of reach from the keyboard
      detail: shell ? permissionDetail('execute', input, title) : inputDetail(input),
      preview: truncate(title, 200),
      options: OPTIONS,
      ...(reason ? { reason } : {}),
      ...(blockedPath ? { blockedPath } : {}),
      // a command that would run outside the sandbox must not look like any other
      ...(shell && asRecord(input)?.['dangerouslyDisableSandbox'] === true ? { sandboxBypass: true as const } : {})
    }
  }
}

/** A tool's input as the card shows it: indented JSON, bounded with a note of what is left. */
function inputDetail(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input, null, 2) ?? ''
  } catch {
    // nested past what can be serialised: jsonText says so in words
    text = jsonText(input)
  }
  return capText(text, INPUT_MAX)
}

/** One of the request's own words about itself, bounded; undefined when it says nothing. */
function note(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? clip(value.trim(), NOTE_MAX) : undefined
}

/** The stdin line answering one request with one of the card's options; null for an option it never offered. */
export function claudeAnswer(requestId: string, optionId: string, input: unknown): string | null {
  if (optionId === CLAUDE_ALLOW) {
    return response({ subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } })
  }
  return optionId === CLAUDE_DENY ? deny(requestId, DECLINED) : null
}

function deny(requestId: string, message: string): string {
  return response({ subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } })
}

function controlError(requestId: string, error: string): string {
  return response({ subtype: 'error', request_id: requestId, error })
}

function response(body: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'control_response', response: body })}\n`
}
