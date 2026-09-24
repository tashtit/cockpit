import { useSyncExternalStore } from 'react'
import type { BusySession } from '../../shared/types'
import { api } from './api'

/**
 * Tiny shared store for live session status: rows in the sidebar tree and the
 * home board all ask "is this session's agent running right now (and since
 * when)?", and a subscription beats drilling the set through every list
 * component (same pattern as time.ts).
 */
let busy: ReadonlyMap<string, number> = new Map()
/** How main knows each one is running (`BusySession.source`), same keys as `busy`. */
let sources: ReadonlyMap<string, BusySession['source']> = new Map()
/** The live turn behind each spawned entry (`BusySession.turnId`) — spawned keys only. */
let turns: ReadonlyMap<string, string> = new Map()
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function set(sessions: BusySession[]): void {
  // a turn ending is main's to judge (landed.ts mirrors what it decides)
  busy = new Map(sessions.map((s) => [s.id, s.startedAt]))
  sources = new Map(sessions.map((s) => [s.id, s.source]))
  turns = new Map(
    sessions.flatMap((s): [string, string][] =>
      s.source === 'spawned' && s.turnId !== null ? [[s.id, s.turnId]] : []
    )
  )
  listeners.forEach((l) => l())
}

/** Seed from main and follow pushes; returns the unsubscribe (App's mount effect). */
export function initBusySessions(): () => void {
  void api.getBusySessions().then(set)
  return api.onBusySessions(set)
}

/** True while a provider process is running for this session id. */
export function useSessionBusy(id: string): boolean {
  return useSyncExternalStore(subscribe, () => busy.has(id))
}

/**
 * True while the session's agent runs somewhere Cockpit did not start it — a terminal
 * or the provider's own app — as main's liveness tracker reads off its log. Never true
 * for a turn Cockpit is running itself: the spawned entry wins a shared id.
 */
export function useSessionRunsElsewhere(id: string | null): boolean {
  return useSyncExternalStore(subscribe, () => id !== null && sources.get(id) === 'observed')
}

/**
 * The turn Cockpit is running for this session right now, or null. Read once, as a
 * session opens — not a hook: a window that left the conversation mid-turn (another
 * session, back/forward, a reload) rejoins the turn under this id rather than showing
 * the chat idle, and one that never left has the turn already.
 */
export function spawnedTurn(id: string): string | null {
  return turns.get(id) ?? null
}

/** The whole busy map (id → turn start ms) — the board sorts and counts with it.
 *  The map reference only changes when the set changes, so the snapshot is stable. */
export function useBusyMap(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, () => busy)
}
