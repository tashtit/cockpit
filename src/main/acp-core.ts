import type { AcpPermissionOption, ChatEvent, PermissionMode } from '../shared/types'
import { ACP_PROTOCOL_VERSION } from '../shared/acp'
import { shellPreview, truncate } from './parsers/util'
import { acpDiffArtifact, acpPlanArtifact } from './parsers/artifacts'

/**
 * The IO-free half of the ACP client: everything that turns protocol JSON into Cockpit's
 * own vocabulary, and everything that decides what to answer. `acp.ts` owns the process
 * and the socket; this file is what the unit tests drive.
 */

/**
 * What Cockpit promises an agent at `initialize`.
 *
 * We claim no `fs` and no `terminal` capability. Both are real ACP features — the agent
 * asks the *client* to read a file or run a command — but implementing them means main
 * writing files and spawning shells on behalf of a process the user configured, which is
 * a bigger surface than this buys. Agents fall back to their own tools when the client
 * declines: verified against Copilot, which reached for a shell tool and never noticed.
 */
export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false
    }
  }
}

/** ACP tool-call kinds, mapped onto the tool names the rest of Cockpit already shows. */
const TOOL_NAMES: Record<string, string> = {
  execute: 'shell',
  edit: 'edit',
  read: 'read',
  delete: 'delete',
  move: 'move',
  search: 'search',
  fetch: 'fetch',
  think: 'think',
  switch_mode: 'mode'
}

function toolNameFor(kind: unknown): string {
  return (typeof kind === 'string' && TOOL_NAMES[kind]) || 'tool'
}

/**
 * The one-liner shown next to a tool call. A shell command is its own best headline;
 * for anything else the agent's `title` already is one, which is more than the other
 * providers give us.
 */
function previewFor(kind: unknown, title: unknown, rawInput: unknown): string | null {
  const input = (rawInput ?? {}) as Record<string, unknown>
  if (kind === 'execute') {
    const shell = shellPreview(input.command ?? input.commands)
    if (shell) return shell
  }
  if (typeof title === 'string' && title.trim()) return title.trim()
  return null
}

/** Plain text out of an ACP content block (text blocks only — images carry no words). */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('')
  const b = content as { type?: unknown; text?: unknown } | null
  if (b && b.type === 'text' && typeof b.text === 'string') return b.text
  return ''
}

/**
 * One `session/update` notification into chat events.
 *
 * `seenToolCalls` is the caller's set of tool-call ids already announced: the spec lets
 * an agent introduce a call with either `tool_call` or a first `tool_call_update`, so
 * the id is what decides whether a line is new, not the update kind.
 *
 * `plan` is the agent's whole to-do list each time, so it becomes a row carrying the
 * list for the Work panel; a call announced with `diff` content carries the edit the
 * same way. A diff that only arrives in a later update for a call already on screen
 * is not carried yet (the row has nowhere to put it) — the session's log still has it.
 *
 * Deliberately unmapped, because each would need a renderer concept Cockpit does not
 * have yet: `agent_thought_chunk` (the Codex parser drops reasoning too),
 * `usage_update` (a live context-window meter — the one worth building next),
 * `available_commands_update`, `config_option_update`, `current_mode_update`.
 */
export function acpUpdateToEvents(
  turnId: string,
  update: unknown,
  seenToolCalls: Set<string>
): ChatEvent[] {
  const u = (update ?? {}) as Record<string, unknown>
  const kind = u.sessionUpdate

  if (kind === 'agent_message_chunk') {
    const text = blockText(u.content)
    return text ? [{ turnId, type: 'text', text }] : []
  }

  if (kind === 'plan') {
    const artifact = acpPlanArtifact(u.entries)
    // an empty plan is the agent's opening state more often than a cleared list — a
    // "0 steps" row would only be noise
    if (!artifact || artifact.kind !== 'todos' || artifact.items.length === 0) return []
    const n = artifact.items.length
    return [
      {
        turnId,
        type: 'tool',
        toolName: 'plan',
        detail: truncate(JSON.stringify(u.entries ?? []), 200),
        preview: `${n} ${n === 1 ? 'step' : 'steps'}`,
        artifact
      }
    ]
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = typeof u.toolCallId === 'string' ? u.toolCallId : ''
    // an update for a call already on screen carries only its output and status, and
    // Cockpit's tool line has nowhere to put either
    if (!id || seenToolCalls.has(id)) return []
    // a bare update with no title is output for a call we never saw announced — there
    // is nothing to label a line with, so let it pass rather than print "tool"
    if (kind === 'tool_call_update' && typeof u.title !== 'string') return []
    seenToolCalls.add(id)
    const preview = previewFor(u.kind, u.title, u.rawInput)
    const artifact = acpDiffArtifact(u.content)
    return [
      {
        turnId,
        type: 'tool',
        toolName: toolNameFor(u.kind),
        detail: truncate(JSON.stringify(u.rawInput ?? u.title ?? {}), 200),
        ...(preview ? { preview: truncate(preview, 200) } : {}),
        ...(artifact ? { artifact } : {})
      }
    ]
  }

  return []
}

/** The options an agent offered, normalized — anything unusable as an answer is dropped. */
export function permissionOptions(raw: unknown): AcpPermissionOption[] {
  if (!Array.isArray(raw)) return []
  const out: AcpPermissionOption[] = []
  for (const o of raw) {
    const opt = (o ?? {}) as Record<string, unknown>
    const optionId = typeof opt.optionId === 'string' ? opt.optionId : ''
    if (!optionId) continue
    const name = typeof opt.name === 'string' && opt.name.trim() ? opt.name.trim() : optionId
    out.push({
      optionId,
      name: truncate(name, 48),
      ...(typeof opt.kind === 'string' ? { kind: opt.kind } : {})
    })
    if (out.length >= 8) break
  }
  return out
}

/** Tool-call kinds `auto-edit` answers by itself — the ones that only touch files. */
const AUTO_EDIT_KINDS = new Set(['edit', 'read', 'move', 'search'])

/**
 * What to do with a permission request, given the mode the turn was started in.
 *
 * This is the first time Cockpit can answer these one at a time. The CLI paths pre-answer
 * everything with a flag, which is why `auto-edit` has always been approximate there; here
 * it can mean what it says — file work proceeds, anything that executes still asks.
 * Returns the option id to send back, or null to put the question to the user.
 */
export function decidePermission(
  mode: PermissionMode,
  options: readonly AcpPermissionOption[],
  toolKind?: string
): string | null {
  if (options.length === 0) return null
  const byKind = (k: string): string | undefined => options.find((o) => o.kind === k)?.optionId
  const allow = (): string | null => byKind('allow_always') ?? byKind('allow_once') ?? null
  if (mode === 'yolo') return allow()
  if (mode === 'auto-edit' && toolKind && AUTO_EDIT_KINDS.has(toolKind)) {
    // once per call, not once per session: 'auto-edit' is a turn's setting, and
    // allow_always would outlive the turn inside the agent's own config
    return byKind('allow_once') ?? allow()
  }
  return null
}

/** The refusal to send when a turn is cancelled while a permission question is open. */
export function denyOption(options: readonly AcpPermissionOption[]): string | null {
  return (
    options.find((o) => o.kind === 'reject_once')?.optionId ??
    options.find((o) => o.kind === 'reject_always')?.optionId ??
    null
  )
}

/**
 * The end of a turn. `stopReason` distinguishes a finished answer from a refusal the
 * agent made silently — without this a turn stopped for hitting its token budget or a
 * blocked permission would look like a successful empty reply.
 */
export function promptResultEvents(turnId: string, result: unknown): ChatEvent[] {
  const stop = (result as { stopReason?: unknown } | null)?.stopReason
  const out: ChatEvent[] = []
  if (stop === 'max_tokens' || stop === 'max_turn_requests') {
    out.push({ turnId, type: 'error', message: `The agent stopped early: ${String(stop).replace(/_/g, ' ')}.` })
  } else if (stop === 'refusal') {
    out.push({ turnId, type: 'error', message: 'The agent refused to continue with this request.' })
  }
  out.push({ turnId, type: 'done' })
  return out
}

/**
 * Which ACP session mode a permission mode asks for, out of the ones this agent offers.
 * Mode ids are URLs in the spec's own namespace; match on the fragment so an agent that
 * spells the base differently still lines up. Null means "leave the agent's default".
 */
export function modeIdFor(
  mode: PermissionMode,
  availableModes: readonly { readonly id: string }[]
): string | null {
  if (mode !== 'yolo') return null
  const autopilot = availableModes.find((m) => m.id.endsWith('#autopilot'))
  return autopilot?.id ?? null
}
