import { useEffect, useState, type DependencyList, type Dispatch, type SetStateAction } from 'react'
import { ipcErrorText } from './ipc-error'
import { keepSame as samePrev } from './same'

/** What a read from main came back with, and where it stands. */
export type Loaded<T> = {
  /** The latest answer, or the initial value until one lands */
  readonly value: T
  /** Replace the value — an action's own answer, an optimistic flip */
  readonly set: Dispatch<SetStateAction<T>>
  /** Why the latest read failed, in main's own words — until a read succeeds */
  readonly error: string | null
  /** For an action that reports on the same line as the read: its refusal, or a clear */
  readonly setError: Dispatch<SetStateAction<string | null>>
  /** A read is in flight — or about to be, from the first render */
  readonly loading: boolean
}

export type LoadOptions<I> = {
  /** The value before the first answer lands, and after a reset — null unless given */
  readonly initial?: I
  /** Hold the previous value's identity when the answer says the same (`same.ts`) */
  readonly keepSame?: boolean
  /** Back to `initial`, error cleared, whenever the deps change: a new subject, not a refresh */
  readonly reset?: boolean
}

/**
 * Read something from main, again whenever `deps` change, and hold what it said.
 *
 * Only the answer to the newest read lands: one that arrives after the deps moved on, or
 * after the component went, is dropped — a slow read of the last project must never
 * overwrite this one's. A refusal becomes text with Electron's IPC wrapper stripped
 * (`ipcErrorText`), and the value it failed to replace stays. `load` is null while there
 * is nothing to read (a closed row, a turn still running): the value stays as it was.
 *
 * `deps` works as an effect's does — the values `load` reads that should read again
 * when they change. `load` itself is a fresh closure every render and is not one.
 */
export function useLoaded<T, I = null>(
  load: (() => Promise<T>) | null,
  deps: DependencyList,
  { initial = null as I, keepSame = false, reset = false }: LoadOptions<I> = {}
): Loaded<T | I> {
  const [value, set] = useState<T | I>(initial)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(load !== null)

  useEffect(() => {
    if (reset) {
      set(initial)
      setError(null)
    }
    if (!load) return
    let live = true
    setLoading(true)
    load().then(
      (next) => {
        if (!live) return
        set((prev) => (keepSame ? samePrev<T | I>(prev, next) : next))
        setError(null)
        setLoading(false)
      },
      (err: unknown) => {
        if (!live) return
        setError(ipcErrorText(err))
        setLoading(false)
      }
    )
    return () => {
      live = false
    }
  }, deps)

  return { value, set, error, setError, loading }
}
