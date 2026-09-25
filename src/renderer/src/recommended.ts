/**
 * Whether the person has answered the Agents panel's recommendation — added it, or said
 * not now. A nudge someone has answered is a reading preference, not machine state, and
 * nothing else needs it → localStorage, like the rail's width. Losing it costs one more
 * offer, never a change to an agent: the callout only ever offers.
 */
const KEY = 'cockpit:recommended-marketplace'

export function recommendationAnswered(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'answered'
  } catch {
    return false
  }
}

export function answerRecommendation(): void {
  try {
    window.localStorage.setItem(KEY, 'answered')
  } catch {
    // a blocked store only means the offer comes back next visit
  }
}
