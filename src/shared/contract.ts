/**
 * The IPC contract: every method the renderer can call on main, and every push it
 * can subscribe to. This is the whole renderer↔main surface — `window.cockpit` is
 * this type and nothing else.
 *
 * It lives apart from types.ts on purpose. types.ts is the domain vocabulary and
 * must stay a leaf: the contract depends on the domain (and on shared/library's
 * panel types), never the other way round. Keeping CockpitApi here is what makes
 * that direction hold — when it lived in types.ts, PanelReport forced types.ts to
 * import library.ts, which imports types.ts back.
 *
 * Adding a capability touches four files in order (.agents/skills/add-ipc-capability):
 * this file, main/index.ts, preload/index.ts, renderer/src/api.ts.
 */
import type { PanelReport } from './library'
import type {
  AccountsSnapshot,
  AcpAgent,
  AcpAgentProbe,
  AppInfo,
  AttentionFocus,
  AttentionPrefs,
  AttentionTarget,
  BackupExportResult,
  BackupPreview,
  BusySession,
  ChatEvent,
  ChatRequest,
  CleanupReport,
  CleanupResult,
  DiffScope,
  ExtensionsInventory,
  HandoffBriefing,
  InstructionsState,
  Landing,
  McpProbeResult,
  McpVersion,
  ModelEndpoint,
  NewAcpAgent,
  NewModelEndpoint,
  NewRoundtableRequest,
  NotificationDelivery,
  PanelTarget,
  PrFeedback,
  PrFixBriefing,
  PrStatus,
  ProcessTarget,
  ProfileStats,
  Provider,
  RepoGroup,
  RestoreSummary,
  RoundtableEvent,
  RoundtableMeta,
  RoundtableSnapshot,
  SessionMessage,
  SessionMeta,
  SessionPage,
  SessionQuery,
  ShareResult,
  SourceDir,
  SourceStats,
  TimeFormat,
  TranscriptSearchQuery,
  TranscriptSearchResult,
  UpdatePrefs,
  UpdateState,
  UsageSnapshot,
  WorkspaceDiff,
  WorkspaceInfo
} from './types'

export type CockpitApi = {
  /* ---------- a turn: send, cancel, stream, answer ---------- */
  readonly sendChat: (req: ChatRequest) => Promise<string>
  readonly cancelChat: (turnId: string) => Promise<void>
  readonly onChatEvent: (cb: (ev: ChatEvent) => void) => () => void
  /** Answer a 'permission' chat event; the agent stays blocked until this lands */
  readonly respondPermission: (turnId: string, requestId: string, optionId: string) => Promise<void>
  /** Persist a pasted image in main's image dir; resolves to the absolute file path */
  readonly saveChatImage: (data: Uint8Array, mime: string) => Promise<string>

  /* ---------- sources and the index the renderer reads through ---------- */
  readonly getSources: () => Promise<SourceDir[]>
  readonly getSourceStats: () => Promise<SourceStats[]>
  /** Native directory picker (main-process dialog); null when the user cancels */
  readonly pickDirectory: () => Promise<string | null>
  readonly addSource: (path: string, provider: Provider, label: string) => Promise<SourceDir[]>
  readonly removeSource: (path: string) => Promise<SourceDir[]>
  readonly listRepos: () => Promise<RepoGroup[]>
  /** Resolves once the index has finished its first full scan — until then no repos means "not read yet" */
  readonly whenIndexed: () => Promise<void>
  readonly pageSessions: (query: SessionQuery) => Promise<SessionPage>
  /** One indexed session by id (lineage navigation); null when unknown */
  readonly getSession: (sessionId: string) => Promise<SessionMeta | null>
  readonly getSessionMessages: (id: string) => Promise<SessionMessage[]>

  /* ---------- searching transcript contents ---------- */
  /** Full-text search over transcript contents; a newer call cancels the one in flight */
  readonly searchTranscripts: (query: TranscriptSearchQuery) => Promise<TranscriptSearchResult>
  /** Stop the in-flight transcript search early (the palette closed) */
  readonly cancelTranscriptSearch: () => Promise<void>

  /* ---------- handing a session to another agent ---------- */
  /** Deterministic context briefing for handing this session to another agent */
  readonly getHandoffBriefing: (sessionId: string) => Promise<HandoffBriefing>
  /** Ask the source session's own CLI to rewrite the briefing (resumes it read-only) */
  readonly improveHandoffBriefing: (sessionId: string) => Promise<string>

  /* ---------- what is running, and what needs you ---------- */
  /** Sessions with a turn in progress — spawned by Cockpit, or observed mid-turn in their logs */
  readonly getBusySessions: () => Promise<BusySession[]>
  /**
   * Push: fires with the full busy set whenever a turn starts, ends, or gains a session
   * id — for spawned and observed sessions alike (an observed turn starts on its log's
   * first write and ends on the final answer, or when the log goes quiet)
   */
  readonly onBusySessions: (cb: (sessions: BusySession[]) => void) => () => void
  /* attention: notifications, sound and the Dock badge */
  readonly getAttentionPrefs: () => Promise<AttentionPrefs>
  readonly setAttentionPrefs: (prefs: AttentionPrefs) => Promise<AttentionPrefs>
  /** Post a sample notification (with the sound, when that is on) and report what macOS did */
  readonly testNotification: () => Promise<NotificationDelivery>
  /** Tell main what the window shows — it never notifies about that, and opening clears a landing */
  readonly setAttentionFocus: (focus: AttentionFocus) => Promise<void>
  /** Sessions that landed while nobody was looking, newest first */
  readonly getLandings: () => Promise<Landing[]>
  /** Push: the landed set changed (a turn ended unseen, or a session was opened) */
  readonly onLandings: (cb: (landings: Landing[]) => void) => () => void
  /** Push: a notification was clicked — the window is already focused, open the target */
  readonly onAttentionOpen: (cb: (target: AttentionTarget) => void) => () => void
  /** A click that came in while no window was listening; null when there is none */
  readonly takeAttentionOpen: () => Promise<AttentionTarget | null>

  /* ---------- what the tree shows ---------- */
  readonly setArchived: (sessionId: string, archived: boolean) => Promise<void>
  /** Archive (or bring back) a whole roundtable — reversible, nothing on disk moves */
  readonly setRoundtableArchived: (id: string, archived: boolean) => Promise<void>
  readonly setRepoHidden: (repoKey: string, hidden: boolean) => Promise<void>
  /** Save the project order (repo keys, top first); an empty list goes back to A→Z */
  readonly setRepoOrder: (repoKeys: readonly string[]) => Promise<void>
  /** Days of history to display — sessions idle longer are hidden; 0 = all */
  readonly getHistoryDays: () => Promise<number>
  readonly setHistoryDays: (days: number) => Promise<void>
  /** Clock format for session times (sidebar, home); default 24h */
  readonly getTimeFormat: () => Promise<TimeFormat>
  readonly setTimeFormat: (format: TimeFormat) => Promise<void>

  /* ---------- cleanup: stale sessions, worktrees, processes ---------- */
  /* cleanup: one place for stale sessions and worktrees across every agent and repo */
  /** Idle threshold the cleanup view applies, in days (default 30) */
  readonly getStaleDays: () => Promise<number>
  readonly setStaleDays: (days: number) => Promise<void>
  /** Walk every source and every known repo for things idle past the threshold */
  readonly scanCleanup: () => Promise<CleanupReport>
  /** Reversible tier: hide them in Cockpit, touch nothing on disk */
  readonly archiveSessions: (ids: readonly string[]) => Promise<CleanupResult>
  /** Delete whole roundtables: room or worktree, seat logs, and the table record */
  readonly deleteRoundtables: (ids: readonly string[]) => Promise<CleanupResult>
  /** Destructive tier: delete the provider's own log files */
  readonly deleteSessions: (ids: readonly string[]) => Promise<CleanupResult>
  /** `git worktree remove` each path, then drop any branch git says is fully merged */
  readonly removeWorktrees: (paths: readonly string[]) => Promise<CleanupResult>
  /**
   * SIGTERM processes the scan reported as left in old worktrees (re-derived first;
   * a pid whose command or start time no longer matches is refused)
   */
  readonly stopProcesses: (targets: readonly ProcessTarget[]) => Promise<CleanupResult>

  /* ---------- GitHub: PRs, worktrees, the review before landing ---------- */
  readonly getPrs: (repoRoot: string) => Promise<PrStatus[]>
  /** The branch a PR from this repo would target; null when git can't say */
  readonly getDefaultBranch: (repoRoot: string) => Promise<string | null>
  readonly createWorkspace: (repoRoot: string, name?: string) => Promise<WorkspaceInfo>
  readonly createPr: (cwd: string) => Promise<string>
  /** The worktree's changes for review before they ship; `cwd` must be a known session/worktree dir */
  readonly getWorkspaceDiff: (cwd: string, scope: DiffScope) => Promise<WorkspaceDiff>
  /** An open PR's checks, unresolved review threads and requested changes (repo root from the index) */
  readonly getPrFeedback: (repoRoot: string, prNumber: number) => Promise<PrFeedback>
  /** The prompt that asks the agent to fix that PR — failing checks with their failed-step logs, threads, reviews */
  readonly getPrFixBriefing: (repoRoot: string, prNumber: number) => Promise<PrFixBriefing>

  /* ---------- extensions: MCP servers, skills, plugins, marketplaces ---------- */
  readonly getExtensions: () => Promise<ExtensionsInventory>
  /** Probe the server (spawn stdio / hit URL) and report whether it answers */
  readonly checkMcp: (name: string) => Promise<McpProbeResult>
  /** Run the agent CLI's own OAuth login for the server; resolves with its output */
  readonly loginMcp: (name: string, agent: Provider, projectPath?: string) => Promise<string>
  /** Ask each registry whether a scope's version-pinned servers have a newer release */
  readonly mcpVersions: (repoRoot: string | null) => Promise<readonly McpVersion[]>
  /** Pin that server to `version` in every agent it is switched on for */
  readonly setMcpVersion: (target: PanelTarget, version: string) => Promise<PanelReport>
  /* the panel: Cockpit's own config for a scope, reconciled against each agent */
  readonly getPanel: (repoRoot: string | null) => Promise<PanelReport>
  /** Flip one agent's switch — writes the entry into that agent, or takes it out */
  readonly setPanelSwitch: (
    target: PanelTarget,
    agent: Provider,
    on: boolean
  ) => Promise<PanelReport>
  /** Copy one agent's definition to every other agent that has it switched on */
  readonly matchPanelEntry: (target: PanelTarget, source: Provider) => Promise<PanelReport>
  /**
   * Answer a disagreement with "keep them as they are": remember each differing
   * agent's current definition as intended (`keep` true), or forget that and treat
   * the difference as drift again (`keep` false).
   */
  readonly keepPanelDifference: (target: PanelTarget, keep: boolean) => Promise<PanelReport>
  /** Take it out of every agent. Cockpit keeps its copy, so it can be put back. */
  readonly removePanelEntry: (target: PanelTarget) => Promise<PanelReport>
  /** Put a removed entry back on the agents it was on */
  readonly restorePanelEntry: (target: PanelTarget) => Promise<PanelReport>

  /* ---------- shared AI instructions ---------- */
  readonly getInstructions: (repoRoot: string | null) => Promise<InstructionsState>
  readonly saveInstructionsBaseline: (
    repoRoot: string | null,
    baseline: string
  ) => Promise<InstructionsState>
  /** Fan the baseline out into every target file (or just one path) */
  readonly applyInstructions: (repoRoot: string | null, onlyPath?: string) => Promise<InstructionsState>
  readonly saveInstructionFile: (
    repoRoot: string | null,
    path: string,
    content: string
  ) => Promise<InstructionsState>
  /** Take one file's managed block as the baseline (a teammate's update arrived) */
  readonly adoptInstructionsFrom: (repoRoot: string | null, path: string) => Promise<InstructionsState>
  /** Open a PR putting this repo's shared instructions into the repo itself */
  readonly shareInstructions: (repoRoot: string) => Promise<ShareResult>

  /* ---------- who each agent is signed in as, and what it has spent ---------- */
  readonly getAccounts: () => Promise<AccountsSnapshot>
  /** Current subscription usage per configured provider account */
  readonly getUsage: () => Promise<UsageSnapshot>
  /** Aggregate cross-agent work profile (heatmap, per-agent totals, languages) */
  readonly getProfile: () => Promise<ProfileStats>

  /* ---------- what backs an agent: BYOK providers and ACP agents ---------- */
  readonly getModelEndpoints: () => Promise<ModelEndpoint[]>
  readonly addModelEndpoint: (ep: NewModelEndpoint) => Promise<ModelEndpoint[]>
  readonly removeModelEndpoint: (id: string) => Promise<ModelEndpoint[]>
  /** Give an existing provider its API key (a restore brings definitions, not keys) */
  readonly setEndpointKey: (id: string, apiKey: string) => Promise<ModelEndpoint[]>
  /** Ask the provider itself which models it serves (also refreshes the cached list) */
  readonly listEndpointModels: (id: string) => Promise<string[]>
  /* ACP agents: user-defined CLIs Cockpit drives over the Agent Client Protocol */
  readonly getAcpAgents: () => Promise<AcpAgent[]>
  readonly addAcpAgent: (agent: NewAcpAgent) => Promise<AcpAgent[]>
  readonly removeAcpAgent: (id: string) => Promise<AcpAgent[]>
  /** Run the `initialize` handshake against a definition to prove it speaks ACP */
  readonly probeAcpAgent: (agent: NewAcpAgent) => Promise<AcpAgentProbe>

  /* ---------- backup and restore ---------- */
  /* backup: export to a file the user keeps, restore it here or on another Mac */
  /** Native save dialog, then write the file; null when the user cancels */
  readonly exportBackup: (passphrase?: string) => Promise<BackupExportResult | null>
  /** Native open dialog, then parse and describe the file; null when the user cancels */
  readonly openBackup: () => Promise<BackupPreview | null>
  readonly restoreBackup: (token: string, passphrase?: string) => Promise<RestoreSummary>
  readonly undoRestore: (undoId: string) => Promise<void>

  /* ---------- roundtables: several agents, one discussion ---------- */
  /* roundtables: several agents, one shared discussion */
  readonly listRoundtables: () => Promise<RoundtableMeta[]>
  readonly getRoundtable: (id: string) => Promise<RoundtableSnapshot>
  /** Creates the table (a shared worktree when a repo is chosen) and runs the opening round */
  readonly createRoundtable: (req: NewRoundtableRequest) => Promise<RoundtableSnapshot>
  /** Append a user message and run one full round of replies */
  readonly sendRoundtableMessage: (id: string, text: string) => Promise<void>
  /** One more round with no new user message — the seats keep talking */
  readonly continueRoundtable: (id: string) => Promise<void>
  readonly stopRoundtable: (id: string) => Promise<void>
  readonly onRoundtableEvent: (cb: (ev: RoundtableEvent) => void) => () => void

  /* ---------- the window and the app shell ---------- */
  /** Renderer zoom (webFrame) — synchronous, clamped to ZOOM_MIN/ZOOM_MAX */
  readonly getZoomFactor: () => number
  readonly setZoomFactor: (factor: number) => void
  /**
   * Tell main the layout is now at this zoom, so the window's minimum size can keep
   * the 560x420 floor in CSS pixels. Only the renderer sees every change: the menu's
   * zoom items act in main with no event, and the chip's own reset acts in preload —
   * both land as a layout resize here. Answers with the level main settled on.
   */
  readonly reportZoom: (factor: number) => Promise<number>
  readonly openExternal: (url: string) => Promise<void>
  readonly onIndexUpdated: (cb: () => void) => () => void

  /* ---------- about, and the app updating itself ---------- */
  /* app updates (Settings › About) */
  readonly getAppInfo: () => Promise<AppInfo>
  /** Open the third-party notices in the system text viewer; resolves to why not, or null once open */
  readonly openLicenseNotices: () => Promise<string | null>
  readonly getUpdateState: () => Promise<UpdateState>
  /** Ask GitHub Releases for a newer build now; also clears a rolled-back install */
  readonly checkForUpdates: () => Promise<UpdateState>
  /** Fetch the offered build; state streams through `downloading` into `ready` */
  readonly downloadUpdate: () => Promise<UpdateState>
  /** Quit, swap the downloaded build in and reopen — only meaningful in the `ready` state */
  readonly installUpdate: () => Promise<void>
  readonly getUpdatePrefs: () => Promise<UpdatePrefs>
  readonly setUpdatePrefs: (prefs: UpdatePrefs) => Promise<UpdatePrefs>
  /** Push: every transition of the update state */
  readonly onUpdateState: (cb: (state: UpdateState) => void) => () => void
}

/**
 * Every channel name, once. `ipcMain.handle` and `ipcRenderer.invoke` both take a
 * plain string, so main and preload used to agree only by eye: 94 pairs of matching
 * literals with nothing checking them. Naming a channel through `CH` turns a typo or
 * a half-finished rename into a typecheck failure, instead of a runtime "No handler
 * registered" that only an e2e run might reach. `tests/ipc-channels.test.ts` is what
 * keeps the bare literals from creeping back.
 *
 * `CH` is request/response (`ipcMain.handle` <-> `ipcRenderer.invoke`); `PUSH` is
 * main -> renderer (`sendToWin` <-> `ipcRenderer.on`). Invoke channels are
 * `domain:verb`, push channels are kebab-case nouns.
 */
export const CH = {
  accountsGet: 'accounts:get',

  acpAdd: 'acp:add',
  acpGet: 'acp:get',
  acpProbe: 'acp:probe',
  acpRemove: 'acp:remove',

  appInfo: 'app:info',
  appOpenLicenses: 'app:open-licenses',

  attentionFocus: 'attention:focus',
  attentionLandings: 'attention:landings',
  attentionPrefs: 'attention:prefs',
  attentionSetPrefs: 'attention:set-prefs',
  attentionTakeOpen: 'attention:take-open',
  attentionTest: 'attention:test',

  backupExport: 'backup:export',
  backupOpen: 'backup:open',
  backupRestore: 'backup:restore',
  backupUndoRestore: 'backup:undo-restore',

  chatCancel: 'chat:cancel',
  chatRespondPermission: 'chat:respond-permission',
  chatSaveImage: 'chat:save-image',
  chatSend: 'chat:send',

  cleanupArchiveSessions: 'cleanup:archive-sessions',
  cleanupDeleteRoundtables: 'cleanup:delete-roundtables',
  cleanupDeleteSessions: 'cleanup:delete-sessions',
  cleanupRemoveWorktrees: 'cleanup:remove-worktrees',
  cleanupScan: 'cleanup:scan',
  cleanupSetStaleDays: 'cleanup:set-stale-days',
  cleanupStaleDays: 'cleanup:stale-days',
  cleanupStopProcesses: 'cleanup:stop-processes',

  endpointsAdd: 'endpoints:add',
  endpointsGet: 'endpoints:get',
  endpointsModels: 'endpoints:models',
  endpointsRemove: 'endpoints:remove',
  endpointsSetKey: 'endpoints:set-key',

  extensionsCheckMcp: 'extensions:check-mcp',
  extensionsGet: 'extensions:get',
  extensionsLoginMcp: 'extensions:login-mcp',
  extensionsMcpVersions: 'extensions:mcp-versions',
  extensionsSetMcpVersion: 'extensions:set-mcp-version',

  githubDefaultBranch: 'github:default-branch',
  githubPrFeedback: 'github:pr-feedback',
  githubPrFix: 'github:pr-fix',
  githubPrs: 'github:prs',

  handoffBriefing: 'handoff:briefing',
  handoffImprove: 'handoff:improve',

  historyGet: 'history:get',
  historySet: 'history:set',

  indexScanned: 'index:scanned',

  instructionsAdoptFile: 'instructions:adopt-file',
  instructionsApply: 'instructions:apply',
  instructionsGet: 'instructions:get',
  instructionsSaveBaseline: 'instructions:save-baseline',
  instructionsSaveFile: 'instructions:save-file',
  instructionsShare: 'instructions:share',

  panelGet: 'panel:get',
  panelKeep: 'panel:keep',
  panelMatch: 'panel:match',
  panelRemove: 'panel:remove',
  panelRestore: 'panel:restore',
  panelSetSwitch: 'panel:set-switch',

  profileGet: 'profile:get',

  reposList: 'repos:list',
  reposSetHidden: 'repos:set-hidden',
  reposSetOrder: 'repos:set-order',

  roundtableArchive: 'roundtable:archive',
  roundtableContinue: 'roundtable:continue',
  roundtableCreate: 'roundtable:create',
  roundtableGet: 'roundtable:get',
  roundtableList: 'roundtable:list',
  roundtableSend: 'roundtable:send',
  roundtableStop: 'roundtable:stop',

  sessionsArchive: 'sessions:archive',
  sessionsBusy: 'sessions:busy',
  sessionsGet: 'sessions:get',
  sessionsMessages: 'sessions:messages',
  sessionsPage: 'sessions:page',

  shellOpen: 'shell:open',

  sourcesAdd: 'sources:add',
  sourcesGet: 'sources:get',
  sourcesPickDir: 'sources:pick-dir',
  sourcesRemove: 'sources:remove',
  sourcesStats: 'sources:stats',

  timeFormatGet: 'time-format:get',
  timeFormatSet: 'time-format:set',

  transcriptsCancel: 'transcripts:cancel',
  transcriptsSearch: 'transcripts:search',

  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesGet: 'updates:get',
  updatesInstall: 'updates:install',
  updatesPrefs: 'updates:prefs',
  updatesSetPrefs: 'updates:set-prefs',

  usageGet: 'usage:get',

  windowZoom: 'window:zoom',

  workspaceCreate: 'workspace:create',
  workspaceDiff: 'workspace:diff',
  workspacePr: 'workspace:pr'
} as const

/** Main -> renderer events. Pair each with an `onX` member on `CockpitApi`. */
export const PUSH = {
  attentionOpen: 'attention-open',
  busySessions: 'busy-sessions',
  chatEvent: 'chat-event',
  indexUpdated: 'index-updated',
  landings: 'landings',
  roundtableEvent: 'roundtable-event',
  updateState: 'update-state'
} as const

/** Any channel the renderer may invoke. */
export type InvokeChannel = (typeof CH)[keyof typeof CH]

/** Any event main may push to the window. */
export type PushChannel = (typeof PUSH)[keyof typeof PUSH]
