import { useSyncExternalStore } from 'react'
import type { Landing } from '../../shared/types'
import { api } from './api'
import { subscribeBusy, waitingNow } from './busy'

/**
 * Sessions that need you: a turn has ended and nobody has opened the session since
 * (*landed*), the agent has stopped to ask something (*asks*), or the pull request
 * on its branch turned red (*pr*). Flying was always visible; these were not — a
 * finished session rejoined twenty idle rows and the only signal was a timestamp
 * that had moved.
 *
 * Main owns the state (`attention-core.ts`): it sees every turn end — Cockpit's own
 * and the ones it observes in the logs of terminals and the providers' apps — and the
 * same set drives the Dock badge and the notifications. What it can't see is the
 * screen, so App reports what the window shows (`setAttentionFocus`) and main keeps a
 * watched session from ever landing. This store mirrors main's set for the rows that
 * carry the mark; a session with several reasons carries its most urgent one.
 *
 * Main's set is news, and opening a session clears it — but an agent still stopped on
 * its question is still waiting whether or not you have looked. So the map the rows
 * read also holds every question the busy set says a turn is stopped on (`waitingNow`):
 * the row shows the question glyph instead of a spinner for as long as that lasts.
 */

/** id → why it needs you (one reason per session, the most urgent) */
let landed: ReadonlyMap<string, Landing> = new Map()
const listeners = new Set<() => void>()

/** Where the renderer kept landings before main took them over. */
const LEGACY_KEY = 'cockpit:landed'

function set(list: readonly Landing[]): void {
  landed = new Map(list.map((l) => [l.id, l]))
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Seed from main and follow its pushes; returns the unsubscribe (App's mount effect). */
export function initLanded(): () => void {
  try {
    window.localStorage.removeItem(LEGACY_KEY)
  } catch {
    // private windows and blocked storage: nothing to tidy
  }
  // a push that beats the seed is newer than it — the seed must not overwrite it
  let pushed = false
  void api.getLandings().then((list) => {
    if (!pushed) set(list)
  })
  const off = api.onLandings((list) => {
    pushed = true
    set(list)
  })
  return off
}

/** Test seam: forget everything this window was told. */
export function clearLanded(): void {
  set([])
}

function subscribeAll(cb: () => void): () => void {
  const offLanded = subscribe(cb)
  const offBusy = subscribeBusy(cb)
  return () => {
    offLanded()
    offBusy()
  }
}

/** main's set with the questions turns are stopped on; rebuilt only when either changes */
let view: { readonly base: typeof landed; readonly waiting: ReadonlyMap<string, Landing>; readonly map: ReadonlyMap<string, Landing> } | null = null

function needsYou(): ReadonlyMap<string, Landing> {
  const waiting = waitingNow()
  if (view?.base === landed && view.waiting === waiting) return view.map
  let map = landed
  if (waiting.size > 0) {
    const merged = new Map(landed)
    // a question outranks a red PR and a landing; main's own keeps the time it was raised
    for (const [id, w] of waiting) if (merged.get(id)?.kind !== 'asks') merged.set(id, w)
    map = merged
  }
  view = { base: landed, waiting, map }
  return map
}

/** id → why it needs you, for the rows that carry the state. */
export function useLandedMap(): ReadonlyMap<string, Landing> {
  return useSyncExternalStore(subscribeAll, needsYou)
}

/** Why this session needs you, or null (sidebar rows ask one at a time). */
export function useSessionLanded(id: string): Landing | null {
  return useSyncExternalStore(subscribeAll, () => needsYou().get(id) ?? null)
}
