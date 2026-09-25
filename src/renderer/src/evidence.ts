import type { RoundtableParticipant, SessionMessage, SessionMeta } from '../../shared/types'

/**
 * What a roundtable seat's replies rest on: the commands it ran, what it searched for,
 * the pages it fetched and the code it read — read from the seat's own provider log,
 * since the table keeps only each reply's text. Seats run in safe mode and research;
 * this is how the person checks a claim like "that name is taken" after the round.
 *
 * Pure, and built from each row's own tool name, headline and result — the renderer
 * never parses tool JSON.
 */

export type EvidenceKind = 'command' | 'search' | 'page' | 'file' | 'other'

/** Each CLI's names for the tools that gather evidence */
const KINDS: Readonly<Record<string, EvidenceKind>> = {
  Bash: 'command',
  bash: 'command',
  shell: 'command',
  exec_command: 'command',
  local_shell: 'command',
  exec: 'command',
  WebSearch: 'search',
  web_search: 'search',
  WebFetch: 'page',
  web_fetch: 'page',
  Read: 'file',
  Grep: 'file',
  Glob: 'file',
  LS: 'file',
  view: 'file',
  view_image: 'file',
  grep: 'file',
  glob: 'file',
  rg: 'file'
}

/** A seat's own bookkeeping — how it works, not what it looked at */
const BOOKKEEPING = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'ToolSearch',
  'tool_search_tool',
  'report_intent',
  'update_plan',
  'Skill',
  'skill'
])

export type EvidenceItem = {
  readonly key: number
  readonly ts?: number
  readonly kind: EvidenceKind
  readonly toolName: string
  /** What it ran, searched for, fetched or read, as the row headlines it */
  readonly text: string
  /** The start of what came back, when the log has it */
  readonly result?: string
  /** `failed`: it ran and failed, or the command exited non-zero. `refused`: it never ran —
   *  the seat's safe mode held it for an approval a table can't give */
  readonly outcome: 'ok' | 'failed' | 'refused'
}

/** One turn of a seat: the prompt the table relayed to it, what it gathered, and its reply. */
export type EvidenceTurn = {
  readonly key: number
  readonly ts?: number
  /** The first line of the reply it gave on this evidence */
  readonly reply?: string
  readonly items: readonly EvidenceItem[]
}

const firstLine = (text: string): string => text.split('\n').find((l) => l.trim())?.trim() ?? ''

/**
 * What an agent's harness says instead of running a call its permissions don't allow —
 * Claude's approval and shell-safety refusals, the ones a safe-mode seat meets most. A
 * call refused this way gathered nothing: the claim it was meant to back rests on none.
 */
const REFUSED =
  /requires approval|requested permissions?|haven't granted|permission (for this action )?was denied|not allowed|Contains simple_expansion|This (Bash )?command contains|<tool_use_error>Blocked/i

/** A seat's log as its turns — newest first, only those that gathered something. */
export function buildEvidence(log: readonly SessionMessage[]): EvidenceTurn[] {
  type Draft = { key: number; ts?: number; reply?: string; items: EvidenceItem[] }
  const turns: Draft[] = []
  let cur: Draft | null = null
  log.forEach((m, key) => {
    if (m.role === 'user' && m.kind === 'text') {
      cur = { key, ...(m.ts ? { ts: m.ts } : {}), items: [] }
      turns.push(cur)
      return
    }
    if (!cur) {
      cur = { key, ...(m.ts ? { ts: m.ts } : {}), items: [] }
      turns.push(cur)
    }
    if (m.role === 'assistant' && m.kind === 'text' && m.text.trim()) {
      cur.reply = firstLine(m.text).slice(0, 200)
      return
    }
    if (m.kind !== 'tool_call' || !m.toolName || BOOKKEEPING.has(m.toolName)) return
    const next = log[key + 1]
    const result = next?.kind === 'tool_result' ? next.text.trim() : ''
    cur.items.push({
      key,
      ...(m.ts ? { ts: m.ts } : {}),
      kind: KINDS[m.toolName] ?? 'other',
      toolName: m.toolName,
      text: (m.preview ?? m.text).trim(),
      ...(result && result !== '(result)' ? { result } : {}),
      outcome: m.failed !== true ? 'ok' : REFUSED.test(result) ? 'refused' : 'failed'
    })
  })
  return turns.filter((t) => t.items.length > 0).reverse()
}

/**
 * Which of a table's sessions each seat ran. A seat that announced its session is
 * matched by id; the table's other sessions — a CLI that never names one, Copilot's —
 * go to the seats of their agent that have none. When several such seats share an agent,
 * each is shown them all, marked `shared`: the logs can't say which seat ran which.
 */
export function seatSessions(
  participants: readonly RoundtableParticipant[],
  sessions: readonly SessionMeta[]
): ReadonlyArray<{ readonly sessions: readonly SessionMeta[]; readonly shared: boolean }> {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const owned = new Set<string>()
  const own = participants.map((p) => {
    const s = p.nativeSessionId ? byId.get(`${p.provider}:${p.nativeSessionId}`) : undefined
    if (s) owned.add(s.id)
    return s
  })
  const loose = sessions.filter((s) => !owned.has(s.id)).sort((a, b) => a.startedAt - b.startedAt)
  return participants.map((p, i) => {
    const mine = own[i]
    if (mine) return { sessions: [mine], shared: false }
    const theirs = loose.filter((s) => s.provider === p.provider)
    const siblings = participants.filter((q, j) => q.provider === p.provider && !own[j]).length
    return { sessions: theirs, shared: siblings > 1 && theirs.length > 0 }
  })
}

/** The words a kind reads as on its item */
export const EVIDENCE_VERB: Readonly<Record<EvidenceKind, string>> = {
  command: 'ran',
  search: 'searched',
  page: 'fetched',
  file: 'read',
  other: 'called'
}
