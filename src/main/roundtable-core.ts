import type {
  Provider,
  Roundtable,
  RoundtableEntry,
  RoundtableParticipant,
  RoundtableSpeaker
} from '../shared/types'
import { entrySeatIndex, SEAT_NAME, seatDisplayName } from '../shared/roundtable'

export { SEAT_NAME } from '../shared/roundtable'

/**
 * The relay logic for multi-agent roundtables, deliberately IO-free (same split as
 * instructions-core.ts): everything here is pure over the persisted record, so the
 * tests can cover prompt assembly and load-validation without Electron or processes.
 */

/** Caps keep relay prompts well inside argv limits (prompts ride as one CLI argument). */
const ENTRY_CAP = 6_000
const PROMPT_CAP = 48_000

function cap(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + ' …[truncated]'
}

/** How a transcript line is attributed inside a prompt; own lines read as "You". */
export function entryLabel(
  participants: readonly RoundtableParticipant[],
  entry: RoundtableEntry,
  selfIndex?: number
): string {
  if (entry.speaker === 'user') return 'User'
  const idx = entrySeatIndex(participants, entry)
  const name = idx >= 0 ? seatDisplayName(participants, idx) : SEAT_NAME[entry.speaker]
  return selfIndex !== undefined && idx === selfIndex ? `You (${name})` : name
}

/** "[User]: …" transcript lines, oldest first. Error entries are not discussion content. */
export function formatEntries(
  participants: readonly RoundtableParticipant[],
  entries: readonly RoundtableEntry[],
  selfIndex?: number
): string {
  return entries
    .filter((e) => !e.error)
    .map((e) => `[${entryLabel(participants, e, selfIndex)}]: ${cap(e.text, ENTRY_CAP)}`)
    .join('\n\n')
}

/** What buildTurnPrompt needs to know about the table — a full Roundtable qualifies. */
export type TableInfo = Pick<
  Roundtable,
  'cwd' | 'branch' | 'repoRoot' | 'mode' | 'participants' | 'entries'
>

function framing(table: TableInfo, seatIndex: number): string {
  const others = table.participants
    .map((_, i) => i)
    .filter((i) => i !== seatIndex)
    .map((i) => seatDisplayName(table.participants, i))
  const workspace = table.repoRoot
    ? `You all share the working directory ${table.cwd}${
        table.branch ? ` (branch ${table.branch})` : ''
      } — ground your points in the actual code when it helps. The workspace is read-only for this discussion: read, never change.`
    : 'No codebase is attached — this is a free-standing discussion.'
  const lines = [
    `You are ${seatDisplayName(table.participants, seatIndex)} in a live roundtable with ${others.join(
      ' and '
    )}, moderated by a human (User).`,
    'Ground rules: speak only as yourself, in first person. Keep each reply short and pointed — a few paragraphs at most. Engage with what the others actually said: agree, push back, or build on it, and say which. Bring something new rather than restating the transcript, and never answer on behalf of another seat. Do not prefix your reply with your own name.',
    // parallel waves mean a seat may answer before the others' takes exist — say so,
    // or agents waste their reply asking where everyone is
    'The user\'s messages go to every seat at once, so answer them without waiting for the others — their takes reach you next round. Never comment on another seat\'s absence, silence, or technical troubles; the moderator handles that.',
    workspace
  ]
  if (table.mode === 'consensus') lines.push(CONSENSUS_RULE)
  return lines.join('\n')
}

/** The goal contract for consensus tables — every seat closes with a stance line. */
const CONSENSUS_RULE =
  "This table's goal is a shared understanding. End every reply with exactly one final line: " +
  '"CONSENSUS: agree — <the position you stand behind, in one line>" once you can genuinely ' +
  'stand behind the table\'s current position, or "CONSENSUS: not yet — <the one point still ' +
  'open>" while you cannot. That line is read by the app, so keep it to one line. Never write ' +
  'the agree line out of politeness; keep pushing on what you actually dispute.'

/**
 * The relay prompt for one seat's turn.
 * - A seat with a resumable provider session gets only the delta since its last turn —
 *   its own session already carries the ground rules and everything it was shown before.
 * - A seat without a session id (first turn, or a provider that never announces one —
 *   copilot) gets the full framing + full transcript, its own past lines labeled "You".
 */
export function buildTurnPrompt(table: TableInfo, seatIndex: number): string {
  const seat = table.participants[seatIndex]
  if (!seat) return ''
  const ask =
    table.mode === 'consensus'
      ? 'Your turn — reply now, and end with your CONSENSUS line.'
      : 'Your turn — reply now.'
  if (seat.nativeSessionId) {
    const fresh = table.entries
      .slice(seat.seenUpTo)
      .filter((e) => entrySeatIndex(table.participants, e) !== seatIndex)
    return cap(
      `The roundtable continues. Since your last turn:\n\n${
        formatEntries(table.participants, fresh, seatIndex) || '(no new messages)'
      }\n\n${ask}`,
      PROMPT_CAP
    )
  }
  return cap(
    `${framing(table, seatIndex)}\n\nTranscript so far:\n\n${
      formatEntries(table.participants, table.entries, seatIndex) || '(you open the discussion)'
    }\n\n${ask}`,
    PROMPT_CAP
  )
}

/**
 * Pull the trailing "CONSENSUS: …" line off a reply. Tolerant of markdown wrapping
 * (**CONSENSUS:** agree) and case; anything that is not clearly "agree" counts as
 * not-yet — absence of agreement is never agreement. The note (the seat's own one-line
 * position or open point) is what the app-assembled outcome panel shows.
 */
export function parseStance(text: string): {
  readonly stance?: 'agree' | 'continue'
  readonly note?: string
  readonly text: string
} {
  const lines = text.trimEnd().split('\n')
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last--
  if (last < 0) return { text }
  const m = lines[last]
    .trim()
    .match(/^[>\s*_`~-]*consensus[\s*_`~]*[:—-][\s*_`~]*(.*)$/i)
  if (!m) return { text }
  const raw = m[1].replace(/^[*_`~\s]+/, '').replace(/[*_`~\s]+$/, '')
  // "agreed" is the same answer as "agree" — anything else still fails closed
  const stance = /^agreed?\b/i.test(raw) ? 'agree' : 'continue'
  // "agree — one tool, fewer configs" / "not yet — benchmarks" → the part after the dash
  const note = raw
    .replace(/^(agreed?|not\s+yet)\b[\s*_`~]*[—:,-]*\s*/i, '')
    .trim()
  return {
    stance,
    ...(note ? { note: cap(note, 200) } : {}),
    text: lines.slice(0, last).join('\n').trimEnd()
  }
}

/** A display title from the opening topic: first line, word-trimmed to ~56 chars. */
export function deriveTitle(topic: string): string {
  const line = topic.trim().split('\n', 1)[0]
  if (line.length <= 56) return line || 'Roundtable'
  const cut = line.slice(0, 56)
  const sp = cut.lastIndexOf(' ')
  return (sp > 24 ? cut.slice(0, sp) : cut) + '…'
}

const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']

function isProvider(v: unknown): v is Provider {
  return PROVIDERS.includes(v as Provider)
}

/**
 * Failure-tolerant load guard for persisted roundtable files: anything that is not a
 * plausible saved table yields null and gets skipped, never a crashed scan — the same
 * posture the session parsers take toward provider logs.
 */
export function sanitizeRoundtable(raw: unknown): Roundtable | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.cwd !== 'string' || !r.cwd) return null
  if (!Array.isArray(r.participants) || !Array.isArray(r.entries)) return null
  const participants: RoundtableParticipant[] = []
  for (const raw of r.participants) {
    const p = raw as Record<string, unknown> | null
    if (!p || !isProvider(p.provider)) return null
    participants.push({
      provider: p.provider,
      configDir: typeof p.configDir === 'string' ? p.configDir : undefined,
      copilotUser: typeof p.copilotUser === 'string' ? p.copilotUser : undefined,
      accountLabel: typeof p.accountLabel === 'string' ? p.accountLabel : undefined,
      options:
        p.options && typeof p.options === 'object'
          ? (p.options as RoundtableParticipant['options'])
          : undefined,
      nativeSessionId: typeof p.nativeSessionId === 'string' ? p.nativeSessionId : null,
      seenUpTo:
        typeof p.seenUpTo === 'number' && Number.isInteger(p.seenUpTo) && p.seenUpTo >= 0
          ? p.seenUpTo
          : 0
    })
  }
  if (participants.length === 0) return null
  const entries: RoundtableEntry[] = []
  for (const raw of r.entries) {
    const e = raw as Record<string, unknown> | null
    if (!e || typeof e.text !== 'string') continue
    if (e.speaker !== 'user' && !isProvider(e.speaker)) continue
    entries.push({
      speaker: e.speaker as RoundtableSpeaker,
      text: e.text,
      at: typeof e.at === 'number' ? e.at : 0,
      ...(e.error === true ? { error: true } : {}),
      ...(e.stance === 'agree' || e.stance === 'continue' ? { stance: e.stance } : {}),
      ...(typeof e.stanceNote === 'string' && e.stanceNote
        ? { stanceNote: e.stanceNote.slice(0, 200) }
        : {}),
      ...(typeof e.seat === 'number' && Number.isInteger(e.seat) && e.seat >= 0
        ? { seat: e.seat }
        : {})
    })
  }
  return {
    id: r.id,
    title: typeof r.title === 'string' && r.title ? r.title : 'Roundtable',
    topic: typeof r.topic === 'string' ? r.topic : '',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    cwd: r.cwd,
    repoRoot: typeof r.repoRoot === 'string' ? r.repoRoot : null,
    branch: typeof r.branch === 'string' ? r.branch : null,
    // discussions read, never write — even a hand-edited file cannot re-arm a table
    permissionMode: 'safe',
    mode: r.mode === 'consensus' ? 'consensus' : 'open',
    maxRounds: clampRounds(r.maxRounds),
    roundsRun:
      typeof r.roundsRun === 'number' && Number.isInteger(r.roundsRun) && r.roundsRun >= 0
        ? r.roundsRun
        : 0,
    concluded: r.concluded === true,
    participants,
    entries
  }
}

/** Auto-round cap: bounded so a stuck table can never grind a subscription. */
export function clampRounds(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 8 ? v : 3
}
