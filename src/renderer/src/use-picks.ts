import { useCallback, useRef, useState } from 'react'

export type Picks = {
  readonly picked: ReadonlySet<string>
  /** Toggle one row; `range` extends from the last row touched (shift-click) */
  readonly toggle: (index: number, on: boolean, range: boolean) => void
  readonly toggleAll: (on: boolean) => void
  readonly clear: () => void
  /** Selected rows the current filter actually shows */
  readonly shown: number
  readonly selectable: number
}

/**
 * Selection over the *filtered* rows, which is what makes "filter, then select
 * all" work: the master toggle only ever reaches what is on screen, while
 * selections made under a previous filter survive (and are disclosed as hidden).
 * Blocked rows are never selectable — not by click, not by range, not by the
 * master toggle — so nothing can be armed that main would only refuse.
 */
export function usePicks<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  blocked: (row: T) => boolean
): Picks {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<number | null>(null)

  const toggle = useCallback(
    (index: number, on: boolean, range: boolean): void => {
      // read the anchor here, not inside the updater: the updater runs during the
      // next render, by which point `anchor.current` is already this row and every
      // range would collapse to a single one
      const from = range && anchor.current !== null ? Math.min(anchor.current, index) : index
      const to = range && anchor.current !== null ? Math.max(anchor.current, index) : index
      anchor.current = index
      setPicked((prev) => {
        const next = new Set(prev)
        for (let i = from; i <= to; i++) {
          const row = rows[i]
          if (!row || blocked(row)) continue
          if (on) next.add(keyOf(row))
          else next.delete(keyOf(row))
        }
        return next
      })
    },
    [rows, keyOf, blocked]
  )

  const toggleAll = useCallback(
    (on: boolean): void => {
      setPicked((prev) => {
        const next = new Set(prev)
        for (const row of rows) {
          if (blocked(row)) continue
          if (on) next.add(keyOf(row))
          else next.delete(keyOf(row))
        }
        return next
      })
      anchor.current = null
    },
    [rows, keyOf, blocked]
  )

  const clear = useCallback((): void => {
    setPicked(new Set())
    anchor.current = null
  }, [])

  const selectable = rows.filter((r) => !blocked(r))
  return {
    picked,
    toggle,
    toggleAll,
    clear,
    shown: selectable.filter((r) => picked.has(keyOf(r))).length,
    selectable: selectable.length
  }
}
