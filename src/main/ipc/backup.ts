import { app, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SourceDir } from '../../shared/types'
import { CH } from '../../shared/contract'
import { deleteEndpointKey, getEndpointKey, setEndpointKey } from '../secrets'
import {
  previewOf,
  readBackup,
  restoreBackup,
  undoRestore,
  writeBackup,
  type KeyStore
} from '../backup'
import type { Bundle } from '../backup-core'
import { resolveRepo } from '../repos'
import type { Services } from '../services'
import { currentWindow } from '../window'

/** Parsed files wait this long for a confirmed restore before they go stale. */
const BACKUP_TOKEN_TTL_MS = 10 * 60 * 1000

/** Backup: a file the user keeps, restorable here or on another Mac. */
export function registerBackupHandlers(s: Services): void {
  const { indexer } = s
  const keyStore: KeyStore = {
    get: (id) => getEndpointKey(id),
    set: (id, key) => setEndpointKey(id, key),
    remove: (id) => deleteEndpointKey(id)
  }
  /** The indexer's own repo key is the portable one — `gh:owner/repo`, else the root. */
  const refFor = (repoRoot: string): string => {
    const fullName = resolveRepo(repoRoot)?.repo.fullName
    return fullName ? `gh:${fullName.toLowerCase()}` : repoRoot
  }
  /**
   * Every repo the index has ever seen, not just the ones the history window shows:
   * a machine set up from a backup has old sessions, and a repo hidden behind the
   * window would otherwise look like it isn't here at all.
   */
  const knownRepos = (): ReadonlyMap<string, string> => {
    const map = new Map<string, string>()
    for (const session of indexer.allSessions()) {
      if (session.repo?.root && !map.has(session.repo.key)) map.set(session.repo.key, session.repo.root)
    }
    return map
  }
  const restoreDeps = {
    keys: keyStore,
    knownRepos,
    syncSources: (sources: readonly SourceDir[]) => indexer.setSources([...sources])
  }
  /** Parsed files waiting for a confirmed restore — one slot, and it goes stale. */
  const pendingBackups = new Map<string, { bundle: Bundle; at: number }>()
  const takePending = (token: string): Bundle => {
    const found = pendingBackups.get(String(token))
    if (!found || Date.now() - found.at > BACKUP_TOKEN_TTL_MS) {
      pendingBackups.delete(String(token))
      throw new Error('that backup is no longer open — choose the file again')
    }
    return found.bundle
  }

  ipcMain.handle(CH.backupExport, async (_e, passphrase?: string) => {
    // main-process dialog: the renderer never supplies a path, it receives one
    const options: Electron.SaveDialogOptions = {
      title: 'Export Cockpit backup',
      defaultPath: join(app.getPath('downloads'), `cockpit-backup-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'Cockpit backup', extensions: ['json'] }]
    }
    const win = currentWindow()
    const res = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options))
    if (res.canceled || !res.filePath) return null
    return writeBackup(
      res.filePath,
      { keys: keyStore, refFor, appVersion: app.getVersion() },
      passphrase === undefined ? undefined : String(passphrase)
    )
  })
  ipcMain.handle(CH.backupOpen, async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Restore from a Cockpit backup',
      defaultPath: app.getPath('downloads'),
      filters: [{ name: 'Cockpit backup', extensions: ['json'] }],
      properties: ['openFile']
    }
    const win = currentWindow()
    const res = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    if (res.canceled || res.filePaths.length === 0) return null
    const bundle = readBackup(res.filePaths[0])
    const token = randomUUID()
    pendingBackups.clear()
    pendingBackups.set(token, { bundle, at: Date.now() })
    return previewOf(bundle, token, knownRepos())
  })
  ipcMain.handle(CH.backupRestore, async (_e, token: string, passphrase?: string) => {
    const bundle = takePending(token)
    const summary = await restoreBackup(
      bundle,
      restoreDeps,
      passphrase === undefined ? undefined : String(passphrase)
    )
    // a wrong passphrase throws before this line, so the file stays open to retry
    pendingBackups.delete(String(token))
    s.republishConfig()
    return summary
  })
  ipcMain.handle(CH.backupUndoRestore, (_e, undoId: string) => {
    undoRestore(String(undoId), keyStore)
    s.republishConfig()
  })
}
