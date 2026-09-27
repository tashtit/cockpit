/**
 * What every branch Cockpit cuts for a worktree starts with: `cockpit/`, unless the
 * person names their own. Teams have rules for this (`titan/`, `users/titan/`), and an
 * agent that follows its instructions will not commit on a branch the rule forbids.
 *
 * Shared: main enforces it when it names a branch, and Settings explains the same rule
 * while the person types.
 */
export const DEFAULT_BRANCH_PREFIX = 'cockpit/'

export const BRANCH_PREFIX_MAX = 40

/** A prefix as typed: trimmed, and a bare name gets its `/` — `titan` means `titan/`. */
export function normalizeBranchPrefix(raw: string): string {
  const prefix = raw.trim()
  return /[A-Za-z0-9]$/.test(prefix) ? `${prefix}/` : prefix
}

/**
 * Why a normalized prefix cannot start a branch name, or null when it can. Narrower than
 * git's own rules on purpose: a name that also reaches `git worktree add -b` and a push
 * refspec should hold nothing a shell, a URL or a ref parser reads specially. Empty is
 * not a refusal — it means the default.
 */
export function branchPrefixRefusal(prefix: string): string | null {
  if (prefix === '') return null
  if (prefix.length > BRANCH_PREFIX_MAX) return `Keep it to ${BRANCH_PREFIX_MAX} characters.`
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix)) return 'Use letters, digits and . _ - / only.'
  if (!/^[A-Za-z0-9]/.test(prefix)) return 'Start with a letter or a digit.'
  if (prefix.includes('//') || prefix.includes('..')) return 'Git refuses // and .. in a branch name.'
  if (/\/\.|\.lock\//.test(prefix)) return 'Git refuses a part that starts with . or ends in .lock.'
  return null
}

/** The prefix a stored value stands for: the default when it is absent or no longer valid. */
export function branchPrefixOf(stored: unknown): string {
  if (typeof stored !== 'string') return DEFAULT_BRANCH_PREFIX
  const prefix = normalizeBranchPrefix(stored)
  return prefix === '' || branchPrefixRefusal(prefix) !== null ? DEFAULT_BRANCH_PREFIX : prefix
}
