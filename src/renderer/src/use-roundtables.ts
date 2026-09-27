import { useCallback, useEffect, useRef, useState } from 'react'
import type { RoundtableMeta } from '../../shared/types'
import { api } from './api'
import { keepSame } from './same'

/**
 * The roundtables, read on mount, on every index push and whenever a round starts or
 * ends elsewhere — for the tree, which files each under its project or Chats, and the
 * home board, which shows only the ones not archived (`activeOnly`).
 */
export function useRoundtables(
  indexVersion: number,
  { activeOnly = false }: { readonly activeOnly?: boolean } = {}
): RoundtableMeta[] {
  const [tables, setTables] = useState<RoundtableMeta[]>([])
  /** Only the newest answer lands: a slow list must not overwrite a later one */
  const tablesSeq = useRef(0)
  const loadTables = useCallback((): void => {
    const seq = ++tablesSeq.current
    void api.listRoundtables?.().then((r) => {
      if (seq === tablesSeq.current)
        setTables((prev) => keepSame(prev, activeOnly ? r.filter((t) => !t.archived) : r))
    })
  }, [activeOnly])
  useEffect(() => loadTables(), [indexVersion, loadTables])
  // subscribed once: an index push is a reason to read the list again, not to drop
  // the listener and add it back
  useEffect(() => {
    const unsub = api.onRoundtableEvent?.((ev) => {
      if (ev.type === 'round') loadTables()
    })
    return () => {
      tablesSeq.current++
      unsub?.()
    }
  }, [loadTables])
  return tables
}
