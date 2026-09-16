import { useSyncExternalStore } from 'react'

/**
 * Landed sessions: a turn Cockpit ran has ended, and the user hasn't looked at it
 * since. Flying was always visible; landing was not — a finished session rejoined
 * twenty idle rows and the only signal was a timestamp that had moved.
 *
 * The state lives here rather than in main because it is about *this user's
 * attention*, not about the session: main knows a process exited, only the
 * renderer knows whether anyone was watching. `busy.ts` reports the transitions,
 * App reports what is on screen, and the board and tree read the map.
 */

const KEY = 'cockpit:landed'
/** Landings older than this are noise, not news. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Bound the map: a long session of many turns must not grow localStorage forever. */
const MAX = 60

/** id → epoch ms the turn ended */
let landed: ReadonlyMap<string, number> = load()
/** The session the user is looking at right now — it can never be "unseen". */
let viewing: string | null = null
const listeners = new Set<() => void>()

function load(): ReadonlyMap<string, number> {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return new Map()
    const cutoff = Date.now() - TTL_MS
    const entries = Object.entries(JSON.parse(raw) as Record<string, unknown>)
      .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX)
    return new Map(entries)
  } catch {
    // a hand-edited or quota-blocked store must never take the window down
    return new Map()
  }
}

function commit(next: Map<string, number>): void {
  const trimmed =
    next.size <= MAX
      ? next
      : new Map([...next].sort((a, b) => b[1] - a[1]).slice(0, MAX))
  landed = trimmed
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(trimmed)))
  } catch {
    // private windows and full quotas: the in-memory map still works this session
  }
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Turns that just ended. Called by `busy.ts` with the ids that left the busy set;
 * the session on screen lands "already seen", because the user watched it happen.
 */
export function noteTurnsEnded(ids: readonly string[], at = Date.now()): void {
  const fresh = ids.filter((id) => id !== viewing)
  if (fresh.length === 0) return
  const next = new Map(landed)
  for (const id of fresh) next.set(id, at)
  commit(next)
}

/** The user opened it (or is in it): the landing is no longer news. */
export function markSeen(id: string | null): void {
  if (!id || !landed.has(id)) return
  const next = new Map(landed)
  next.delete(id)
  commit(next)
}

/** What the chat pane is showing, or null — App keeps this in step with selection. */
export function setViewing(id: string | null): void {
  viewing = id
  markSeen(id)
}

/** Test seam: drop everything, in memory and on disk. */
export function clearLanded(): void {
  viewing = null
  commit(new Map())
}

/** id → when the turn ended, for the rows that carry the state. */
export function useLandedMap(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, () => landed)
}

/** True while this session has an unseen landing (sidebar rows ask one at a time). */
export function useSessionLanded(id: string): boolean {
  return useSyncExternalStore(subscribe, () => landed.has(id))
}
