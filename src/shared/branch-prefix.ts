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
 * First parts git reads as something other than a branch's own name: `refs/` spells a
 * ref's full name (`refs/heads/` would make every branch `refs/heads/refs/heads/…`), and
 * `heads/`, `remotes/` and `tags/` are what git puts after `refs/` when it resolves a short
 * name, so a branch under one is ambiguous with the ref git finds there first.
 */
const REF_WORDS: ReadonlySet<string> = new Set(['refs', 'heads', 'remotes', 'tags'])

/** Remotes' usual names: a branch under one reads as that remote's branch, locally and in a refspec. */
const REMOTE_WORDS: ReadonlySet<string> = new Set(['origin', 'upstream'])

/**
 * Why a normalized prefix cannot start a branch name, or null when it can. Narrower than
 * git's own rules on purpose: a name that also reaches `git worktree add -b` and a push
 * refspec should hold nothing a shell, a URL or a ref parser reads specially. Empty is
 * not a refusal — it means the default. That no repository already has a branch named
 * for a part of it (`main` under `main/`) is main's to check, per repository
 * (`branchPrefixParents`).
 */
export function branchPrefixRefusal(prefix: string): string | null {
  if (prefix === '') return null
  if (prefix.length > BRANCH_PREFIX_MAX) return `Keep it to ${BRANCH_PREFIX_MAX} characters.`
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix)) return 'Use letters, digits and . _ - / only.'
  if (!/^[A-Za-z0-9]/.test(prefix)) return 'Start with a letter or a digit.'
  if (prefix.includes('//') || prefix.includes('..')) return 'Git refuses // and .. in a branch name.'
  if (/\/\.|\.lock\//.test(prefix)) return 'Git refuses a part that starts with . or ends in .lock.'
  // compared without case: a Mac's disk keeps `Origin/x` and `origin/x` in one place
  const first = prefix.split('/')[0].toLowerCase()
  if (prefix.includes('/') && REF_WORDS.has(first)) {
    return `Git reads ${first}/ as part of a ref's full name, not a branch's — leave it out.`
  }
  if (prefix.includes('/') && REMOTE_WORDS.has(first)) {
    return `${first} names a remote, so every branch under it would read as one of that remote's.`
  }
  return null
}

/**
 * The branch names a prefix puts new branches inside: `users/titan/` → `users` and
 * `users/titan`. Git keeps a branch as a file within the folders its name spells, so
 * none of these can also be a branch in the same repository — with `main` there, every
 * `main/…` fails to be made ("cannot lock ref").
 */
export function branchPrefixParents(prefix: string): string[] {
  // what follows the last `/` begins the new branch's own name, not a folder
  const folders = prefix.split('/').slice(0, -1)
  return folders.map((_, i) => folders.slice(0, i + 1).join('/'))
}

/** Why the prefix can't be used in `repo`, which has a branch named `branch` (a parent of it). */
export function branchPrefixClash(prefix: string, branch: string, repo: string): string {
  return `${prefix} can't be used in ${repo}: it has a branch named ${branch}, and git can't keep a branch inside another branch's name. Pick another prefix in Settings.`
}

/** The prefix a stored value stands for: the default when it is absent or no longer valid. */
export function branchPrefixOf(stored: unknown): string {
  if (typeof stored !== 'string') return DEFAULT_BRANCH_PREFIX
  const prefix = normalizeBranchPrefix(stored)
  return prefix === '' || branchPrefixRefusal(prefix) !== null ? DEFAULT_BRANCH_PREFIX : prefix
}
