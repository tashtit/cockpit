import { ipcMain } from 'electron'
import { CH, PUSH } from '../../shared/contract'
import { loadConfig, setRoundtableArchived, setSessionsArchived, setStaleDays } from '../config'
import { deleteRoundtables, deleteSessions, removeWorktrees, stopProcesses, surveyCleanup } from '../cleanup'
import { DEFAULT_STALE_DAYS } from '../cleanup-core'
import type { Services } from '../services'
import { sendToWin } from '../window'
import { asIdList, asProcessTargets } from './guards'

/*
 * Cleanup: the cross-agent, cross-repo view of what has gone stale. Every input it acts
 * on is main-derived — session ids are re-looked-up in the index and their files
 * re-checked against the configured sources, and worktree paths are re-derived from git
 * before a single one is removed (see cleanup.ts).
 */

const staleDays = (): number => loadConfig().staleDays ?? DEFAULT_STALE_DAYS

export function registerCleanupHandlers(s: Services): void {
  const { indexer, cleanupDeps } = s

  ipcMain.handle(CH.cleanupStaleDays, () => staleDays())
  ipcMain.handle(CH.cleanupSetStaleDays, (_e, days: number) => {
    setStaleDays(Number(days))
  })
  ipcMain.handle(CH.cleanupScan, async () => {
    const { report, ready } = await surveyCleanup(cleanupDeps(), staleDays())
    // the view's own scans count as the person looking
    s.reminder.seen(ready)
    return report
  })
  ipcMain.handle(CH.cleanupArchiveSessions, (_e, ids: string[]) => {
    // the reversible tier: config only, nothing on disk is touched
    const known = new Set(indexer.cleanupSessions().map((x) => x.id))
    const wanted = asIdList(ids).filter((id) => known.has(id))
    indexer.setArchived(setSessionsArchived(wanted, true))
    return { cleaned: wanted.length, freedBytes: 0, failed: [] }
  })
  ipcMain.handle(CH.cleanupDeleteSessions, async (_e, ids: string[]) => {
    // the same threshold the scan used, so the cascade can only take worktrees the
    // user was actually shown as going with these sessions
    const { deletedIds, ...result } = await deleteSessions(cleanupDeps(), asIdList(ids), staleDays())
    // an archived id whose file is gone is dead config — drop it, then re-index so
    // the tree stops offering sessions that no longer exist. Only those: a session
    // the delete refused (running, outside a source) is still there, still archived.
    indexer.setArchived(setSessionsArchived(deletedIds, false))
    await indexer.rescan()
    return result
  })
  ipcMain.handle(CH.cleanupDeleteRoundtables, async (_e, ids: string[]) => {
    const { deletedIds, ...result } = await deleteRoundtables(cleanupDeps(), asIdList(ids), staleDays())
    // the archived flags of tables that no longer exist are dead config — and only
    // theirs: a table the delete refused is still there, still archived
    for (const id of deletedIds) setRoundtableArchived(id, false)
    s.tables.setArchived(loadConfig().archivedRoundtables ?? [])
    // seat logs went with them — the tree must stop offering those sessions
    await indexer.rescan()
    sendToWin(PUSH.indexUpdated)
    return result
  })
  ipcMain.handle(CH.cleanupRemoveWorktrees, async (_e, paths: string[]) => {
    const result = await removeWorktrees(cleanupDeps(), asIdList(paths))
    await indexer.rescan()
    return result
  })
  ipcMain.handle(CH.cleanupStopProcesses, (_e, targets: unknown) =>
    // re-judged in stopProcesses: only a process still left in an old worktree, and
    // still the one that was picked (command + start time), is signalled
    stopProcesses(cleanupDeps(), asProcessTargets(targets), staleDays())
  )
}
