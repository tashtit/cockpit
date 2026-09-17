import { useSyncExternalStore } from 'react'
import type { AttentionItem } from '../../shared/types'
import { api } from './api'

/**
 * What needs you: main's list (`attention-core.ts`), mirrored for the rows that show
 * it — the home board's "Needs you" group, the sidebar's markers, the palette's
 * landed group. Flying was always visible; a turn ending, an agent stopping to ask,
 * a PR going red were not — a finished session rejoined twenty idle rows and the
 * only signal was a timestamp that had moved.
 *
 * Main owns the state: it sees every turn end and every log write, including for
 * sessions no view has open, and the same list drives the Dock badge and the
 * notifications. What it can't see is the screen, so App reports what the window
 * shows (`setAttentionFocus`) and main keeps a watched session from ever landing;
 * opening a session clears its item. This store mirrors main's list.
 */

let items: readonly AttentionItem[] = []
/** session id → its item, for rows that ask one at a time */
let bySession: ReadonlyMap<string, AttentionItem> = new Map()
/** session id → when it was raised: the palette's landed group */
let landed: ReadonlyMap<string, number> = new Map()
const listeners = new Set<() => void>()

/** Where the renderer kept landings before main took them over. */
const LEGACY_KEY = 'cockpit:landed'

function set(list: readonly AttentionItem[]): void {
  items = list
  const sessions = new Map<string, AttentionItem>()
  const when = new Map<string, number>()
  for (const it of list) {
    if (it.kind !== 'session' || sessions.has(it.id)) continue
    sessions.set(it.id, it)
    when.set(it.id, it.at)
  }
  bySession = sessions
  landed = when
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Seed from main and follow its pushes; returns the unsubscribe (App's mount effect). */
export function initAttention(): () => void {
  try {
    window.localStorage.removeItem(LEGACY_KEY)
  } catch {
    // private windows and blocked storage: nothing to tidy
  }
  // a push that beats the seed is newer than it — the seed must not overwrite it
  let pushed = false
  void api.getAttention().then((list) => {
    if (!pushed) set(list)
  })
  const off = api.onAttention((list) => {
    pushed = true
    set(list)
  })
  return off
}

/** Test seam: forget everything this window was told. */
export function clearAttention(): void {
  set([])
}

/** Everything that needs you, newest first — the board's group renders it whole. */
export function useAttentionItems(): readonly AttentionItem[] {
  return useSyncExternalStore(subscribe, () => items)
}

/** This session's item, or null — sidebar rows ask one at a time. */
export function useSessionAttention(id: string): AttentionItem | null {
  return useSyncExternalStore(subscribe, () => bySession.get(id) ?? null)
}

/** session id → when it was raised, for the palette's board-in-miniature. */
export function useLandedMap(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, () => landed)
}
