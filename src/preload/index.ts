import { contextBridge, ipcRenderer, webFrame } from 'electron'

/** UI stays usable at any zoom the user can reach */
const ZOOM_MIN = 0.7
const ZOOM_MAX = 1.5
import type {
  BusySession,
  ChatEvent,
  ChatRequest,
  CockpitApi,
  NewModelEndpoint,
  Provider,
  SessionQuery,
  TimeFormat
} from '../shared/types'

const api: CockpitApi = {
  sendChat: (req: ChatRequest) => ipcRenderer.invoke('chat:send', req),
  cancelChat: (turnId: string) => ipcRenderer.invoke('chat:cancel', turnId),
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
  getSessionMessages: (id: string) => ipcRenderer.invoke('sessions:messages', id),
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
