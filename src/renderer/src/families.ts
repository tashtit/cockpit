import { storedValue } from './stored-value'

/**
 * Which families of sessions — a session and the ones it started (`parentId`) — the
 * user folded in the tree. A view preference for this machine, like the composer's
 * last mode, so it lives in localStorage (`stored-value.ts`) rather than in config.
 * Families start open: a new one is where the work is happening, and folding it is the
 * user's call.
 */

/** Oldest folds fall off first — past this many, the ones left are long out of view. */
const MAX_KEPT = 500

const folded = storedValue<ReadonlySet<string>>('cockpit:folded-families', {
  parse: (raw) => {
    const ids: unknown = JSON.parse(raw)
    // a hand-mangled value folds nothing
    return new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : [])
  },
  // a Set keeps insertion order, so the newest fold is last and trimming drops the oldest
  serialize: (ids) => JSON.stringify([...ids].slice(-MAX_KEPT)),
  fallback: new Set()
})

/** The parent ids whose families are folded. */
export function useFoldedFamilies(): ReadonlySet<string> {
  return folded.use()
}

/** Fold the family under this session, or unfold it. */
export function toggleFamily(parentId: string): void {
  const next = new Set(folded.get())
  if (next.has(parentId)) next.delete(parentId)
  else next.add(parentId)
  folded.set(next)
}
