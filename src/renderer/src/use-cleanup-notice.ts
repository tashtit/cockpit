import { useEffect, useState } from 'react'
import type { CleanupNotice } from '../../shared/types'
import { api } from './api'
import { seedThenFollow } from './seed-then-follow'

/**
 * The cleanup reminder, as the sidebar's Cleanup key carries it. Main runs the check
 * once a day and owns whether a reminder is unseen (`attention-core.ts`) — opening
 * Cleanup clears it there, and the push brings the null back here.
 */
export function useCleanupNotice(): CleanupNotice | null {
  const [notice, setNotice] = useState<CleanupNotice | null>(null)
  useEffect(
    () =>
      seedThenFollow(
        () => api.getCleanupNotice(),
        (on) => api.onCleanupNotice(on),
        setNotice
      ),
    []
  )
  return notice
}
