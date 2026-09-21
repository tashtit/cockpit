import { useSyncExternalStore } from 'react'

/**
 * Which families of sessions — a session and the ones it started (`parentId`) — the
 * user folded in the tree. A view preference for this machine, like the composer's
 * last mode, so it lives in localStorage rather than in config. Families start open:
 * a new one is where the work is happening, and folding it is the user's call.
 */
const KEY = 'cockpit:folded-families'
/** Oldest folds fall off first — past this many, the ones left are long out of view. */
const MAX_KEPT = 500

const listeners = new Set<() => void>()
let cachedRaw: string | null | undefined
let cached: ReadonlySet<string> = new Set()
/** Folds storage refused to save — they still hold for this run. */
let unsaved: string | null = null

function read(): string | null {
  if (unsaved !== null) return unsaved
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** The stored set, re-parsed only when the stored text changed (a stable snapshot). */
function snapshot(): ReadonlySet<string> {
  const raw = read()
  if (raw !== cachedRaw) {
    cachedRaw = raw
    let ids: unknown = []
    try {
      ids = JSON.parse(raw ?? '[]')
    } catch {
      /* a hand-mangled value folds nothing */
    }
    cached = new Set(Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : [])
  }
  return cached
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The parent ids whose families are folded. */
export function useFoldedFamilies(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot)
}

/** Fold the family under this session, or unfold it. */
export function toggleFamily(parentId: string): void {
  const next = new Set(snapshot())
  if (next.has(parentId)) next.delete(parentId)
  else next.add(parentId)
  // a Set keeps insertion order, so the newest fold is last and trimming drops the oldest
  const text = JSON.stringify([...next].slice(-MAX_KEPT))
  try {
    window.localStorage.setItem(KEY, text)
    unsaved = null
  } catch {
    unsaved = text
  }
  listeners.forEach((l) => l())
}
