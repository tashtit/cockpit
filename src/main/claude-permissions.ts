import type { AcpPermissionOption, ChatEvent } from '../shared/types'
import { parseAsks } from '../shared/asks'
import { asRecord } from '../shared/guards'
import { permissionDetail } from './acp-core'
import { toolPreview, truncate } from './parsers/util'

/**
 * Claude's permission prompts, answered by the person in Cockpit's chat.
 *
 * Headless `claude -p` has nobody to ask, so every call its permission mode does not
 * already allow was refused with "This command requires approval" — in auto-edit that is
 * every command, `npm test` and `git commit` included. Started with
 * `--permission-prompt-tool stdio`, the CLI instead puts each such call to its host as a
 * `can_use_tool` control request on stdout and waits for the answer on stdin, which is
 * why the prompt then travels on stdin too, as a stream-json user message. Cockpit shows
 * the request on the card an ACP agent's request gets.
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
  /** The CLI gave up on a request (the call was aborted) — its card has nothing left to answer */
  | { readonly kind: 'withdrawn'; readonly requestId: string }

/**
 * The control message a stdout line carries, or null for an ordinary stream event.
 * Unknown request kinds are refused rather than left unanswered — the CLI waits on each.
 */
export function claudeControl(turnId: string, line: unknown): ClaudeControl | null {
  const msg = asRecord(line)
  if (msg?.['type'] === 'control_cancel_request') {
    const requestId = msg['request_id']
    return typeof requestId === 'string' && REQUEST_ID.test(requestId) ? { kind: 'withdrawn', requestId } : null
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
      detail: permissionDetail(shell ? 'execute' : undefined, input, title),
      preview: truncate(title, 200),
      options: OPTIONS
    }
  }
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
