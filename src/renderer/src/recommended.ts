import { storedValue } from './stored-value'

/**
 * Whether the person has answered the Agents panel's recommendation — added it, or said
 * not now. A nudge someone has answered is a reading preference, not machine state, and
 * nothing else needs it → localStorage (`stored-value.ts`), like the rail's width. Losing
 * it costs one more offer, never a change to an agent: the callout only ever offers.
 */
const answered = storedValue<boolean>('cockpit:recommended-marketplace', {
  parse: (raw) => raw === 'answered',
  serialize: (yes) => (yes ? 'answered' : null),
  fallback: false
})

export function recommendationAnswered(): boolean {
  return answered.get()
}

export function answerRecommendation(): void {
  answered.set(true)
}
