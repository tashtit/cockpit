import { dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type {
  BusySession,
  Provider,
  SessionQuery,
  TimeFormat,
  TranscriptSearchQuery
} from '../../shared/types'
import { CH } from '../../shared/contract'
import { AGENT_NAME, isProvider } from '../../shared/providers'
import {
  bindSessionControl,
  loadConfig,
  saveConfig,
  setHistoryDays,
  setRepoHidden,
  setRepoOrder,
  setSessionArchived,
  setTimeFormat,
  sourceFor
} from '../config'
import { isValidNativeId } from '../chat'
import { defaultConfigHome } from '../paths'
import { holdRefusal, resumeLine, resumeScript, type ControlEntry } from '../session-control-core'
import { assertSharedFile, openSharedFile, readSharedFile } from '../session-files'
import { getHandoffBriefing, improveHandoffBriefing } from '../handoff'
import type { Services } from '../services'
import { currentWindow } from '../window'
import { knownSession } from './guards'
import { openScript } from './terminal'

/** The session index: sources, repos, pages, one session's log and files, who holds it. */
export function registerSessionHandlers(s: Services): void {
  const { indexer, transcripts } = s

  /** Where a turn runs in this session right now, if one does (the merged busy set). */
  const runningWhere = (sessionId: string): BusySession['source'] | null =>
    s.busySessions().find((b) => b.id === sessionId)?.source ?? null

  ipcMain.handle(CH.sourcesGet, () => loadConfig().sources)
  ipcMain.handle(CH.sourcesStats, () => indexer.sourceStats(loadConfig().sources))
  ipcMain.handle(CH.sourcesPickDir, async () => {
    // main-process dialog: the renderer never supplies a path, it receives one
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a config home to index',
      defaultPath: homedir(),
      properties: ['openDirectory', 'showHiddenFiles']
    }
    const win = currentWindow()
    const res = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options))
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })
  ipcMain.handle(CH.sourcesAdd, (_e, path: string, provider: Provider, label: string) => {
    // renderer args are untrusted — an unknown provider would crash the next scan
    if (!isProvider(provider)) {
      throw new Error(`Unknown provider: ${String(provider)}`)
    }
    const p = resolve(String(path))
    if (!existsSync(p) || !statSync(p).isDirectory()) {
      throw new Error(`Not a directory: ${p}`)
    }
    const cfg = loadConfig()
    if (cfg.sources.some((x) => x.path === p)) return cfg.sources
    const sources = [...cfg.sources, { path: p, provider, label }]
    saveConfig({ ...cfg, sources })
    void indexer.setSources(sources)
    return sources
  })
  ipcMain.handle(CH.sourcesRemove, (_e, path: string) => {
    const cfg = loadConfig()
    const sources = cfg.sources.filter((x) => x.path !== path)
    saveConfig({ ...cfg, sources })
    void indexer.setSources(sources)
    return sources
  })

  ipcMain.handle(CH.reposList, () => indexer.listRepos())
  ipcMain.handle(CH.reposSetHidden, (_e, key: string, hidden: boolean) => {
    indexer.setHiddenRepos(setRepoHidden(String(key), Boolean(hidden)))
  })
  ipcMain.handle(CH.reposSetOrder, (_e, keys: unknown) => {
    // a plain list of keys — only reorders what the indexer already lists
    const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
    indexer.setRepoOrder(setRepoOrder(list.slice(0, 2000)))
  })
  ipcMain.handle(CH.indexScanned, () => indexer.whenScanned())
  ipcMain.handle(CH.historyGet, () => loadConfig().historyDays ?? 0)
  ipcMain.handle(CH.historySet, (_e, days: number) => {
    indexer.setHistoryDays(setHistoryDays(Number(days)))
  })
  ipcMain.handle(CH.timeFormatGet, () => loadConfig().timeFormat ?? '24h')
  ipcMain.handle(CH.timeFormatSet, (_e, format: TimeFormat) => {
    setTimeFormat(format)
  })

  ipcMain.handle(CH.sessionsPage, (_e, query: SessionQuery) => indexer.page(query))
  ipcMain.handle(CH.sessionsGet, (_e, id: string) => indexer.getSession(String(id)))
  ipcMain.handle(CH.sessionsMessages, (_e, id: string) => indexer.getMessages(id))
  ipcMain.handle(CH.sessionsBusy, () => s.busySessions())
  ipcMain.handle(CH.sessionsArchive, (_e, id: string, archived: boolean) => {
    indexer.setArchived(setSessionArchived(id, archived))
  })
  // a file an agent shared: only one the session's own log names (assertSharedFile)
  ipcMain.handle(CH.sessionsFile, (_e, id: unknown, path: unknown) =>
    readSharedFile(assertSharedFile(indexer, id, path))
  )
  ipcMain.handle(CH.sessionsOpenFile, (_e, id: unknown, path: unknown, how: unknown) =>
    openSharedFile(assertSharedFile(indexer, id, path), how === 'reveal' ? 'reveal' : 'open', shell)
  )
  // taking a session over or releasing it back: Cockpit's own record, re-judged here
  // against the turn running in it, whatever the renderer believed when it asked
  ipcMain.handle(CH.sessionsSetHolder, (_e, id: unknown, holder: unknown) => {
    if (holder !== 'cockpit' && holder !== 'agent') throw new Error('unknown holder')
    const session = knownSession(indexer, id)
    const current = indexer.controlOf(session)
    if (current.holder === holder) return current
    const refusal = holdRefusal(holder, runningWhere(session.id))
    if (refusal) throw new Error(refusal)
    const entry: ControlEntry = { how: holder === 'cockpit' ? 'taken-over' : 'released', at: Date.now() }
    indexer.setControl(bindSessionControl(session.id, entry))
    return indexer.controlOf(session)
  })
  // a released session's way back to where it lives: its agent's own interactive CLI, in
  // the session's directory, as the account it was recorded under. Released first, so
  // Cockpit stops sending the moment the agent can
  ipcMain.handle(CH.sessionsResumeInTerminal, async (_e, id: unknown) => {
    const session = knownSession(indexer, id)
    if (!isValidNativeId(session.nativeId)) throw new Error("This session's id can't be resumed from a terminal.")
    if (!session.cwd || !existsSync(session.cwd)) {
      throw new Error('Its working directory is gone — there is nothing to resume it in.')
    }
    // a second interactive CLI beside a running turn — either side's — writes a second
    // turn into the same log
    const running = runningWhere(session.id)
    if (running) {
      throw new Error(
        running === 'spawned'
          ? 'Cockpit is running a turn in it — stop it, or let it finish, first.'
          : 'Its agent is working on it right now — open it once that turn ends.'
      )
    }
    // the config home the index found it under; the provider's default needs no variable
    const source = sourceFor(session)
    const home =
      source && resolve(source.path) !== defaultConfigHome(session.provider) ? resolve(source.path) : undefined
    const line = resumeLine(session.provider, session.nativeId, home)
    if (indexer.controlOf(session).holder === 'cockpit') {
      indexer.setControl(bindSessionControl(session.id, { how: 'released', at: Date.now() }))
    }
    await openScript(
      `resume-${session.provider}`,
      resumeScript(`Cockpit — resuming in ${AGENT_NAME[session.provider]}`, session.cwd, line)
    )
  })

  ipcMain.handle(CH.transcriptsSearch, (_e, query: TranscriptSearchQuery) => transcripts.search(query))
  ipcMain.handle(CH.transcriptsCancel, () => transcripts.cancel())

  ipcMain.handle(CH.handoffBriefing, (_e, id: string) => getHandoffBriefing(indexer, String(id)))
  ipcMain.handle(CH.handoffImprove, (_e, id: string) => {
    const sid = String(id)
    // improving resumes the session outside ChatManager — a second writer on a log a
    // turn is still writing, whether Cockpit runs that turn or a terminal does
    if (s.busySessions().some((b) => b.id === sid)) {
      throw new Error('This session has a turn running — let it finish, then improve the briefing.')
    }
    return improveHandoffBriefing(indexer, sid)
  })
}
