/**
 * Names for a session started from a typed task, before the agent's own log exists.
 * The chat header shows `taskTitle` until the index catches up, and the worktree
 * branch is cut from `branchHint` — main slugifies and caps it (`createWorkspace`),
 * so a readable `cockpit/fix-login-flake-ci` replaces an opaque `cockpit/ws-mu33v4gh`.
 */

/** Filler that adds length, not meaning, to a branch name. */
const FILLER = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'and', 'please', 'with'])

/** The task's first line, the way a session title reads — '' for an images-only start. */
export function taskTitle(prompt: string): string {
  const first = prompt.trim().split('\n', 1)[0] ?? ''
  return first.length > 120 ? `${first.slice(0, 119)}…` : first
}

/** The first few meaningful words of the task; undefined lets main fall back to its own name. */
export function branchHint(prompt: string): string | undefined {
  const words = taskTitle(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .slice(0, 6)
  return words.length > 0 ? words.join('-') : undefined
}
