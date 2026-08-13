export type Provider = 'claude' | 'codex' | 'copilot'

/** Strip readonly for a local builder/accumulator — never for shared state. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Identity of the git repository a session belongs to. */
export type RepoInfo = {
  /** Canonical main-repo root path; groups worktrees with their repo. 'general' when no repo. */
  readonly key: string
  /** Repo directory name (e.g. "cachely") */
  readonly name: string
  /** GitHub owner/repo parsed from the origin remote, if any */
  readonly fullName: string | null
  /** Absolute path of the main repo root (null for the 'general' bucket) */
  readonly root: string | null
}

export type RepoGroup = RepoInfo & {
  /** Active (non-archived) session count */
  readonly sessionCount: number
  readonly archivedCount: number
  readonly lastActivity: number
  readonly providers: Provider[]
  /** User chose not to display this project (still listed here for the chooser UI) */
  readonly hidden: boolean
}

export type SessionMeta = {
  /** Stable id: `${provider}:${nativeId}` */
  readonly id: string
  readonly provider: Provider
  /** Provider-native session id (uuid, filename stem, etc.) */
  readonly nativeId: string
  /** Which registered source dir this came from (account isolation later) */
  readonly source: string
  readonly title: string
  readonly cwd: string | null
  readonly gitBranch: string | null
  /** GitHub owner/repo when the provider's log states it directly (Copilot does) */
  readonly repoFullName?: string | null
  readonly startedAt: number
  readonly updatedAt: number
  readonly messageCount: number
  /** Absolute path of the backing file/dir, for on-demand full parse */
  readonly sourcePath: string
  /** Filled in by the indexer after parsing (parsers leave it undefined) — mutable on purpose */
  repo?: RepoInfo | null
  /** True when cwd is a linked git worktree rather than the main checkout — set with repo */
  isWorktree?: boolean
  /** App-level flag (stored in cockpit config, not provider logs) — set by the indexer */
  archived?: boolean
}

export type MessageKind = 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'system' | 'unknown'

export type SessionMessage = {
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly kind: MessageKind
  readonly text: string
  readonly toolName?: string
  /** Human one-liner for tool calls (command/path); text keeps the raw input */
  readonly preview?: string
  readonly ts?: number
  /** True while this message is still being streamed into */
  readonly streaming?: boolean
}

export type SourceDir = {
  readonly path: string
  readonly provider: Provider
  /** User label, e.g. account name ("claude-main") */
  readonly label: string
}

/** Per-source health for the Settings view: what is indexed, and is it alive. */
export type SourceStats = SourceDir & {
  /** Indexed sessions attributed to this source (provider-archived excluded) */
  readonly count: number
  readonly lastUpdatedAt: number | null
  /** The directory no longer exists on disk */
  readonly missing: boolean
}

export type SessionQuery = {
  /** RepoInfo.key to scope to one repository ('general' = sessions with no repo) */
  readonly repoKey?: string
  readonly providers?: Provider[]
  readonly search?: string
  /** false/undefined = active sessions; true = archived ones */
  readonly archived?: boolean
  readonly offset?: number
  readonly limit?: number
}

export type SessionPage = {
  readonly total: number
  readonly items: SessionMeta[]
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export type PrStatus = {
  readonly number: number
  readonly title: string
  readonly state: PrState
  readonly isDraft: boolean
  readonly headRefName: string
  readonly url: string
}

export type WorkspaceInfo = {
  readonly cwd: string
  readonly branch: string
}

export type PermissionMode = 'safe' | 'auto-edit' | 'yolo'

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

/* ---------- custom model endpoints (BYOK) ---------- */

/** Provider-API class of a custom endpoint (mirrors Copilot's COPILOT_PROVIDER_TYPE). */
export type ModelEndpointType = 'openai' | 'azure' | 'anthropic'

/** Copilot wire API for openai-type endpoints ('responses' for GPT-5-series models). */
export type WireApi = 'completions' | 'responses'

/**
 * A user-defined model provider endpoint (bring-your-own-key). The API key is entered
 * once, encrypted with the OS keychain (Electron safeStorage), and kept out of config —
 * this record only carries `hasKey` so the UI can show that one is stored.
 */
export type ModelEndpoint = {
  readonly id: string
  readonly label: string
  readonly type: ModelEndpointType
  readonly baseUrl: string
  /** An encrypted API key is stored for this endpoint (the key itself never crosses IPC back) */
  readonly hasKey?: boolean
  readonly wireApi?: WireApi
  /** Extra HTTP headers sent to the provider (e.g. anthropic-version) */
  readonly headers?: Record<string, string>
  /** Models this endpoint serves — cached from the provider's own /models listing */
  readonly models?: string[]
}

/** Renderer-supplied endpoint definition — main assigns the id and stores the key. */
export type NewModelEndpoint = Omit<ModelEndpoint, 'id' | 'hasKey'> & { readonly apiKey?: string }

/** Per-agent knobs; each maps to that CLI's own flags. */
export type AgentOptions = {
  /** All three CLIs accept --model */
  readonly model?: string
  /** Codex only: --sandbox */
  readonly codexSandbox?: CodexSandbox
  /** Custom model endpoint (ModelEndpoint.id) — claude/copilot run against it via env */
  readonly modelEndpoint?: string
}

export type ChatRequest = {
  readonly provider: Provider
  readonly cwd: string
  readonly prompt: string
  /** Provider-native session id to continue an existing conversation */
  readonly resumeNativeId?: string
  readonly permissionMode: PermissionMode
  readonly options?: AgentOptions
  /** Config home of the chosen account (CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME) */
  readonly configDir?: string
  /** Copilot: which logged-in GitHub user to run as */
  readonly copilotUser?: string
  /** Pasted-image paths returned by saveChatImage — main re-validates them against its own image dir */
  readonly images?: readonly string[]
}

/* ---------- accounts ---------- */

export type AccountInfo = {
  readonly provider: Provider
  /** Config home directory (== SourceDir.path) */
  readonly path: string
  readonly label: string
  /** Signed-in identity: email (claude/codex) or GitHub login (copilot) */
  readonly identity: string | null
  /** Copilot: every logged-in GitHub user in this config home */
  readonly users?: string[]
  readonly activeUser?: string | null
  readonly isDefault: boolean
}

export type AccountsSnapshot = {
  readonly accounts: AccountInfo[]
  /** `gh` CLI user — the identity used for PR creation and status */
  readonly githubUser: string | null
}

/* ---------- extensions (MCP / skills / plugins) ---------- */

export type McpConfig = {
  readonly command?: string
  readonly args?: string[]
  readonly env?: Record<string, string>
  readonly url?: string
  readonly type?: string
}

/**
 * One place a server definition lives: an agent's global config ('user') or a
 * claude per-project entry in ~/.claude.json ('project', with the project path).
 */
export type McpPresence = {
  readonly agent: Provider
  readonly scope: 'user' | 'project'
  /** Absolute project path — set only when scope === 'project' */
  readonly projectPath?: string
}

export type McpServerInfo = {
  readonly name: string
  readonly config: McpConfig
  /** Which agents have this server configured (any scope) */
  readonly agents: Provider[]
  /** Every (agent, scope) the definition was found in — removal targets one of these */
  readonly presences: McpPresence[]
}

export type McpProbeResult = {
  /** ok = server answered an MCP initialize; needs-auth = HTTP 401/403 */
  readonly status: 'ok' | 'needs-auth' | 'error'
  readonly detail?: string
}

export type SkillInfo = {
  readonly name: string
  readonly description: string
  readonly agent: Provider
  readonly path: string
}

export type PluginInfo = {
  readonly name: string
  readonly agent: Provider
  readonly detail?: string
}

export type MarketplaceInfo = {
  readonly name: string
  readonly agent: Provider
  readonly source?: string
}

export type ExtensionsInventory = {
  readonly mcp: McpServerInfo[]
  readonly skills: SkillInfo[]
  readonly plugins: PluginInfo[]
  readonly marketplaces: MarketplaceInfo[]
}

/* ---------- shared AI instructions ---------- */

export type InstructionStatus =
  /** File doesn't exist yet — applying creates it */
  | 'missing'
  /** File exists but has no cockpit-managed block */
  | 'unmanaged'
  /** Managed block matches the shared baseline */
  | 'synced'
  /** Managed block differs from the baseline (stale, or hand-edited) */
  | 'drifted'

export type InstructionFile = {
  /** Agents that read this file (repo AGENTS.md covers codex + copilot) */
  readonly agents: Provider[]
  readonly path: string
  readonly exists: boolean
  readonly content: string
  readonly status: InstructionStatus
}

export type InstructionsState = {
  /** null = global scope (agent home dirs); otherwise a repo root */
  readonly repoRoot: string | null
  /** The shared baseline text (stored in cockpit config, per scope) */
  readonly baseline: string
  readonly files: InstructionFile[]
}

/* ---------- subscription usage ---------- */

export type UsageTokens = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheCreate: number
}

/** One measured window of subscription usage ("5h", "weekly", "last 7 days", …). */
export type UsageWindow = {
  readonly label: string
  /** 0–100 of the subscription limit, when the provider reports it (codex) */
  readonly usedPercent?: number
  /** Token totals measured locally from session logs (claude) */
  readonly tokens?: UsageTokens
  /** API requests / premium requests counted in this window */
  readonly requests?: number
  /** Requests billed beyond the included quota (copilot) */
  readonly requestsBilled?: number
  /** Epoch ms when this window resets, when known */
  readonly resetsAt?: number
}

export type ProviderUsage = {
  readonly provider: Provider
  /** Config home this was measured for (mirrors SourceDir.path; '' for copilot/gh) */
  readonly path: string
  readonly label: string
  /** Identity the usage belongs to (email / GitHub login), when known */
  readonly identity?: string | null
  /** Subscription plan when the provider reports it (codex plan_type) */
  readonly plan?: string
  /** 'local-logs' = measured from session logs; 'provider' = reported by the service */
  readonly source: 'local-logs' | 'provider'
  /** Epoch ms the underlying data was last observed */
  readonly measuredAt?: number
  readonly windows: UsageWindow[]
  /** Human-readable reason when usage could not be determined */
  readonly unavailable?: string
}

export type UsageSnapshot = {
  readonly at: number
  readonly providers: ProviderUsage[]
}

/* ---------- profile ---------- */

/**
 * One day of the activity heatmap. Days are local-time calendar days so the grid
 * matches the user's sense of "yesterday", not UTC's.
 */
export type ActivityDay = {
  /** Local calendar day, `YYYY-MM-DD` */
  readonly day: string
  readonly sessions: number
  /** Sessions per provider that day — drives the square's tint */
  readonly byProvider: Partial<Record<Provider, number>>
}

/** Per-agent totals. The comparison across these is the point of the profile. */
export type ProviderProfile = {
  readonly provider: Provider
  readonly sessions: number
  /** Distinct local days with at least one session */
  readonly activeDays: number
  /** Mean messages per session (index metadata, so it costs nothing) */
  readonly avgTurns: number
  /**
   * Lines the agent wrote / removed via its edit tools. This counts edit *operations*,
   * not surviving diff: rewriting the same file twice counts twice, and nothing here
   * is reconciled against git. Label it "edited", never "shipped".
   */
  readonly linesAdded: number
  readonly linesRemoved: number
  /** Distinct absolute file paths touched by an edit/write tool */
  readonly filesTouched: number
  /** Tool-call counts, highest first */
  readonly tools: NameCount[]
  /** Models seen in this agent's logs, highest first */
  readonly models: NameCount[]
  /**
   * Set when the deep pass could not read this agent's logs at all — the session
   * counts above are still valid (they come from the index).
   */
  readonly deepUnavailable?: string
}

export type NameCount = {
  readonly name: string
  readonly count: number
}

/**
 * One model across every agent. Split by provider because the same model family
 * crosses agent boundaries (Copilot serves claude-opus; Claude serves fable) —
 * "which model" and "which agent" are different questions, and the split is the
 * interesting part. Counted in assistant messages, a proxy for actual use.
 */
export type ModelStat = {
  readonly name: string
  readonly count: number
  readonly byProvider: Partial<Record<Provider, number>>
}

/** Sessions attributed to one signed-in account (config home), for multi-account setups. */
export type AccountStat = {
  readonly provider: Provider
  /** Source label (== SourceDir.label / SessionMeta.source) */
  readonly label: string
  /** Signed-in identity for that config home: email or GitHub login, when known */
  readonly identity: string | null
  readonly sessions: number
  readonly lastActivity: number
}

/** One language, keyed by file extension (the only signal session logs carry). */
export type LanguageStat = {
  /** Lowercase extension without the dot (`ts`, `tsx`, `py`) */
  readonly ext: string
  readonly files: number
  readonly linesAdded: number
}

export type RepoStat = {
  readonly key: string
  readonly name: string
  readonly sessions: number
  readonly lastActivity: number
}

/**
 * The whole profile. Aggregate only — the sessions behind it never cross the bridge.
 * Computed over *all* history, deliberately ignoring the `historyDays` display window:
 * a profile's job is the long view, while that setting exists to keep the tree short.
 */
export type ProfileStats = {
  readonly at: number
  /** GitHub login when `gh` reports one */
  readonly login: string | null
  /** Epoch ms of the earliest session seen; null when there are none */
  readonly since: number | null
  readonly totalSessions: number
  readonly activeDays: number
  /** Consecutive active days ending today or yesterday; 0 once the chain breaks */
  readonly currentStreak: number
  readonly longestStreak: number
  readonly busiestDay: ActivityDay | null
  /** Contiguous run of days, oldest first — includes zero-session days so the grid is dense */
  readonly days: ActivityDay[]
  readonly providers: ProviderProfile[]
  readonly languages: LanguageStat[]
  readonly repos: RepoStat[]
  /** Models across every agent, most-used first */
  readonly models: ModelStat[]
  /** Signed-in accounts with their session share, most-used first */
  readonly accounts: AccountStat[]
  /** Sessions started per local hour of day — 24 buckets, index 0 = midnight */
  readonly hourCounts: number[]
}

/** One session with a live provider process, for status displays (the board, LiveDots). */
export type BusySession = {
  /** Session id: `${provider}:${nativeId}` */
  readonly id: string
  /** Epoch ms the running turn was started — elapsed time derives from this */
  readonly startedAt: number
}

export type ChatEvent =
  | { readonly turnId: string; readonly type: 'session'; readonly nativeSessionId: string }
  | { readonly turnId: string; readonly type: 'text'; readonly text: string }
  | {
      readonly turnId: string
      readonly type: 'tool'
      readonly toolName: string
      readonly detail: string
      readonly preview?: string
    }
  | { readonly turnId: string; readonly type: 'done'; readonly costUsd?: number }
  | { readonly turnId: string; readonly type: 'error'; readonly message: string }

/** Clock format for session timestamps shown in the UI */
export type TimeFormat = '12h' | '24h'

export type CockpitApi = {
  readonly sendChat: (req: ChatRequest) => Promise<string>
  readonly cancelChat: (turnId: string) => Promise<void>
  readonly onChatEvent: (cb: (ev: ChatEvent) => void) => () => void
  /** Persist a pasted image in main's image dir; resolves to the absolute file path */
  readonly saveChatImage: (data: Uint8Array, mime: string) => Promise<string>
  readonly getSources: () => Promise<SourceDir[]>
  readonly getSourceStats: () => Promise<SourceStats[]>
  /** Native directory picker (main-process dialog); null when the user cancels */
  readonly pickDirectory: () => Promise<string | null>
  readonly addSource: (path: string, provider: Provider, label: string) => Promise<SourceDir[]>
  readonly removeSource: (path: string) => Promise<SourceDir[]>
  readonly listRepos: () => Promise<RepoGroup[]>
  readonly pageSessions: (query: SessionQuery) => Promise<SessionPage>
  readonly getSessionMessages: (id: string) => Promise<SessionMessage[]>
  /** Sessions with a provider process currently running */
  readonly getBusySessions: () => Promise<BusySession[]>
  /** Push: fires with the full busy set whenever a turn starts, ends, or gains a session id */
  readonly onBusySessions: (cb: (sessions: BusySession[]) => void) => () => void
  readonly setArchived: (sessionId: string, archived: boolean) => Promise<void>
  readonly setRepoHidden: (repoKey: string, hidden: boolean) => Promise<void>
  /** Days of history to display — sessions idle longer are hidden; 0 = all */
  readonly getHistoryDays: () => Promise<number>
  readonly setHistoryDays: (days: number) => Promise<void>
  /** Clock format for session times (sidebar, home); default 24h */
  readonly getTimeFormat: () => Promise<TimeFormat>
  readonly setTimeFormat: (format: TimeFormat) => Promise<void>
  readonly getPrs: (repoRoot: string) => Promise<PrStatus[]>
  readonly createWorkspace: (repoRoot: string, name?: string) => Promise<WorkspaceInfo>
  readonly createPr: (cwd: string) => Promise<string>
  readonly getExtensions: () => Promise<ExtensionsInventory>
  readonly shareMcp: (name: string, to: Provider) => Promise<void>
  /** Remove one presence: an agent's user-scope entry, or a claude project entry */
  readonly removeMcp: (name: string, agent: Provider, projectPath?: string) => Promise<void>
  /** Probe the server (spawn stdio / hit URL) and report whether it answers */
  readonly checkMcp: (name: string) => Promise<McpProbeResult>
  /** Run the agent CLI's own OAuth login for the server; resolves with its output */
  readonly loginMcp: (name: string, agent: Provider, projectPath?: string) => Promise<string>
  readonly shareSkill: (name: string, from: Provider, to: Provider) => Promise<void>
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
  readonly getAccounts: () => Promise<AccountsSnapshot>
  /** Current subscription usage per configured provider account */
  readonly getUsage: () => Promise<UsageSnapshot>
  /** Aggregate cross-agent work profile (heatmap, per-agent totals, languages) */
  readonly getProfile: () => Promise<ProfileStats>
  readonly getModelEndpoints: () => Promise<ModelEndpoint[]>
  readonly addModelEndpoint: (ep: NewModelEndpoint) => Promise<ModelEndpoint[]>
  readonly removeModelEndpoint: (id: string) => Promise<ModelEndpoint[]>
  /** Ask the provider itself which models it serves (also refreshes the cached list) */
  readonly listEndpointModels: (id: string) => Promise<string[]>
  /** Renderer zoom (webFrame) — synchronous, clamped to sane limits */
  readonly getZoomFactor: () => number
  readonly setZoomFactor: (factor: number) => void
  readonly openExternal: (url: string) => Promise<void>
  readonly onIndexUpdated: (cb: () => void) => () => void
}
