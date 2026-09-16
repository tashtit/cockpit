/**
 * The order projects are listed in. It never follows session activity — a busy repo
 * jumping to the top moves every row under the cursor. Projects sort A→Z by the name
 * the tree shows, unless the user dragged them into their own order: those keys come
 * first, as saved, and anything not in the saved order (a repo indexed since) follows
 * A→Z. The repo-less `general` group is always last. Sessions *inside* a project keep
 * sorting by activity; that is the indexer's `page()`, not this.
 */

type Orderable = {
  readonly key: string
  readonly name: string
  readonly fullName: string | null
}

const GENERAL = 'general'

/** What the tree shows for a project — `owner/repo`, else the directory name. */
export function repoSortName(r: Orderable): string {
  return r.fullName ?? r.name
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function byRepoName(a: Orderable, b: Orderable): number {
  return collator.compare(repoSortName(a), repoSortName(b)) || collator.compare(a.key, b.key)
}

/** `groups` in display order: saved order first, the rest A→Z, `general` last. */
export function orderRepos<T extends Orderable>(groups: readonly T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>()
  for (const key of order) if (!rank.has(key)) rank.set(key, rank.size)
  return [...groups].sort((a, b) => {
    if ((a.key === GENERAL) !== (b.key === GENERAL)) return a.key === GENERAL ? 1 : -1
    const ra = rank.get(a.key)
    const rb = rank.get(b.key)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return byRepoName(a, b)
  })
}

/**
 * The full key order after moving `key` to just before or after `target`. `keys` is
 * the order currently on screen; the result is what gets saved, so every listed
 * project is pinned where the user last saw it. Unknown keys return `keys` unchanged.
 */
export function moveRepo(
  keys: readonly string[],
  key: string,
  to: { readonly target: string; readonly place: 'before' | 'after' }
): string[] {
  if (key === to.target || !keys.includes(key) || !keys.includes(to.target)) return [...keys]
  const rest = keys.filter((k) => k !== key)
  const at = rest.indexOf(to.target) + (to.place === 'after' ? 1 : 0)
  return [...rest.slice(0, at), key, ...rest.slice(at)]
}

/** True when `groups` is already plain A→Z — the tree then has no custom order to reset. */
export function isAlphabetical<T extends Orderable>(groups: readonly T[]): boolean {
  return groups.every((g, i) => i === 0 || byRepoName(groups[i - 1], g) <= 0)
}
