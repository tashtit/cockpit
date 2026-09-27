import type { RoundtableEntry, RoundtableParticipant } from '../../shared/types'
import { entrySeatIndex, seatDisplayName } from '../../shared/roundtable'
import { PROVIDER_LABEL } from './logos'

/** UI seat name: "Claude", or "Claude · opus" / "Claude #2" when a provider repeats. */
export function uiSeatName(participants: readonly RoundtableParticipant[], index: number): string {
  return seatDisplayName(participants, index, PROVIDER_LABEL)
}

/**
 * Each seat's latest reply in the current cycle — everything after the last user
 * message — by seat index; undefined for a seat that has not answered in it. A failed
 * turn is no reply: it is silence, not a position.
 */
export function cycleReplies(
  participants: readonly RoundtableParticipant[],
  entries: readonly RoundtableEntry[]
): readonly (RoundtableEntry | undefined)[] {
  // the current cycle: everything after the last user message
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].speaker === 'user') {
      start = i + 1
      break
    }
  }
  return participants.map((_, i) => {
    for (let j = entries.length - 1; j >= start; j--) {
      const e = entries[j]
      if (e.speaker !== 'user' && entrySeatIndex(participants, e) === i && !e.error) return e
    }
    return undefined
  })
}
