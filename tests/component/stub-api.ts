import { vi } from 'vitest'
import type { CockpitApi } from '../../src/shared/types'

/**
 * A complete CockpitApi double with empty-state defaults. Tests override
 * individual methods via vi.mocked(window.cockpit.method).mockResolvedValue(...).
 */
export function freshApi(): CockpitApi {
  return {
    sendChat: vi.fn(async () => 'turn-1'),
    cancelChat: vi.fn(async () => {}),
    onChatEvent: vi.fn(() => () => {}),
    saveChatImage: vi.fn(async () => '/tmp/chat-images/img.png'),
    getSources: vi.fn(async () => []),
    getSourceStats: vi.fn(async () => []),
    pickDirectory: vi.fn(async () => null),
    addSource: vi.fn(async () => []),
    removeSource: vi.fn(async () => []),
    listRepos: vi.fn(async () => []),
    pageSessions: vi.fn(async () => ({ total: 0, items: [] })),
    getSessionMessages: vi.fn(async () => []),
    getBusySessions: vi.fn(async () => []),
    onBusySessions: vi.fn(() => () => {}),
    setArchived: vi.fn(async () => {}),
    setRepoHidden: vi.fn(async () => {}),
    getHistoryDays: vi.fn(async () => 0),
    setHistoryDays: vi.fn(async () => {}),
    getTimeFormat: vi.fn(async () => '24h' as const),
    setTimeFormat: vi.fn(async () => {}),
    getPrs: vi.fn(async () => []),
    createWorkspace: vi.fn(async () => ({ cwd: '/tmp/wt', branch: 'main' })),
    createPr: vi.fn(async () => 'https://github.com/o/r/pull/1'),
    getExtensions: vi.fn(async () => ({ mcp: [], skills: [], plugins: [], marketplaces: [] })),
    shareMcp: vi.fn(async () => {}),
    removeMcp: vi.fn(async () => {}),
    checkMcp: vi.fn(async () => ({ status: 'ok' as const })),
    loginMcp: vi.fn(async () => 'logged in'),
    shareSkill: vi.fn(async () => {}),
    getInstructions: vi.fn(async () => ({ repoRoot: null, baseline: '', files: [] })),
    saveInstructionsBaseline: vi.fn(async () => ({ repoRoot: null, baseline: '', files: [] })),
    applyInstructions: vi.fn(async () => ({ repoRoot: null, baseline: '', files: [] })),
    saveInstructionFile: vi.fn(async () => ({ repoRoot: null, baseline: '', files: [] })),
    getAccounts: vi.fn(async () => ({ accounts: [], githubUser: null })),
    getUsage: vi.fn(async () => ({ at: 0, providers: [] })),
    getModelEndpoints: vi.fn(async () => []),
    addModelEndpoint: vi.fn(async () => []),
    removeModelEndpoint: vi.fn(async () => []),
    listEndpointModels: vi.fn(async () => []),
    getProfile: vi.fn(async () => ({
      at: 0,
      login: null,
      since: null,
      totalSessions: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      busiestDay: null,
      days: [],
      providers: [],
      languages: [],
      repos: [],
      models: [],
      accounts: [],
      hourCounts: new Array(24).fill(0)
    })),
    getZoomFactor: vi.fn(() => 1),
    setZoomFactor: vi.fn(),
    openExternal: vi.fn(async () => {}),
    onIndexUpdated: vi.fn(() => () => {})
  }
}
