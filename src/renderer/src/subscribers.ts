/**
 * Who to tell when a module store changes — the `subscribe` half `useSyncExternalStore`
 * takes, and the call that tells them. Every store the renderer keeps outside React (a
 * stored preference, the clock format, the busy set, the landings) holds one.
 */
export type Subscribers = {
  readonly subscribe: (cb: () => void) => () => void
  readonly notify: () => void
}

export function subscribers(): Subscribers {
  const listeners = new Set<() => void>()
  return {
    subscribe: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    notify: () => listeners.forEach((l) => l())
  }
}
