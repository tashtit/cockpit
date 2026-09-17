import { useSyncExternalStore } from 'react'
import type { Landing } from '../../shared/types'
import { api } from './api'

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

/** id → why it needs you, for the rows that carry the state. */
export function useLandedMap(): ReadonlyMap<string, Landing> {
  return useSyncExternalStore(subscribe, () => landed)
}

/** Why this session needs you, or null (sidebar rows ask one at a time). */
export function useSessionLanded(id: string): Landing | null {
  return useSyncExternalStore(subscribe, () => landed.get(id) ?? null)
}
