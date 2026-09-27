import { useSyncExternalStore } from 'react'
import { subscribers } from './subscribers'

/**
 * A preference remembered for this machine — a width the person dragged, how a diff
 * reads, which families are folded. A view preference suits this screen and this
 * reader rather than every Mac the config travels to, so it lives in localStorage
 * rather than in config.
 *
 * Storage is anyone's to write (a devtools console, another build, a hand edit), so
 * what it holds goes through `parse` and anything else is the fallback. It can also
 * refuse access outright — every read and write here is guarded, because a store read
 * as a module loads runs before any error boundary exists, and a throw there is a blank
 * window. A value storage refused to save still holds for this run.
 *
 * Storage is read on every snapshot and parsed only when its text changed, so a value
 * built fresh from it (a Set, a record) keeps its identity for `useSyncExternalStore`.
 */
type StoredValue<T> = {
  /** The value, re-rendering on every change — a hook */
  readonly use: () => T
  /** The value now, outside render: a form's starting point, a one-off check */
  readonly get: () => T
  readonly set: (value: T) => void
  /** Tests only: drop what this run holds and read storage again */
  readonly reload: () => void
}

type StoredFormat<T> = {
  /** The stored text as a value, or undefined when it is not one this preference takes */
  readonly parse: (raw: string) => T | undefined
  /** The value as stored text; null removes the key */
  readonly serialize: (value: T) => string | null
  /** The preference with nothing usable stored */
  readonly fallback: T
}

export function storedValue<T>(key: string, { parse, serialize, fallback }: StoredFormat<T>): StoredValue<T> {
  const changes = subscribers()
  /** Text storage refused to save (null: a removal it refused) — it still holds for this run */
  let unsaved: string | null | undefined
  let parsedFrom: string | null | undefined
  let parsed: T = fallback

  const text = (): string | null => {
    if (unsaved !== undefined) return unsaved
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  }
  const get = (): T => {
    const raw = text()
    if (raw !== parsedFrom) {
      parsedFrom = raw
      parsed = fallback
      if (raw !== null) {
        try {
          const v = parse(raw)
          if (v !== undefined) parsed = v
        } catch {
          // a hand-mangled value is no value: the fallback
        }
      }
    }
    return parsed
  }

  return {
    use: () => useSyncExternalStore(changes.subscribe, get),
    get,
    set: (value) => {
      const next = serialize(value)
      try {
        if (next === null) window.localStorage.removeItem(key)
        else window.localStorage.setItem(key, next)
        unsaved = undefined
      } catch {
        unsaved = next
      }
      changes.notify()
    },
    reload: () => {
      unsaved = undefined
      changes.notify()
    }
  }
}
