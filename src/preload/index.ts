import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { CH, PUSH } from '../shared/contract'
import { clampZoom } from '../shared/window'
import type { CockpitApi } from '../shared/contract'
import type {
  AttentionFocus,
  AttentionPrefs,
  AttentionTarget,
  BusySession,
  ChatEvent,
  ChatRequest,
  CleanupNotice,
  DiffScope,
  NewModelEndpoint,
  NewRoundtableRequest,
  Provider,
  RoundtableEvent,
  RoundtableLimits,
  RoundtableSendOptions,
  Landing,
  PanelTarget,
  ProcessTarget,
  SessionQuery,
  TimeFormat,
  TranscriptSearchQuery,
  NewAcpAgent,
  UpdateInstallRequest,
  UpdateState
} from '../shared/types'

const api: CockpitApi = {
  sendChat: (req: ChatRequest) => ipcRenderer.invoke(CH.chatSend, req),
  cancelChat: (turnId: string) => ipcRenderer.invoke(CH.chatCancel, turnId),
  respondPermission: (turnId: string, requestId: string, optionId: string) =>
    ipcRenderer.invoke(CH.chatRespondPermission, turnId, requestId, optionId),
  saveChatImage: (data: Uint8Array, mime: string) =>
    ipcRenderer.invoke(CH.chatSaveImage, data, mime),
  onChatEvent: (cb: (ev: ChatEvent) => void) => {
    const handler = (_e: unknown, ev: ChatEvent): void => cb(ev)
    ipcRenderer.on(PUSH.chatEvent, handler)
    return () => ipcRenderer.removeListener(PUSH.chatEvent, handler)
  },
  getSources: () => ipcRenderer.invoke(CH.sourcesGet),
  getSourceStats: () => ipcRenderer.invoke(CH.sourcesStats),
  pickDirectory: () => ipcRenderer.invoke(CH.sourcesPickDir),
  addSource: (path: string, provider: Provider, label: string) =>
    ipcRenderer.invoke(CH.sourcesAdd, path, provider, label),
  removeSource: (path: string) => ipcRenderer.invoke(CH.sourcesRemove, path),
  listRepos: () => ipcRenderer.invoke(CH.reposList),
  whenIndexed: () => ipcRenderer.invoke(CH.indexScanned),
  pageSessions: (query: SessionQuery) => ipcRenderer.invoke(CH.sessionsPage, query),
  getSession: (sessionId: string) => ipcRenderer.invoke(CH.sessionsGet, sessionId),
  getSessionMessages: (id: string) => ipcRenderer.invoke(CH.sessionsMessages, id),
  readSessionFile: (sessionId: string, path: string) => ipcRenderer.invoke(CH.sessionsFile, sessionId, path),
  openSessionFile: (sessionId: string, path: string, how: 'open' | 'reveal') =>
    ipcRenderer.invoke(CH.sessionsOpenFile, sessionId, path, how),
  searchTranscripts: (query: TranscriptSearchQuery) =>
    ipcRenderer.invoke(CH.transcriptsSearch, query),
  cancelTranscriptSearch: () => ipcRenderer.invoke(CH.transcriptsCancel),
  getHandoffBriefing: (sessionId: string) => ipcRenderer.invoke(CH.handoffBriefing, sessionId),
  improveHandoffBriefing: (sessionId: string) => ipcRenderer.invoke(CH.handoffImprove, sessionId),
  getBusySessions: () => ipcRenderer.invoke(CH.sessionsBusy),
  onBusySessions: (cb: (sessions: BusySession[]) => void) => {
    const handler = (_e: unknown, sessions: BusySession[]): void => cb(sessions)
    ipcRenderer.on(PUSH.busySessions, handler)
    return () => ipcRenderer.removeListener(PUSH.busySessions, handler)
  },
  getAttentionPrefs: () => ipcRenderer.invoke(CH.attentionPrefs),
  setAttentionPrefs: (prefs: AttentionPrefs) => ipcRenderer.invoke(CH.attentionSetPrefs, prefs),
  testNotification: () => ipcRenderer.invoke(CH.attentionTest),
  setAttentionFocus: (focus: AttentionFocus) => ipcRenderer.invoke(CH.attentionFocus, focus),
  getLandings: () => ipcRenderer.invoke(CH.attentionLandings),
  onLandings: (cb: (landings: Landing[]) => void) => {
    const handler = (_e: unknown, landings: Landing[]): void => cb(landings)
    ipcRenderer.on(PUSH.landings, handler)
    return () => ipcRenderer.removeListener(PUSH.landings, handler)
  },
  onAttentionOpen: (cb: (target: AttentionTarget) => void) => {
    const handler = (_e: unknown, target: AttentionTarget): void => cb(target)
    ipcRenderer.on(PUSH.attentionOpen, handler)
    return () => ipcRenderer.removeListener(PUSH.attentionOpen, handler)
  },
  takeAttentionOpen: () => ipcRenderer.invoke(CH.attentionTakeOpen),
  getCleanupNotice: () => ipcRenderer.invoke(CH.attentionCleanup),
  onCleanupNotice: (cb: (notice: CleanupNotice | null) => void) => {
    const handler = (_e: unknown, notice: CleanupNotice | null): void => cb(notice)
    ipcRenderer.on(PUSH.cleanupNotice, handler)
    return () => ipcRenderer.removeListener(PUSH.cleanupNotice, handler)
  },
  setArchived: (sessionId: string, archived: boolean) =>
    ipcRenderer.invoke(CH.sessionsArchive, sessionId, archived),
  setRepoHidden: (repoKey: string, hidden: boolean) =>
    ipcRenderer.invoke(CH.reposSetHidden, repoKey, hidden),
  setRepoOrder: (repoKeys: readonly string[]) => ipcRenderer.invoke(CH.reposSetOrder, [...repoKeys]),
  getHistoryDays: () => ipcRenderer.invoke(CH.historyGet),
  setHistoryDays: (days: number) => ipcRenderer.invoke(CH.historySet, days),
  getTimeFormat: () => ipcRenderer.invoke(CH.timeFormatGet),
  setTimeFormat: (format: TimeFormat) => ipcRenderer.invoke(CH.timeFormatSet, format),
  getStaleDays: () => ipcRenderer.invoke(CH.cleanupStaleDays),
  setStaleDays: (days: number) => ipcRenderer.invoke(CH.cleanupSetStaleDays, days),
  scanCleanup: () => ipcRenderer.invoke(CH.cleanupScan),
  archiveSessions: (ids: readonly string[]) => ipcRenderer.invoke(CH.cleanupArchiveSessions, ids),
  deleteSessions: (ids: readonly string[]) => ipcRenderer.invoke(CH.cleanupDeleteSessions, ids),
  deleteRoundtables: (ids: readonly string[]) =>
    ipcRenderer.invoke(CH.cleanupDeleteRoundtables, ids),
  removeWorktrees: (paths: readonly string[]) =>
    ipcRenderer.invoke(CH.cleanupRemoveWorktrees, paths),
  stopProcesses: (targets: readonly ProcessTarget[]) =>
    ipcRenderer.invoke(CH.cleanupStopProcesses, targets),
  getPrs: (repoRoot: string) => ipcRenderer.invoke(CH.githubPrs, repoRoot),
  getDefaultBranch: (repoRoot: string) => ipcRenderer.invoke(CH.githubDefaultBranch, repoRoot),
  createWorkspace: (repoRoot: string, name?: string) =>
    ipcRenderer.invoke(CH.workspaceCreate, repoRoot, name),
  createPr: (cwd: string) => ipcRenderer.invoke(CH.workspacePr, cwd),
  getWorkspaceDiff: (cwd: string, scope: DiffScope) => ipcRenderer.invoke(CH.workspaceDiff, cwd, scope),
  getPrFeedback: (repoRoot: string, prNumber: number) =>
    ipcRenderer.invoke(CH.githubPrFeedback, repoRoot, prNumber),
  getPrFixBriefing: (repoRoot: string, prNumber: number) =>
    ipcRenderer.invoke(CH.githubPrFix, repoRoot, prNumber),
  getExtensions: () => ipcRenderer.invoke(CH.extensionsGet),
  checkMcp: (name: string) => ipcRenderer.invoke(CH.extensionsCheckMcp, name),
  loginMcp: (name: string, agent: Provider, projectPath?: string) =>
    ipcRenderer.invoke(CH.extensionsLoginMcp, name, agent, projectPath),
  mcpVersions: (repoRoot: string | null) => ipcRenderer.invoke(CH.extensionsMcpVersions, repoRoot),
  setMcpVersion: (target: PanelTarget, version: string) =>
    ipcRenderer.invoke(CH.extensionsSetMcpVersion, target, version),
  getPanel: (repoRoot: string | null) => ipcRenderer.invoke(CH.panelGet, repoRoot),
  setPanelSwitch: (target: PanelTarget, agent: Provider, on: boolean) =>
    ipcRenderer.invoke(CH.panelSetSwitch, target, agent, on),
  keepPanelDifference: (target: PanelTarget, keep: boolean) =>
    ipcRenderer.invoke(CH.panelKeep, target, keep),
  matchPanelEntry: (target: PanelTarget, source: Provider) =>
    ipcRenderer.invoke(CH.panelMatch, target, source),
  removePanelEntry: (target: PanelTarget) => ipcRenderer.invoke(CH.panelRemove, target),
  restorePanelEntry: (target: PanelTarget) => ipcRenderer.invoke(CH.panelRestore, target),
  getInstructions: (repoRoot: string | null) => ipcRenderer.invoke(CH.instructionsGet, repoRoot),
  saveInstructionsBaseline: (repoRoot: string | null, baseline: string) =>
    ipcRenderer.invoke(CH.instructionsSaveBaseline, repoRoot, baseline),
  applyInstructions: (repoRoot: string | null, onlyPath?: string) =>
    ipcRenderer.invoke(CH.instructionsApply, repoRoot, onlyPath),
  saveInstructionFile: (repoRoot: string | null, path: string, content: string) =>
    ipcRenderer.invoke(CH.instructionsSaveFile, repoRoot, path, content),
  adoptInstructionsFrom: (repoRoot: string | null, path: string) =>
    ipcRenderer.invoke(CH.instructionsAdoptFile, repoRoot, path),
  shareInstructions: (repoRoot: string) => ipcRenderer.invoke(CH.instructionsShare, repoRoot),
  getAccounts: () => ipcRenderer.invoke(CH.accountsGet),
  openSignIn: (provider: Provider, configDir?: string) =>
    ipcRenderer.invoke(CH.accountsLogin, provider, configDir),
  listCliStatus: (force?: boolean) => ipcRenderer.invoke(CH.cliStatus, force),
  openCliUpdate: (provider: Provider) => ipcRenderer.invoke(CH.cliUpdate, provider),
  openCliUpdateHomebrew: (providers: readonly Provider[]) =>
    ipcRenderer.invoke(CH.cliUpdateHomebrew, providers),
  openCliChannelRefresh: (provider: Provider) =>
    ipcRenderer.invoke(CH.cliRefreshChannel, provider),
  signInState: (provider: Provider, configDir?: string) =>
    ipcRenderer.invoke(CH.accountsSignIn, provider, configDir),
  listAgentModels: (provider: Provider, configDir?: string) =>
    ipcRenderer.invoke(CH.accountsModels, provider, configDir),
  getUsage: () => ipcRenderer.invoke(CH.usageGet),
  getModelEndpoints: () => ipcRenderer.invoke(CH.endpointsGet),
  addModelEndpoint: (ep: NewModelEndpoint) => ipcRenderer.invoke(CH.endpointsAdd, ep),
  removeModelEndpoint: (id: string) => ipcRenderer.invoke(CH.endpointsRemove, id),
  setEndpointKey: (id: string, apiKey: string) => ipcRenderer.invoke(CH.endpointsSetKey, id, apiKey),
  listEndpointModels: (id: string) => ipcRenderer.invoke(CH.endpointsModels, id),
  getAcpAgents: () => ipcRenderer.invoke(CH.acpGet),
  addAcpAgent: (agent: NewAcpAgent) => ipcRenderer.invoke(CH.acpAdd, agent),
  removeAcpAgent: (id: string) => ipcRenderer.invoke(CH.acpRemove, id),
  probeAcpAgent: (agent: NewAcpAgent) => ipcRenderer.invoke(CH.acpProbe, agent),
  exportBackup: (passphrase?: string) => ipcRenderer.invoke(CH.backupExport, passphrase),
  openBackup: () => ipcRenderer.invoke(CH.backupOpen),
  restoreBackup: (token: string, passphrase?: string) =>
    ipcRenderer.invoke(CH.backupRestore, token, passphrase),
  undoRestore: (undoId: string) => ipcRenderer.invoke(CH.backupUndoRestore, undoId),
  listRoundtables: () => ipcRenderer.invoke(CH.roundtableList),
  setRoundtableArchived: (id: string, archived: boolean) =>
    ipcRenderer.invoke(CH.roundtableArchive, id, archived),
  getRoundtable: (id: string) => ipcRenderer.invoke(CH.roundtableGet, id),
  createRoundtable: (req: NewRoundtableRequest) => ipcRenderer.invoke(CH.roundtableCreate, req),
  sendRoundtableMessage: (id: string, text: string, opts?: RoundtableSendOptions) =>
    ipcRenderer.invoke(CH.roundtableSend, id, text, opts),
  unqueueRoundtableMessage: (id: string) => ipcRenderer.invoke(CH.roundtableUnqueue, id),
  skipRoundtableSeat: (id: string, seat: number) => ipcRenderer.invoke(CH.roundtableSkip, id, seat),
  continueRoundtable: (id: string, seats?: readonly number[]) =>
    ipcRenderer.invoke(CH.roundtableContinue, id, seats),
  stopRoundtable: (id: string) => ipcRenderer.invoke(CH.roundtableStop, id),
  setRoundtableLimits: (id: string, limits: RoundtableLimits, maxRounds?: number) =>
    ipcRenderer.invoke(CH.roundtableSetLimits, id, limits, maxRounds),
  onRoundtableEvent: (cb: (ev: RoundtableEvent) => void) => {
    const handler = (_e: unknown, ev: RoundtableEvent): void => cb(ev)
    ipcRenderer.on(PUSH.roundtableEvent, handler)
    return () => ipcRenderer.removeListener(PUSH.roundtableEvent, handler)
  },
  getProfile: () => ipcRenderer.invoke(CH.profileGet),
  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor: number) => webFrame.setZoomFactor(clampZoom(factor)),
  reportZoom: (factor: number) => ipcRenderer.invoke(CH.windowZoom, factor),
  openExternal: (url: string) => ipcRenderer.invoke(CH.shellOpen, url),
  onIndexUpdated: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on(PUSH.indexUpdated, handler)
    return () => ipcRenderer.removeListener(PUSH.indexUpdated, handler)
  },
  getAppInfo: () => ipcRenderer.invoke(CH.appInfo),
  openLicenseNotices: () => ipcRenderer.invoke(CH.appOpenLicenses),
  getUpdateState: () => ipcRenderer.invoke(CH.updatesGet),
  checkForUpdates: () => ipcRenderer.invoke(CH.updatesCheck),
  downloadUpdate: () => ipcRenderer.invoke(CH.updatesDownload),
  installUpdate: (req?: UpdateInstallRequest) => ipcRenderer.invoke(CH.updatesInstall, req),
  getUpdatePrefs: () => ipcRenderer.invoke(CH.updatesPrefs),
  setUpdatePrefs: (prefs) => ipcRenderer.invoke(CH.updatesSetPrefs, prefs),
  onUpdateState: (cb: (state: UpdateState) => void) => {
    const handler = (_e: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on(PUSH.updateState, handler)
    return () => ipcRenderer.removeListener(PUSH.updateState, handler)
  }
}

contextBridge.exposeInMainWorld('cockpit', api)
