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
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function set(sessions: BusySession[]): void {
  busy = new Map(sessions.map((s) => [s.id, s.startedAt]))
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

/** The whole busy map (id → turn start ms) — the board sorts and counts with it.
 *  The map reference only changes when the set changes, so the snapshot is stable. */
export function useBusyMap(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, () => busy)
}
