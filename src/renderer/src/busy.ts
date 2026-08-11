import { useSyncExternalStore } from 'react'
import { api } from './api'

/**
 * Tiny shared store for live session status: rows in the sidebar tree and the
 * home recent list all ask "is this session's agent running right now?", and a
 * subscription beats drilling the set through every list component (same
 * pattern as time.ts).
 */
let busy: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function set(ids: string[]): void {
  busy = new Set(ids)
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
