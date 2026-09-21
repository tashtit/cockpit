import type {
  Provider,
  RoundtableEntry,
  RoundtableLimits,
  RoundtableParticipant
} from './types'

/**
 * Seat identity, shared by the prompt relay (main) and the UI (renderer) — both are
 * pure functions over the persisted record, like endpoints.ts. A seat is identified
 * by its index in `participants` (fixed at creation); several seats may share a
 * provider, so display names disambiguate by model, then ordinal.
 */

/** Names the agents call each other in prompts — and the UI shows on seats. */
export const SEAT_NAME: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot'
}

/**
 * "Claude Code", or "Claude Code · opus" / "Claude Code #2" when providers repeat.
 * `names` swaps the base vocabulary (prompts use SEAT_NAME; the UI passes its own
 * shorter labels) — the disambiguation logic stays identical on both sides.
 */
export function seatDisplayName(
  participants: readonly RoundtableParticipant[],
  index: number,
  names: Record<Provider, string> = SEAT_NAME
): string {
  const seat = participants[index]
  if (!seat) return 'Seat'
  const base = names[seat.provider]
  const twins = participants.filter((p) => p.provider === seat.provider)
  if (twins.length <= 1) return base
  const model = seat.options?.model
  // a model that is unique among the twins is the natural disambiguator
  if (model && twins.filter((p) => p.options?.model === model).length === 1) {
    return `${base} · ${model}`
  }
  const ordinal = participants
    .slice(0, index + 1)
    .filter((p) => p.provider === seat.provider).length
  return model ? `${base} · ${model} #${ordinal}` : `${base} #${ordinal}`
}

/**
 * The participant index an entry belongs to; -1 for user entries. Entries written
 * before seats carried indexes fall back to the provider's first seat — exact for
 * every old table, since duplicate providers did not exist then.
 */
export function entrySeatIndex(
  participants: readonly RoundtableParticipant[],
  entry: RoundtableEntry
): number {
  if (entry.speaker === 'user') return -1
  if (typeof entry.seat === 'number' && participants[entry.seat]?.provider === entry.speaker) {
    return entry.seat
  }
  return participants.findIndex((p) => p.provider === entry.speaker)
}

/* ---------- what a table may spend ---------- */

/** Hard seat cap — past this a wave is a crowd, not a discussion. */
export const ROUNDTABLE_MAX_SEATS = 8

export const DEFAULT_ROUNDTABLE_LIMITS: RoundtableLimits = {
  maxTurnsPerMessage: 16,
  maxTurnsPerTable: 80
}

/** The range each ceiling may be set to. */
export const ROUNDTABLE_LIMIT_RANGE = {
  maxTurnsPerMessage: { min: 2, max: 64 },
  /** 0 switches the ceiling off */
  maxTurnsPerTable: { min: 0, max: 1000 }
} as const

/** Limits are renderer input and file content alike: anything out of range is the default. */
export function sanitizeRoundtableLimits(raw: unknown): RoundtableLimits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = (key: keyof RoundtableLimits): number => {
    const v = r[key]
    const { min, max } = ROUNDTABLE_LIMIT_RANGE[key]
    return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
      ? v
      : DEFAULT_ROUNDTABLE_LIMITS[key]
  }
  return {
    maxTurnsPerMessage: pick('maxTurnsPerMessage'),
    maxTurnsPerTable: pick('maxTurnsPerTable')
  }
}

/**
 * Rounds one message may run with this many seats — the wave is round 1, so a table is
 * always allowed that one: a message that reaches nobody is not a cheaper table.
 */
export function roundsAllowed(limits: RoundtableLimits, seats: number): number {
  return Math.max(1, Math.floor(limits.maxTurnsPerMessage / Math.max(1, seats)))
}

/** Agent turns a table has spent: every reply on the record, failed ones included. */
export function turnsSpent(entries: readonly RoundtableEntry[]): number {
  return entries.filter((e) => e.speaker !== 'user').length
}

/** Why another round may not start, or null when the table can afford it. */
export function roundRefusal(
  limits: RoundtableLimits,
  table: { readonly participants: readonly unknown[]; readonly entries: readonly RoundtableEntry[] }
): string | null {
  if (limits.maxTurnsPerTable === 0) return null
  const spent = turnsSpent(table.entries)
  if (spent + table.participants.length <= limits.maxTurnsPerTable) return null
  return (
    `This table has spent ${spent} of its ${limits.maxTurnsPerTable} agent turns — another round ` +
    'would pass its ceiling. Raise the table’s limit, or open a new table.'
  )
}

/**
 * Seats that repeat an earlier one exactly — same agent, account, model provider and
 * model. They are allowed (several samples of one mind is a real use), but each is a
 * full turn every round for a voice the table already has, so the form marks them and
 * the choice is visibly deliberate. `key` is whatever identifies a seat's setup.
 */
export function duplicateSeats(keys: readonly string[]): boolean[] {
  return keys.map((k, i) => keys.indexOf(k) < i)
}
