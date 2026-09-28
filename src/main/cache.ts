/**
 * Answers remembered for a while, with the run in flight shared: a burst of callers
 * asking the same question — a picker opening, a panel of thirty rows, the sidebar's
 * badges refreshing — costs one run of whatever answers it (a CLI, a registry fetch, a
 * scan of thousands of files).
 *
 * An answer can also be forgotten, when something it reports on has just changed: a
 * write settled here makes whatever was gathered before it wrong. `forget` drops what
 * is remembered and marks the runs in flight stale — each still answers the callers
 * that asked it, but lands without being kept, so a gathering that started before the
 * write can never put the pre-write answer back.
 */

export type ThrottleOptions = {
  /** The clock, for tests */
  readonly now?: () => number
}

export type ThrottledByOptions<K> = ThrottleOptions & {
  /** What tells two keys apart; `String(key)` unless the key is a record */
  readonly keyOf?: (key: K) => string
}

/**
 * `force` starts a fresh run, whatever is remembered or in flight — a "check now".
 * `forget` makes the next call for `key` (every key when none is named) run afresh.
 */
export type ThrottledGet<K, T> = ((key: K, opts?: { readonly force?: boolean }) => Promise<T>) & {
  readonly forget: (key?: K) => void
}

/** A question with one answer: `throttledBy` without the key. */
export type Throttled<T> = (() => Promise<T>) & { readonly forget: () => void }

/**
 * Remember `compute`'s result per key for `ttlMs` after it lands, and coalesce the calls
 * for one key made while a run is in flight into that run. A rejected run is never
 * remembered — the next call simply tries again — so an answer meant to be kept through
 * a failure (a registry that could not be reached, kept as null for the hour) is one
 * `compute` resolves with rather than throws. Only the newest run for a key is
 * remembered: a forced run is never overwritten by an older one landing after it, and
 * a run started before a `forget` is never remembered at all.
 */
export function throttledBy<K, T>(
  ttlMs: number,
  compute: (key: K) => Promise<T>,
  opts: ThrottledByOptions<K> = {}
): ThrottledGet<K, T> {
  const now = opts.now ?? Date.now
  const keyOf = opts.keyOf ?? String
  // both mutate as runs start and land: a process-lifetime cache. A run is kept only
  // while it is still the one `inflight` holds for its key — forced past or forgotten,
  // it is not
  const last = new Map<string, { readonly at: number; readonly value: T }>()
  const inflight = new Map<string, Promise<T>>()
  const get = (key: K, { force = false }: { readonly force?: boolean } = {}): Promise<T> => {
    const k = keyOf(key)
    const hit = last.get(k)
    if (!force && hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value)
    const pending = inflight.get(k)
    if (!force && pending) return pending
    let started: Promise<T>
    try {
      started = compute(key)
    } catch (err) {
      started = Promise.reject(err)
    }
    const run: Promise<T> = started.then(
      (value) => {
        if (inflight.get(k) === run) {
          inflight.delete(k)
          last.set(k, { at: now(), value })
        }
        return value
      },
      (err: unknown) => {
        if (inflight.get(k) === run) inflight.delete(k)
        throw err
      }
    )
    inflight.set(k, run)
    return run
  }
  const forget = (key?: K): void => {
    if (key === undefined) {
      last.clear()
      inflight.clear()
      return
    }
    last.delete(keyOf(key))
    inflight.delete(keyOf(key))
  }
  return Object.assign(get, { forget })
}

/** throttledBy for a question with one answer. */
export function throttled<T>(ttlMs: number, compute: () => Promise<T>, opts: ThrottleOptions = {}): Throttled<T> {
  const get = throttledBy<null, T>(ttlMs, () => compute(), { ...opts, keyOf: () => '' })
  return Object.assign(() => get(null), { forget: () => get.forget() })
}
