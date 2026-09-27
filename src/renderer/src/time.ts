import { useSyncExternalStore } from 'react'
import type { TimeFormat } from '../../shared/types'
import { api } from './api'
import { subscribers } from './subscribers'

/**
 * Tiny shared store for the session-time clock format: SessionRow sits three
 * levels deep in the sidebar tree, so a subscription beats drilling the value
 * through every list component. Default matches the main process ('24h').
 * The times themselves are written by `fmtTime` in `format.ts`.
 */
let format: TimeFormat = '24h'
const changes = subscribers()

/** Pull the persisted format once at startup (App's mount effect). */
export async function initTimeFormat(): Promise<void> {
  format = await api.getTimeFormat()
  changes.notify()
}

/** Live clock format — a Settings change re-renders every subscribed row. */
export function useTimeFormat(): TimeFormat {
  return useSyncExternalStore(changes.subscribe, () => format)
}

export function setTimeFormat(f: TimeFormat): void {
  format = f
  changes.notify()
  void api.setTimeFormat(f)
}
