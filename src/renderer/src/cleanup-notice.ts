import { useEffect, useState } from 'react'
import type { CleanupNotice } from '../../shared/types'
import { api } from './api'

/**
 * The cleanup reminder, as the sidebar's Cleanup key carries it. Main runs the check
 * once a day and owns whether a reminder is unseen (`attention-core.ts`) — opening
 * Cleanup clears it there, and the push brings the null back here.
 */
export function useCleanupNotice(): CleanupNotice | null {
  const [notice, setNotice] = useState<CleanupNotice | null>(null)
  useEffect(() => {
    let live = true
    // a push that beats the seed is newer than it — the seed must not overwrite it
    let pushed = false
    void api.getCleanupNotice().then((n) => {
      if (live && !pushed) setNotice(n)
    })
    const off = api.onCleanupNotice((n) => {
      pushed = true
      setNotice(n)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return notice
}
