import { vi } from 'vitest'
import type { PanelReport } from '../../src/shared/library'
import type { CockpitApi, RoundtableSnapshot, UsageSnapshot } from '../../src/shared/types'

/** An empty scope; panel tests override getPanel with real rows. */
const emptyPanel: PanelReport = {
  repoRoot: null,
  rows: [],
  removed: [],
  on: 0,
  drift: 0,
  globalOnly: []
}

/** A minimal idle roundtable snapshot; tests override getRoundtable for real fixtures. */
export function emptyRoundtable(): RoundtableSnapshot {
  return {
    id: 'rt-1',
    title: 'Roundtable',
    topic: '',
    createdAt: 0,
    updatedAt: 0,
    cwd: '/tmp/rt',
    repoRoot: null,
    branch: null,
    permissionMode: 'safe',
    mode: 'open',
    maxRounds: 3,
    roundsRun: 0,
    concluded: false,
    participants: [],
    entries: [],
    running: false,
    speaking: []
  }
}

/**
 * A three-subscription usage snapshot as main would measure it: claude counted from
 * logs (no limit known), codex reporting percentages for two windows, copilot a
 * premium-request count. Tests opt in via mockResolvedValue(usageFixture()).
 */
export function usageFixture(now = Date.now()): UsageSnapshot {
  const hour = 3_600_000
  return {
    at: now,
    providers: [
      {
        provider: 'claude',
        path: '/home/dev/.claude',
        label: 'claude',
        identity: 'dev@example.com',
        source: 'local-logs',
        measuredAt: now,
        windows: [
          {
            label: 'current 5h block',
            tokens: { input: 900_000, output: 300_000, cacheRead: 40_000, cacheCreate: 8_000 },
            requests: 42,
            resetsAt: now + 2 * hour
          },
          {
            label: 'last 7 days',
            tokens: { input: 14_000_000, output: 4_400_000, cacheRead: 0, cacheCreate: 0 },
            requests: 610
          }
        ]
      },
      {
        provider: 'codex',
        path: '/home/dev/.codex',
        label: 'codex',
        identity: 'dev@example.com',
        plan: 'plus',
        source: 'provider',
        measuredAt: now,
        windows: [
          { label: '5h window', usedPercent: 42, resetsAt: now + 3 * hour },
          { label: 'weekly window', usedPercent: 12, resetsAt: now + 4 * 24 * hour }
        ]
      },
      {
        provider: 'copilot',
        path: '',
        label: 'GitHub Copilot',
        identity: 'octocat',
        source: 'provider',
        measuredAt: now,
        windows: [{ label: 'premium requests this month', requests: 310, requestsBilled: 0 }]
      }
    ]
  }
}

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
    getSession: vi.fn(async () => null),
    getSessionMessages: vi.fn(async () => []),
    getHandoffBriefing: vi.fn(async () => ({ briefing: '', cwdExists: true })),
    improveHandoffBriefing: vi.fn(async () => ''),
    getBusySessions: vi.fn(async () => []),
    onBusySessions: vi.fn(() => () => {}),
    setArchived: vi.fn(async () => {}),
    setRepoHidden: vi.fn(async () => {}),
    getHistoryDays: vi.fn(async () => 0),
    setHistoryDays: vi.fn(async () => {}),
    getTimeFormat: vi.fn(async () => '24h' as const),
    setTimeFormat: vi.fn(async () => {}),
    getStaleDays: vi.fn(async () => 30),
    setStaleDays: vi.fn(async () => {}),
    scanCleanup: vi.fn(async () => ({
      staleDays: 30,
      scannedAt: 0,
      sessions: [],
      staleSessionCount: 0,
      staleSessionBytes: 0,
      worktrees: [],
      staleWorktreeCount: 0,
      totalSessions: 0,
      totalWorktrees: 0
    })),
    archiveSessions: vi.fn(async () => ({ cleaned: 0, freedBytes: 0, failed: [] })),
    deleteSessions: vi.fn(async () => ({ cleaned: 0, freedBytes: 0, failed: [] })),
    removeWorktrees: vi.fn(async () => ({ cleaned: 0, freedBytes: 0, failed: [] })),
    getPrs: vi.fn(async () => []),
    createWorkspace: vi.fn(async () => ({ cwd: '/tmp/wt', branch: 'main' })),
    createPr: vi.fn(async () => 'https://github.com/o/r/pull/1'),
    getWorkspaceDiff: vi.fn(async () => ({
      cwd: '/tmp/wt',
      scope: 'branch' as const,
      branch: 'cockpit/test',
      base: 'origin/main',
      ahead: 0,
      behind: 0,
      dirty: false,
      files: [],
      added: 0,
      removed: 0,
      droppedFiles: 0
    })),
    getExtensions: vi.fn(async () => ({ mcp: [], skills: [], plugins: [], marketplaces: [] })),
    checkMcp: vi.fn(async () => ({ status: 'ok' as const })),
    loginMcp: vi.fn(async () => 'logged in'),
    getPanel: vi.fn(async () => emptyPanel),
    setPanelSwitch: vi.fn(async () => emptyPanel),
    matchPanelEntry: vi.fn(async () => emptyPanel),
    removePanelEntry: vi.fn(async () => emptyPanel),
    restorePanelEntry: vi.fn(async () => emptyPanel),
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
    listRoundtables: vi.fn(async () => []),
    getRoundtable: vi.fn(async () => emptyRoundtable()),
    createRoundtable: vi.fn(async () => emptyRoundtable()),
    sendRoundtableMessage: vi.fn(async () => {}),
    continueRoundtable: vi.fn(async () => {}),
    stopRoundtable: vi.fn(async () => {}),
    onRoundtableEvent: vi.fn(() => () => {}),
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
    onIndexUpdated: vi.fn(() => () => {}),
    getAppInfo: vi.fn(async () => ({
      version: '0.0.0',
      packaged: false,
      platform: 'darwin',
      arch: 'arm64',
      electron: '44.0.0',
      releasesUrl: 'https://github.com/tashtit/cockpit/releases'
    })),
    getUpdateState: vi.fn(async () => ({
      status: 'unsupported' as const,
      message: 'Updates apply to installed builds only — this is a development run.'
    })),
    checkForUpdates: vi.fn(async () => ({ status: 'up-to-date' as const, checkedAt: 0 })),
    downloadUpdate: vi.fn(async () => ({ status: 'ready' as const, version: '0.0.0' })),
    installUpdate: vi.fn(async () => {}),
    onUpdateState: vi.fn(() => () => {})
  }
}
