export type Provider = 'claude' | 'codex' | 'copilot'

/** Identity of the git repository a session belongs to. */
export interface RepoInfo {
  /** Canonical main-repo root path; groups worktrees with their repo. 'general' when no repo. */
  key: string
  /** Repo directory name (e.g. "cachely") */
  name: string
  /** GitHub owner/repo parsed from the origin remote, if any */
  fullName: string | null
  /** Absolute path of the main repo root (null for the 'general' bucket) */
  root: string | null
}

export interface RepoGroup extends RepoInfo {
  /** Active (non-archived) session count */
  sessionCount: number
  archivedCount: number
  lastActivity: number
  providers: Provider[]
  /** User chose not to display this project (still listed here for the chooser UI) */
  hidden: boolean
}

export interface SessionMeta {
  /** Stable id: `${provider}:${nativeId}` */
  id: string
  provider: Provider
  /** Provider-native session id (uuid, filename stem, etc.) */
  nativeId: string
  /** Which registered source dir this came from (account isolation later) */
  source: string
  title: string
  cwd: string | null
  gitBranch: string | null
  /** GitHub owner/repo when the provider's log states it directly (Copilot does) */
  repoFullName?: string | null
  startedAt: number
  updatedAt: number
  messageCount: number
  /** Absolute path of the backing file/dir, for on-demand full parse */
  sourcePath: string
  /** Filled in by the indexer after parsing (parsers leave it undefined) */
  repo?: RepoInfo | null
  /** True when cwd is a linked git worktree rather than the main checkout */
  isWorktree?: boolean
  /** App-level flag (stored in cockpit config, not provider logs) */
  archived?: boolean
}

export type MessageKind = 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'system' | 'unknown'

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  kind: MessageKind
  text: string
  toolName?: string
  ts?: number
  /** True while this message is still being streamed into */
  streaming?: boolean
}

export interface SourceDir {
  path: string
  provider: Provider
  /** User label, e.g. account name ("claude-main") */
  label: string
}

/** Per-source health for the Settings view: what is indexed, and is it alive. */
export interface SourceStats extends SourceDir {
  /** Indexed sessions attributed to this source (provider-archived excluded) */
  count: number
  lastUpdatedAt: number | null
  /** The directory no longer exists on disk */
  missing: boolean
}

export interface SessionQuery {
  /** RepoInfo.key to scope to one repository ('general' = sessions with no repo) */
  repoKey?: string
  providers?: Provider[]
  search?: string
  /** false/undefined = active sessions; true = archived ones */
  archived?: boolean
  offset?: number
  limit?: number
}

export interface SessionPage {
  total: number
  items: SessionMeta[]
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export interface PrStatus {
  number: number
  title: string
  state: PrState
  isDraft: boolean
  headRefName: string
  url: string
}

export interface WorkspaceInfo {
  cwd: string
  branch: string
}

export type PermissionMode = 'safe' | 'auto-edit' | 'yolo'

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Per-agent knobs; each maps to that CLI's own flags. */
export interface AgentOptions {
  /** All three CLIs accept --model */
  model?: string
  /** Codex only: --sandbox */
  codexSandbox?: CodexSandbox
}

export interface ChatRequest {
  provider: Provider
  cwd: string
  prompt: string
  /** Provider-native session id to continue an existing conversation */
  resumeNativeId?: string
  permissionMode: PermissionMode
  options?: AgentOptions
  /** Config home of the chosen account (CLAUDE_CONFIG_DIR / CODEX_HOME / COPILOT_HOME) */
  configDir?: string
  /** Copilot: which logged-in GitHub user to run as */
  copilotUser?: string
}

/* ---------- accounts ---------- */

export interface AccountInfo {
  provider: Provider
  /** Config home directory (== SourceDir.path) */
  path: string
  label: string
  /** Signed-in identity: email (claude/codex) or GitHub login (copilot) */
  identity: string | null
  /** Copilot: every logged-in GitHub user in this config home */
  users?: string[]
  activeUser?: string | null
  isDefault: boolean
}

export interface AccountsSnapshot {
  accounts: AccountInfo[]
  /** `gh` CLI user — the identity used for PR creation and status */
  githubUser: string | null
}

/* ---------- extensions (MCP / skills / plugins) ---------- */

export interface McpConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  type?: string
}

export interface McpServerInfo {
  name: string
  config: McpConfig
  /** Which agents have this server configured */
  agents: Provider[]
  /**
   * Where the definitions were found: 'user' (agent's global config) and/or
   * 'project:<dirname>' (claude stores per-project servers in ~/.claude.json).
   */
  origins: string[]
}

export interface SkillInfo {
  name: string
  description: string
  agent: Provider
  path: string
}

export interface PluginInfo {
  name: string
  agent: Provider
  detail?: string
}

export interface MarketplaceInfo {
  name: string
  agent: Provider
  source?: string
}

export interface ExtensionsInventory {
  mcp: McpServerInfo[]
  skills: SkillInfo[]
  plugins: PluginInfo[]
  marketplaces: MarketplaceInfo[]
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

export interface InstructionFile {
  /** Agents that read this file (repo AGENTS.md covers codex + copilot) */
  agents: Provider[]
  path: string
  exists: boolean
  content: string
  status: InstructionStatus
}

export interface InstructionsState {
  /** null = global scope (agent home dirs); otherwise a repo root */
  repoRoot: string | null
  /** The shared baseline text (stored in cockpit config, per scope) */
  baseline: string
  files: InstructionFile[]
}

/* ---------- subscription usage ---------- */

export interface UsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

/** One measured window of subscription usage ("5h", "weekly", "last 7 days", …). */
export interface UsageWindow {
  label: string
  /** 0–100 of the subscription limit, when the provider reports it (codex) */
  usedPercent?: number
  /** Token totals measured locally from session logs (claude) */
  tokens?: UsageTokens
  /** API requests / premium requests counted in this window */
  requests?: number
  /** Requests billed beyond the included quota (copilot) */
  requestsBilled?: number
  /** Epoch ms when this window resets, when known */
  resetsAt?: number
}

export interface ProviderUsage {
  provider: Provider
  /** Config home this was measured for (mirrors SourceDir.path; '' for copilot/gh) */
  path: string
  label: string
  /** Identity the usage belongs to (email / GitHub login), when known */
  identity?: string | null
  /** Subscription plan when the provider reports it (codex plan_type) */
  plan?: string
  /** 'local-logs' = measured from session logs; 'provider' = reported by the service */
  source: 'local-logs' | 'provider'
  /** Epoch ms the underlying data was last observed */
  measuredAt?: number
  windows: UsageWindow[]
  /** Human-readable reason when usage could not be determined */
  unavailable?: string
}

export interface UsageSnapshot {
  at: number
  providers: ProviderUsage[]
}

export type ChatEvent =
  | { turnId: string; type: 'session'; nativeSessionId: string }
  | { turnId: string; type: 'text'; text: string }
  | { turnId: string; type: 'tool'; toolName: string; detail: string }
  | { turnId: string; type: 'done'; costUsd?: number }
  | { turnId: string; type: 'error'; message: string }

export interface CockpitApi {
  sendChat(req: ChatRequest): Promise<string>
  cancelChat(turnId: string): Promise<void>
  onChatEvent(cb: (ev: ChatEvent) => void): () => void
  getSources(): Promise<SourceDir[]>
  getSourceStats(): Promise<SourceStats[]>
  /** Native directory picker (main-process dialog); null when the user cancels */
  pickDirectory(): Promise<string | null>
  addSource(path: string, provider: Provider, label: string): Promise<SourceDir[]>
  removeSource(path: string): Promise<SourceDir[]>
  listRepos(): Promise<RepoGroup[]>
  pageSessions(query: SessionQuery): Promise<SessionPage>
  getSessionMessages(id: string): Promise<SessionMessage[]>
  setArchived(sessionId: string, archived: boolean): Promise<void>
  setRepoHidden(repoKey: string, hidden: boolean): Promise<void>
  getPrs(repoRoot: string): Promise<PrStatus[]>
  createWorkspace(repoRoot: string, name?: string): Promise<WorkspaceInfo>
  createPr(cwd: string): Promise<string>
  getExtensions(): Promise<ExtensionsInventory>
  shareMcp(name: string, to: Provider): Promise<void>
  shareSkill(name: string, from: Provider, to: Provider): Promise<void>
  getInstructions(repoRoot: string | null): Promise<InstructionsState>
  saveInstructionsBaseline(repoRoot: string | null, baseline: string): Promise<InstructionsState>
  /** Fan the baseline out into every target file (or just one path) */
  applyInstructions(repoRoot: string | null, onlyPath?: string): Promise<InstructionsState>
  saveInstructionFile(
    repoRoot: string | null,
    path: string,
    content: string
  ): Promise<InstructionsState>
  getAccounts(): Promise<AccountsSnapshot>
  /** Current subscription usage per configured provider account */
  getUsage(): Promise<UsageSnapshot>
  /** Renderer zoom (webFrame) — synchronous, clamped to sane limits */
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  openExternal(url: string): Promise<void>
  onIndexUpdated(cb: () => void): () => void
}
