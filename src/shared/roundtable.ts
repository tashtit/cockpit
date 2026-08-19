import type { Provider, RoundtableEntry, RoundtableParticipant } from './types'

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
