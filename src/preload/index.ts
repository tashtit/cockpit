import { contextBridge, ipcRenderer, webFrame } from 'electron'

/** UI stays usable at any zoom the user can reach. The ceiling is 2.0 on purpose:
 *  WCAG 1.4.4 wants text to reach 200% without loss of content, and this app's chrome
 *  is deliberately dense (11–13px), so low-vision users need the whole range.
 *  App.tsx mirrors these bounds to keep the zoom chip honest — change both. */
const ZOOM_MIN = 0.7
const ZOOM_MAX = 2
import type {
  BusySession,
  ChatEvent,
  ChatRequest,
  CockpitApi,
  NewModelEndpoint,
  NewRoundtableRequest,
  Provider,
  RoundtableEvent,
  SessionQuery,
  SyncKind,
  SyncRequest,
  TimeFormat
} from '../shared/types'

const api: CockpitApi = {
  sendChat: (req: ChatRequest) => ipcRenderer.invoke('chat:send', req),
  cancelChat: (turnId: string) => ipcRenderer.invoke('chat:cancel', turnId),
  saveChatImage: (data: Uint8Array, mime: string) =>
    ipcRenderer.invoke('chat:save-image', data, mime),
  onChatEvent: (cb: (ev: ChatEvent) => void) => {
    const handler = (_e: unknown, ev: ChatEvent): void => cb(ev)
    ipcRenderer.on('chat-event', handler)
    return () => ipcRenderer.removeListener('chat-event', handler)
  },
  getSources: () => ipcRenderer.invoke('sources:get'),
  getSourceStats: () => ipcRenderer.invoke('sources:stats'),
  pickDirectory: () => ipcRenderer.invoke('sources:pick-dir'),
  addSource: (path: string, provider: Provider, label: string) =>
    ipcRenderer.invoke('sources:add', path, provider, label),
  removeSource: (path: string) => ipcRenderer.invoke('sources:remove', path),
  listRepos: () => ipcRenderer.invoke('repos:list'),
  pageSessions: (query: SessionQuery) => ipcRenderer.invoke('sessions:page', query),
  getSession: (sessionId: string) => ipcRenderer.invoke('sessions:get', sessionId),
  getSessionMessages: (id: string) => ipcRenderer.invoke('sessions:messages', id),
  getHandoffBriefing: (sessionId: string) => ipcRenderer.invoke('handoff:briefing', sessionId),
  improveHandoffBriefing: (sessionId: string) => ipcRenderer.invoke('handoff:improve', sessionId),
  getBusySessions: () => ipcRenderer.invoke('sessions:busy'),
  onBusySessions: (cb: (sessions: BusySession[]) => void) => {
    const handler = (_e: unknown, sessions: BusySession[]): void => cb(sessions)
    ipcRenderer.on('busy-sessions', handler)
    return () => ipcRenderer.removeListener('busy-sessions', handler)
  },
  setArchived: (sessionId: string, archived: boolean) =>
    ipcRenderer.invoke('sessions:archive', sessionId, archived),
  setRepoHidden: (repoKey: string, hidden: boolean) =>
    ipcRenderer.invoke('repos:set-hidden', repoKey, hidden),
  getHistoryDays: () => ipcRenderer.invoke('history:get'),
  setHistoryDays: (days: number) => ipcRenderer.invoke('history:set', days),
  getTimeFormat: () => ipcRenderer.invoke('time-format:get'),
  setTimeFormat: (format: TimeFormat) => ipcRenderer.invoke('time-format:set', format),
  getPrs: (repoRoot: string) => ipcRenderer.invoke('github:prs', repoRoot),
  createWorkspace: (repoRoot: string, name?: string) =>
    ipcRenderer.invoke('workspace:create', repoRoot, name),
  createPr: (cwd: string) => ipcRenderer.invoke('workspace:pr', cwd),
  getExtensions: () => ipcRenderer.invoke('extensions:get'),
  shareMcp: (name: string, to: Provider) => ipcRenderer.invoke('extensions:share-mcp', name, to),
  removeMcp: (name: string, agent: Provider, projectPath?: string) =>
    ipcRenderer.invoke('extensions:remove-mcp', name, agent, projectPath),
  checkMcp: (name: string) => ipcRenderer.invoke('extensions:check-mcp', name),
  loginMcp: (name: string, agent: Provider, projectPath?: string) =>
    ipcRenderer.invoke('extensions:login-mcp', name, agent, projectPath),
  shareSkill: (name: string, from: Provider, to: Provider) =>
    ipcRenderer.invoke('extensions:share-skill', name, from, to),
  syncExtension: (kind: SyncKind, name: string, req: SyncRequest) =>
    ipcRenderer.invoke('extensions:sync', kind, name, req),
  getInstructions: (repoRoot: string | null) => ipcRenderer.invoke('instructions:get', repoRoot),
  saveInstructionsBaseline: (repoRoot: string | null, baseline: string) =>
    ipcRenderer.invoke('instructions:save-baseline', repoRoot, baseline),
  applyInstructions: (repoRoot: string | null, onlyPath?: string) =>
    ipcRenderer.invoke('instructions:apply', repoRoot, onlyPath),
  saveInstructionFile: (repoRoot: string | null, path: string, content: string) =>
    ipcRenderer.invoke('instructions:save-file', repoRoot, path, content),
  getAccounts: () => ipcRenderer.invoke('accounts:get'),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  getModelEndpoints: () => ipcRenderer.invoke('endpoints:get'),
  addModelEndpoint: (ep: NewModelEndpoint) => ipcRenderer.invoke('endpoints:add', ep),
  removeModelEndpoint: (id: string) => ipcRenderer.invoke('endpoints:remove', id),
  listEndpointModels: (id: string) => ipcRenderer.invoke('endpoints:models', id),
  listRoundtables: () => ipcRenderer.invoke('roundtable:list'),
  getRoundtable: (id: string) => ipcRenderer.invoke('roundtable:get', id),
  createRoundtable: (req: NewRoundtableRequest) => ipcRenderer.invoke('roundtable:create', req),
  sendRoundtableMessage: (id: string, text: string) =>
    ipcRenderer.invoke('roundtable:send', id, text),
  continueRoundtable: (id: string) => ipcRenderer.invoke('roundtable:continue', id),
  stopRoundtable: (id: string) => ipcRenderer.invoke('roundtable:stop', id),
  onRoundtableEvent: (cb: (ev: RoundtableEvent) => void) => {
    const handler = (_e: unknown, ev: RoundtableEvent): void => cb(ev)
    ipcRenderer.on('roundtable-event', handler)
    return () => ipcRenderer.removeListener('roundtable-event', handler)
  },
  getProfile: () => ipcRenderer.invoke('profile:get'),
  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor: number) =>
    webFrame.setZoomFactor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor))),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open', url),
  onIndexUpdated: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('index-updated', handler)
    return () => ipcRenderer.removeListener('index-updated', handler)
  }
}

contextBridge.exposeInMainWorld('cockpit', api)
