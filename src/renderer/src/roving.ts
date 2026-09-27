/**
 * Moving focus through a list with the keyboard — the tree's rows, a tab list, a filter
 * popover's options, a diff's note buttons. Each widget gathers its own items and says
 * which one has focus; this only says where a key lands, so the four agree on the
 * arithmetic while each keeps its own keys.
 */
export type RoveKeys = {
  /** The key that steps to the next item */
  readonly next: string
  /** The key that steps back */
  readonly prev: string
  /** Home and End jump to the first and last item */
  readonly ends?: boolean
  /** Stepping past either end comes round to the other, rather than stopping there */
  readonly wrap?: boolean
}

/** Where focus stands: the index of the focused item (−1 for none), among `count`. */
export type RovePlace = { readonly at: number; readonly count: number }

/** The index `key` moves focus to, or null for a key this set does not move on. */
export function roveIndex(key: string, { at, count }: RovePlace, keys: RoveKeys): number | null {
  if (keys.ends && key === 'Home') return 0
  if (keys.ends && key === 'End') return count - 1
  const step = key === keys.next ? 1 : key === keys.prev ? -1 : 0
  if (step === 0) return null
  return keys.wrap ? (at + step + count) % count : Math.min(Math.max(at + step, 0), count - 1)
}
