/**
 * The bridge: `window.cockpit`, exposed to the sandboxed renderer through contextBridge.
 * Each member is one `ipcRenderer.invoke` on its `CH` channel, or a `subscribe` to its
 * `PUSH` channel, typed by `CockpitApi` in `shared/contract.ts` — the one place the IPC
 * surface is declared. Nothing here validates: main treats every argument as untrusted.
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { CH, PUSH } from '../shared/contract'
import { clampZoom } from '../shared/window'
import type { CockpitApi, PushChannel } from '../shared/contract'

/**
 * A push channel as `CockpitApi` hands it to the renderer: subscribe with a callback, get
 * back the function that unsubscribes. Every member below is typed by `CockpitApi` itself,
 * which is why nothing here spells a parameter type.
 */
function subscribe<T>(channel: PushChannel): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    const handler = (_e: unknown, payload: T): void => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

const api: CockpitApi = {
  sendChat: (req) => ipcRenderer.invoke(CH.chatSend, req),
  cancelChat: (turnId) => ipcRenderer.invoke(CH.chatCancel, turnId),
  respondPermission: (turnId, requestId, optionId) =>
    ipcRenderer.invoke(CH.chatRespondPermission, turnId, requestId, optionId),
  getPendingPermissions: (turnId) => ipcRenderer.invoke(CH.chatPendingPermissions, turnId),
  saveChatImage: (data, mime) => ipcRenderer.invoke(CH.chatSaveImage, data, mime),
  onChatEvent: subscribe(PUSH.chatEvent),
  askSideChat: (req) => ipcRenderer.invoke(CH.sideChatAsk, req),
  cancelSideChat: (turnId) => ipcRenderer.invoke(CH.sideChatCancel, turnId),
  onSideChatEvent: subscribe(PUSH.sideChatEvent),
  getSources: () => ipcRenderer.invoke(CH.sourcesGet),
  getSourceStats: () => ipcRenderer.invoke(CH.sourcesStats),
  pickDirectory: () => ipcRenderer.invoke(CH.sourcesPickDir),
  addSource: (path, provider, label) => ipcRenderer.invoke(CH.sourcesAdd, path, provider, label),
  removeSource: (path) => ipcRenderer.invoke(CH.sourcesRemove, path),
  listRepos: () => ipcRenderer.invoke(CH.reposList),
  whenIndexed: () => ipcRenderer.invoke(CH.indexScanned),
  pageSessions: (query) => ipcRenderer.invoke(CH.sessionsPage, query),
  getSession: (sessionId) => ipcRenderer.invoke(CH.sessionsGet, sessionId),
  getSessionMessages: (id) => ipcRenderer.invoke(CH.sessionsMessages, id),
  readSessionFile: (sessionId, path) => ipcRenderer.invoke(CH.sessionsFile, sessionId, path),
  openSessionFile: (sessionId, path, how) =>
    ipcRenderer.invoke(CH.sessionsOpenFile, sessionId, path, how),
  setSessionHolder: (sessionId, holder) =>
    ipcRenderer.invoke(CH.sessionsSetHolder, sessionId, holder),
  resumeInTerminal: (sessionId) => ipcRenderer.invoke(CH.sessionsResumeInTerminal, sessionId),
  searchTranscripts: (query) => ipcRenderer.invoke(CH.transcriptsSearch, query),
  cancelTranscriptSearch: () => ipcRenderer.invoke(CH.transcriptsCancel),
  getHandoffBriefing: (sessionId) => ipcRenderer.invoke(CH.handoffBriefing, sessionId),
  improveHandoffBriefing: (sessionId) => ipcRenderer.invoke(CH.handoffImprove, sessionId),
  getBusySessions: () => ipcRenderer.invoke(CH.sessionsBusy),
  onBusySessions: subscribe(PUSH.busySessions),
  getAttentionPrefs: () => ipcRenderer.invoke(CH.attentionPrefs),
  setAttentionPrefs: (prefs) => ipcRenderer.invoke(CH.attentionSetPrefs, prefs),
  testNotification: () => ipcRenderer.invoke(CH.attentionTest),
  playSound: (tone) => ipcRenderer.invoke(CH.attentionPlay, tone),
  setAttentionFocus: (focus) => ipcRenderer.invoke(CH.attentionFocus, focus),
  getLandings: () => ipcRenderer.invoke(CH.attentionLandings),
  onLandings: subscribe(PUSH.landings),
  onAttentionOpen: subscribe(PUSH.attentionOpen),
  takeAttentionOpen: () => ipcRenderer.invoke(CH.attentionTakeOpen),
  getCleanupNotice: () => ipcRenderer.invoke(CH.attentionCleanup),
  onCleanupNotice: subscribe(PUSH.cleanupNotice),
  setArchived: (sessionId, archived) => ipcRenderer.invoke(CH.sessionsArchive, sessionId, archived),
  setRepoHidden: (repoKey, hidden) => ipcRenderer.invoke(CH.reposSetHidden, repoKey, hidden),
  setRepoOrder: (repoKeys) => ipcRenderer.invoke(CH.reposSetOrder, [...repoKeys]),
  getHistoryDays: () => ipcRenderer.invoke(CH.historyGet),
  setHistoryDays: (days) => ipcRenderer.invoke(CH.historySet, days),
  getTimeFormat: () => ipcRenderer.invoke(CH.timeFormatGet),
  setTimeFormat: (format) => ipcRenderer.invoke(CH.timeFormatSet, format),
  getStaleDays: () => ipcRenderer.invoke(CH.cleanupStaleDays),
  setStaleDays: (days) => ipcRenderer.invoke(CH.cleanupSetStaleDays, days),
  scanCleanup: () => ipcRenderer.invoke(CH.cleanupScan),
  archiveSessions: (ids) => ipcRenderer.invoke(CH.cleanupArchiveSessions, ids),
  deleteSessions: (ids) => ipcRenderer.invoke(CH.cleanupDeleteSessions, ids),
  deleteRoundtables: (ids) => ipcRenderer.invoke(CH.cleanupDeleteRoundtables, ids),
  removeWorktrees: (paths) => ipcRenderer.invoke(CH.cleanupRemoveWorktrees, paths),
  stopProcesses: (targets) => ipcRenderer.invoke(CH.cleanupStopProcesses, targets),
  getPrs: (repoRoot) => ipcRenderer.invoke(CH.githubPrs, repoRoot),
  getDefaultBranch: (repoRoot) => ipcRenderer.invoke(CH.githubDefaultBranch, repoRoot),
  createWorkspace: (repoRoot, name) => ipcRenderer.invoke(CH.workspaceCreate, repoRoot, name),
  getBranchPrefix: () => ipcRenderer.invoke(CH.workspaceBranchPrefix),
  setBranchPrefix: (prefix) => ipcRenderer.invoke(CH.workspaceSetBranchPrefix, prefix),
  createPr: (cwd) => ipcRenderer.invoke(CH.workspacePr, cwd),
  getWorkspaceDiff: (cwd, scope) => ipcRenderer.invoke(CH.workspaceDiff, cwd, scope),
  getPrFeedback: (repoRoot, prNumber) =>
    ipcRenderer.invoke(CH.githubPrFeedback, repoRoot, prNumber),
  getPrFixBriefing: (repoRoot, prNumber) => ipcRenderer.invoke(CH.githubPrFix, repoRoot, prNumber),
  getExtensions: () => ipcRenderer.invoke(CH.extensionsGet),
  checkMcp: (name) => ipcRenderer.invoke(CH.extensionsCheckMcp, name),
  loginMcp: (name, agent, projectPath) =>
    ipcRenderer.invoke(CH.extensionsLoginMcp, name, agent, projectPath),
  mcpVersions: (repoRoot) => ipcRenderer.invoke(CH.extensionsMcpVersions, repoRoot),
  setMcpVersion: (target, version) =>
    ipcRenderer.invoke(CH.extensionsSetMcpVersion, target, version),
  getPanel: (repoRoot) => ipcRenderer.invoke(CH.panelGet, repoRoot),
  setPanelSwitch: (target, agent, on) => ipcRenderer.invoke(CH.panelSetSwitch, target, agent, on),
  keepPanelDifference: (target, keep) => ipcRenderer.invoke(CH.panelKeep, target, keep),
  leavePanelOff: (target, agent) => ipcRenderer.invoke(CH.panelLeaveOff, target, agent),
  matchPanelEntry: (target, source) => ipcRenderer.invoke(CH.panelMatch, target, source),
  removePanelEntry: (target) => ipcRenderer.invoke(CH.panelRemove, target),
  restorePanelEntry: (target) => ipcRenderer.invoke(CH.panelRestore, target),
  listCatalogs: () => ipcRenderer.invoke(CH.marketplacesList),
  lookupMarketplace: (source) => ipcRenderer.invoke(CH.marketplacesLookup, source),
  addFromCatalog: (item, agent) => ipcRenderer.invoke(CH.marketplacesAdd, item, agent),
  searchMcpRegistry: (query, cursor) => ipcRenderer.invoke(CH.mcpRegistrySearch, query, cursor),
  addFromMcpRegistry: (req) => ipcRenderer.invoke(CH.mcpRegistryAdd, req),
  getUpdatesDigest: (force) => ipcRenderer.invoke(CH.updatesDigest, force),
  outdatedPlugins: () => ipcRenderer.invoke(CH.pluginsOutdated),
  updatePlugin: (id) => ipcRenderer.invoke(CH.pluginsUpdate, id),
  getInstructions: (repoRoot) => ipcRenderer.invoke(CH.instructionsGet, repoRoot),
  saveInstructionsBaseline: (repoRoot, baseline) =>
    ipcRenderer.invoke(CH.instructionsSaveBaseline, repoRoot, baseline),
  applyInstructions: (repoRoot, onlyPath) =>
    ipcRenderer.invoke(CH.instructionsApply, repoRoot, onlyPath),
  saveInstructionFile: (repoRoot, path, content) =>
    ipcRenderer.invoke(CH.instructionsSaveFile, repoRoot, path, content),
  adoptInstructionsFrom: (repoRoot, path) =>
    ipcRenderer.invoke(CH.instructionsAdoptFile, repoRoot, path),
  shareInstructions: (repoRoot) => ipcRenderer.invoke(CH.instructionsShare, repoRoot),
  getAccounts: () => ipcRenderer.invoke(CH.accountsGet),
  openSignIn: (provider, configDir) => ipcRenderer.invoke(CH.accountsLogin, provider, configDir),
  listCliStatus: (force) => ipcRenderer.invoke(CH.cliStatus, force),
  openCliUpdate: (provider) => ipcRenderer.invoke(CH.cliUpdate, provider),
  openCliUpdateHomebrew: (providers) => ipcRenderer.invoke(CH.cliUpdateHomebrew, providers),
  openCliChannelRefresh: (provider) => ipcRenderer.invoke(CH.cliRefreshChannel, provider),
  signInState: (provider, configDir) => ipcRenderer.invoke(CH.accountsSignIn, provider, configDir),
  listAgentModels: (provider, account) => ipcRenderer.invoke(CH.accountsModels, provider, account),
  getUsage: () => ipcRenderer.invoke(CH.usageGet),
  getModelEndpoints: () => ipcRenderer.invoke(CH.endpointsGet),
  addModelEndpoint: (ep) => ipcRenderer.invoke(CH.endpointsAdd, ep),
  removeModelEndpoint: (id) => ipcRenderer.invoke(CH.endpointsRemove, id),
  setEndpointKey: (id, apiKey) => ipcRenderer.invoke(CH.endpointsSetKey, id, apiKey),
  listEndpointModels: (id) => ipcRenderer.invoke(CH.endpointsModels, id),
  getAcpAgents: () => ipcRenderer.invoke(CH.acpGet),
  addAcpAgent: (agent) => ipcRenderer.invoke(CH.acpAdd, agent),
  removeAcpAgent: (id) => ipcRenderer.invoke(CH.acpRemove, id),
  probeAcpAgent: (agent) => ipcRenderer.invoke(CH.acpProbe, agent),
  getAcpReadiness: (opts) => ipcRenderer.invoke(CH.acpReadiness, opts),
  onAcpReadiness: subscribe(PUSH.acpReadiness),
  exportBackup: (passphrase) => ipcRenderer.invoke(CH.backupExport, passphrase),
  openBackup: () => ipcRenderer.invoke(CH.backupOpen),
  restoreBackup: (token, passphrase) => ipcRenderer.invoke(CH.backupRestore, token, passphrase),
  undoRestore: (undoId) => ipcRenderer.invoke(CH.backupUndoRestore, undoId),
  listRoundtables: () => ipcRenderer.invoke(CH.roundtableList),
  setRoundtableArchived: (id, archived) => ipcRenderer.invoke(CH.roundtableArchive, id, archived),
  getRoundtable: (id) => ipcRenderer.invoke(CH.roundtableGet, id),
  createRoundtable: (req) => ipcRenderer.invoke(CH.roundtableCreate, req),
  sendRoundtableMessage: (id, text, opts) => ipcRenderer.invoke(CH.roundtableSend, id, text, opts),
  unqueueRoundtableMessage: (id) => ipcRenderer.invoke(CH.roundtableUnqueue, id),
  skipRoundtableSeat: (id, seat) => ipcRenderer.invoke(CH.roundtableSkip, id, seat),
  continueRoundtable: (id, seats) => ipcRenderer.invoke(CH.roundtableContinue, id, seats),
  stopRoundtable: (id) => ipcRenderer.invoke(CH.roundtableStop, id),
  setRoundtableLimits: (id, limits, maxRounds) =>
    ipcRenderer.invoke(CH.roundtableSetLimits, id, limits, maxRounds),
  onRoundtableEvent: subscribe(PUSH.roundtableEvent),
  getProfile: () => ipcRenderer.invoke(CH.profileGet),
  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor) => webFrame.setZoomFactor(clampZoom(factor)),
  reportZoom: (factor) => ipcRenderer.invoke(CH.windowZoom, factor),
  openExternal: (url) => ipcRenderer.invoke(CH.shellOpen, url),
  onIndexUpdated: subscribe(PUSH.indexUpdated),
  getAppInfo: () => ipcRenderer.invoke(CH.appInfo),
  openLicenseNotices: () => ipcRenderer.invoke(CH.appOpenLicenses),
  getUpdateState: () => ipcRenderer.invoke(CH.updatesGet),
  checkForUpdates: () => ipcRenderer.invoke(CH.updatesCheck),
  downloadUpdate: () => ipcRenderer.invoke(CH.updatesDownload),
  installUpdate: (req) => ipcRenderer.invoke(CH.updatesInstall, req),
  getUpdatePrefs: () => ipcRenderer.invoke(CH.updatesPrefs),
  setUpdatePrefs: (prefs) => ipcRenderer.invoke(CH.updatesSetPrefs, prefs),
  onUpdateState: subscribe(PUSH.updateState)
}

contextBridge.exposeInMainWorld('cockpit', api)
