import type { PrCheckRun, PrFeedback } from './types'

/*
 * The words and verdicts both halves agree on — main's fix prompt and the
 * review panel's PR strip must never disagree about what counts as failing.
 * Pure; no IO, no DOM.
 */

/** Checks that count against the PR — GitHub's merge box treats a cancelled run as failing. */
export function failingChecks(checks: readonly PrCheckRun[]): PrCheckRun[] {
  return checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
}

const STATE_WORD: Record<string, string> = {
  FAILURE: 'failed',
  ERROR: 'errored',
  TIMED_OUT: 'timed out',
  CANCELLED: 'cancelled',
  ACTION_REQUIRED: 'needs action',
  STARTUP_FAILURE: 'failed to start'
}

/** How a failing check reads — "failed", "timed out"… — from GitHub's raw state. */
export function checkStateWord(c: PrCheckRun): string {
  if (c.bucket === 'cancel') return 'cancelled'
  return STATE_WORD[c.state] ?? (c.state ? c.state.toLowerCase().replace(/_/g, ' ') : 'failed')
}

/** Anything an agent can act on: failing checks, reviews asking for changes, open threads, conflicts. */
export function needsFix(fb: PrFeedback): boolean {
  return failingChecks(fb.checks).length > 0 || fb.changeRequests.length > 0 || fb.threads.length > 0 || fb.conflicts
}
