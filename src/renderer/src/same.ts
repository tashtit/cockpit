import { useRef } from 'react'

/**
 * Whether two values say the same thing: primitives by value, arrays and plain objects
 * by content. For what arrives over IPC — every answer is a fresh structured clone, so
 * identity says nothing about whether it changed, and a state update or a memoized
 * child keyed on identity alone redraws for every push. Plain data only: no cycles, no
 * class instances, no Maps.
 */
export function samePlain(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!samePlain(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  for (const k of ka) if (!Object.hasOwn(rb, k) || !samePlain(ra[k], rb[k])) return false
  return true
}

/** `next`, unless it says what `prev` already does — then `prev`, so React sees no change. */
export function keepSame<T>(prev: T, next: T): T {
  return samePlain(prev, next) ? prev : next
}

/**
 * The value, held at its first identity for as long as its content stays the same —
 * for a memo or an effect that must follow what a value says, not the array it came in.
 */
export function useSame<T>(value: T): T {
  const ref = useRef(value)
  if (ref.current !== value && !samePlain(ref.current, value)) ref.current = value
  return ref.current
}
