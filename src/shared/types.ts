import type { PanelReport } from './library'
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
  /** The branch the provider's own log records, if any. Claude stamps one on every
   *  line, but Copilot dropped `context.branch` from session.start after CLI 1.0.80
   *  and most Codex rollouts carry no `git` block at all — so this is null for plenty
   *  of sessions that are very much on a branch. Read `gitBranch`, not this. */
  readonly logBranch: string | null
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
  /** The branch this session is on — what every branch chip and PR lookup reads:
   *  `logBranch` when the provider recorded one, else the cwd's live git HEAD.
   *  Set with repo, and recomputed from `logBranch` on every scan so a derived
   *  value (a detached HEAD mid-rebase, say) can never freeze onto the session. */
  gitBranch?: string | null
  /** App-level flag (stored in cockpit config, not provider logs) — set by the indexer */
  archived?: boolean
  /** Session id this one was handed off from (cockpit config, not provider logs) — set by the indexer */
  continuedFrom?: string
  /** Set when this is a roundtable seat-session (cwd is a table's room/worktree) —
   *  such sessions page only under their table and open read-only */
  roundtableId?: string
}

export type MessageKind = 'text' | 'tool_call' | 'tool_result' | 'reasoning' | 'system' | 'unknown'

/** One choice an agent offered in a question (`AskUserQuestion`'s `options[]`). */
export type AskOption = {
  readonly label: string
  /** What the option means — the agent's own one-liner under the label */
  readonly description?: string
}

/**
 * A question an agent stopped to ask, with the answers it offered. Parsed off the
 * tool call that is waiting (`src/shared/asks.ts`), so the chat can render the
 * options as picks instead of a JSON blob.
 */
export type AskPrompt = {
  readonly question: string
  /** The agent's own two-word label for the question, when it wrote one */
  readonly header?: string
  /** More than one answer may be picked */
  readonly multiSelect?: boolean
  readonly options: readonly AskOption[]
}

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
  /** A tool_call that stopped to ask the user to pick — the questions it offered.
   *  Unanswered (no tool_result folded onto the row) and last in the transcript,
   *  the chat renders it as an answerable card. */
  readonly asks?: readonly AskPrompt[]
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
  /** Page only this roundtable's seat-sessions (normal queries exclude them all) */
  readonly roundtableId?: string
  /** false/undefined = active sessions; true = archived ones */
  readonly archived?: boolean
  readonly offset?: number
  readonly limit?: number
}

export type SessionPage = {
  readonly total: number
  readonly items: SessionMeta[]
}

/**
 * Full-text search over transcript *contents* — "where did I discuss X", across all
 * three agents at once. On demand, never from a shipped index: the candidate files
 * come from the indexer, each is streamed under a byte cap, and a newer query
 * cancels the one in flight (see main/transcript-search.ts).
 */
export type TranscriptSearchQuery = {
  readonly text: string
  /** RepoInfo.key to scope to one repository; undefined = every visible repo */
  readonly repoKey?: string
  readonly providers?: Provider[]
  /** Total hit cap (default 50, at most 200) */
  readonly limit?: number
  /** Hits kept per session, so one chatty transcript can't fill the list (default 3) */
  readonly perSession?: number
  /** Also search tool calls and results; default is user and assistant text only */
  readonly includeTools?: boolean
}

export type TranscriptHitRole = 'user' | 'assistant' | 'tool'

export type TranscriptHit = {
  readonly sessionId: string
  readonly role: TranscriptHitRole
  /** A window of the matching message around its first match, whitespace collapsed */
  readonly snippet: string
  /** Where the match sits in `snippet` (UTF-16 units) so the UI can mark it; -1 = unknown */
  readonly matchStart: number
  readonly matchEnd: number
  readonly timestamp: number | null
}

/** Why a search returned: everything read, the hit cap, the time budget, or a newer query */
export type TranscriptSearchStop = 'complete' | 'hit-cap' | 'time' | 'cancelled'

export type TranscriptSearchResult = {
  readonly query: string
  readonly hits: TranscriptHit[]
  /** The sessions the hits belong to, stamped like page rows, so the UI can open them */
  readonly sessions: SessionMeta[]
  /** Transcripts in scope */
  readonly candidates: number
  /** Transcripts actually read (fewer when stopped early) */
  readonly scanned: number
  /** Transcripts larger than the per-file cap — only their first bytes were searched */
  readonly truncated: number
  readonly stoppedBy: TranscriptSearchStop
  readonly elapsedMs: number
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

/**
 * A PR's checks folded into one word (main-side, from gh's statusCheckRollup):
 * any failed check wins, then any still running, else all passed; `none` when
 * nothing has reported.
 */
export type PrChecks = 'passing' | 'failing' | 'pending' | 'none'

/** GitHub's reviewDecision; `none` when the repo requires no review. */
export type PrReview = 'approved' | 'changes_requested' | 'review_required' | 'none'

export type PrStatus = {
  readonly number: number
  readonly title: string
  readonly state: PrState
  readonly isDraft: boolean
  readonly headRefName: string
  /** The head commit, so "this PR went red" is news once per push, not once per refresh */
  readonly headSha: string
  readonly url: string
  readonly checks: PrChecks
  readonly review: PrReview
  /** Review threads nobody has resolved yet — counted for open PRs only, 0 otherwise
   *  (and 0 when GitHub couldn't be asked: the badge stays, the count just isn't shown). */
  readonly unresolvedThreads: number
}

export type WorkspaceInfo = {
  readonly cwd: string
  readonly branch: string
}

/**
 * What a worktree review compares: everything since the base branch (commits
 * plus the working tree — what a PR would carry), or just what is staged / not.
 */
export type DiffScope = 'branch' | 'staged' | 'unstaged'

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export type DiffHunkLine = {
  readonly op: 'same' | 'add' | 'del'
  readonly text: string
  /** Line number on the old side; null for an added line */
  readonly oldNo: number | null
  /** Line number on the new side; null for a removed line */
  readonly newNo: number | null
}

export type DiffHunk = {
  /** The function/context git prints after the `@@` range, often empty */
  readonly header: string
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: readonly DiffHunkLine[]
}

export type DiffFile = {
  /** The path the change lands on (the old path for a deletion) */
  readonly path: string
  /** Set for renames only: where the file came from */
  readonly oldPath: string | null
  readonly status: DiffFileStatus
  /** Not in git's index yet — an addition git diff itself would not show */
  readonly untracked: boolean
  readonly binary: boolean
  readonly added: number
  readonly removed: number
  readonly hunks: readonly DiffHunk[]
  /** Hunks were cut at the size cap; the counts above are still the real totals */
  readonly truncated: boolean
}

export type WorkspaceDiff = {
  readonly cwd: string
  readonly scope: DiffScope
  readonly branch: string | null
  /** The branch the work is measured against (`origin/main`); null when none was found */
  readonly base: string | null
  /** Commits on this branch the base doesn't have, and vice versa */
  readonly ahead: number
  readonly behind: number
  /** Uncommitted changes exist — Create PR would refuse until the agent commits */
  readonly dirty: boolean
  readonly files: readonly DiffFile[]
  readonly added: number
  readonly removed: number
  /** Files beyond the listing cap, not shipped */
  readonly droppedFiles: number
}

/** gh's own classification of a check run (`gh pr checks --json bucket`) */
export type PrCheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'

export type PrCheckRun = {
  readonly name: string
  /** The Actions workflow it belongs to; '' for an external status */
  readonly workflow: string
  readonly bucket: PrCheckBucket
  /** GitHub's raw state (FAILURE, TIMED_OUT, IN_PROGRESS…) — the word the UI shows */
  readonly state: string
  readonly link: string | null
}

export type PrThreadComment = {
  readonly author: string
  readonly body: string
  readonly url: string
}

/** An unresolved review thread — resolved ones need nothing from the agent. */
export type PrReviewThread = {
  readonly path: string
  /** The line on the thread's side of the PR diff; null once it left the diff (outdated) */
  readonly line: number | null
  /** LEFT = the removed (base) side, RIGHT = the branch's side */
  readonly side: 'LEFT' | 'RIGHT'
  readonly outdated: boolean
  readonly comments: readonly PrThreadComment[]
  /** Replies beyond the ones shipped */
  readonly moreComments: number
}

export type PrChangeRequest = {
  readonly author: string
  /** The review's summary; '' when the reviewer only left threads */
  readonly body: string
  readonly url: string
}

/** What an open PR is waiting on, read on demand for the review panel. */
export type PrFeedback = {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly headRefName: string
  readonly baseRefName: string
  /** GitHub reports the branch can't merge cleanly into its base */
  readonly conflicts: boolean
  readonly checks: readonly PrCheckRun[]
  readonly threads: readonly PrReviewThread[]
  readonly changeRequests: readonly PrChangeRequest[]
  /** Parts that couldn't be read (the checks list) — the rest still stands */
  readonly warnings: readonly string[]
}

/** The "Fix with <agent>" prompt, plus what couldn't make it in (an unreadable log). */
export type PrFixBriefing = {
  readonly briefing: string
  readonly warnings: readonly string[]
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
  /** Codex only: --skip-git-repo-check — codex refuses cwds outside a git repo
   *  (roundtable scratch rooms are exactly that) */
  readonly codexSkipGitCheck?: boolean
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
  /** Session id (`provider:nativeId`) this new session continues from — main validates it against the index */
  readonly handoffFrom?: string
}

/** Context briefing for handing a session to another agent, built main-side. */
export type HandoffBriefing = {
  readonly briefing: string
  /** The source session's working directory still exists — handoff must be blocked when false */
  readonly cwdExists: boolean
  readonly warnings?: string[]
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
  /**
   * The definition as *this* agent holds it. Two agents can configure the same
   * server name differently; the merged `McpServerInfo.config` hides that, so
   * comparison reads the per-presence config instead.
   */
  readonly config: McpConfig
}

export type McpServerInfo = {
  readonly name: string
  /** Representative definition (first agent found) — for per-agent detail read `presences` */
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
  /** Hash of SKILL.md — two agents' same-named skills are equal iff these match */
  readonly fingerprint: string
}

export type PluginInfo = {
  /** Plugin id as every agent spells it: `<name>@<marketplace>` */
  readonly name: string
  readonly agent: Provider
  readonly detail?: string
  /** Marketplace the plugin came from — the half after `@`, when known */
  readonly marketplace?: string
  readonly version?: string
}

export type MarketplaceInfo = {
  readonly name: string
  readonly agent: Provider
  /** Where the agent clones it from — a git URL, `owner/repo`, or a local path */
  readonly source?: string
}

/** Things Cockpit writes into an agent's own config for you. */
export type SyncKind = 'mcp' | 'skill' | 'plugin' | 'marketplace'

/** Everything the panel manages, per agent (see shared/library.ts). */
export type PanelKind = SyncKind | 'instructions'

/**
 * One thing Cockpit manages, and where it is applied.
 *
 * Cockpit keeps a copy of the definition, but it is a *backup*, not a version: it is
 * refreshed from whatever the agents run, and it exists so that switching an agent
 * back on — or putting the whole entry back after removing it everywhere — has
 * something to write. The agents are compared with each other, never with this.
 */
export type LibraryEntry = {
  readonly kind: PanelKind
  readonly name: string
  /** Where it is applied — true = on for that agent, absent or false = off */
  readonly enabled: Partial<Record<Provider, boolean>>
  /** mcp: the definition to write, kept in step with what the agents run */
  readonly config?: McpConfig
  /** marketplace: where to clone it from · plugin: the marketplace it comes from */
  readonly source?: string
  /**
   * Taken out of every agent, but kept: this is the whole reason Cockpit stores a
   * copy at all. `enabled` still records which agents to put it back on.
   */
  readonly removed?: boolean
  /**
   * Agents that run their own definition on purpose — the user answered "which one
   * is right?" with "keep them as they are". The value is the fingerprint
   * (`fieldsKey`) of what that agent ran when they said so: the difference stays
   * quiet only while the agent still runs exactly that, and is drift again the
   * moment it changes.
   */
  readonly kept?: Partial<Record<Provider, string>>
  /**
   * mcp restored from a backup that carried no passphrase: the env var names whose
   * values were left out. A switch refuses while this is set, rather than writing a
   * server with blank credentials; it clears itself once an agent supplies the real
   * definition.
   */
  readonly withheld?: readonly string[]
}

/** One entry in one scope — every panel action names its target this way. */
export type PanelTarget = {
  /** null = global (agent home configs); otherwise a repo root */
  readonly repoRoot: string | null
  readonly kind: PanelKind
  readonly name: string
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
  /** File exists but has no managed block */
  | 'unmanaged'
  /** Managed block matches the shared baseline */
  | 'synced'
  /** Managed block differs from the baseline (stale, or hand-edited), or the file carries it twice */
  | 'drifted'

export type InstructionFile = {
  /** Agents that read this file (repo AGENTS.md covers codex + copilot) */
  readonly agents: Provider[]
  readonly path: string
  readonly exists: boolean
  readonly content: string
  /** What currently sits inside the managed markers; null when the file has no block */
  readonly block: string | null
  /**
   * Lines of the agent's own content outside the markers — above and below the
   * block. A file with no block is all "above": applying appends the block after it.
   */
  readonly own: { readonly above: number; readonly below: number }
  /**
   * Further copies of the block after the first — the same text under the other
   * spelling of the markers, typically. Applying folds them into the one block.
   */
  readonly duplicates: number
  /**
   * Claude files of this scope that read this one instead of holding a block: a
   * repo `CLAUDE.md` that imports `@AGENTS.md`, or is a symlink to it. Their
   * agents are counted here and they are never written — Claude would otherwise
   * load the text twice.
   */
  readonly readBy: readonly InstructionReader[]
  readonly status: InstructionStatus
}

/** A Claude file that reads another target of its scope, and how. */
export type InstructionReader = {
  readonly path: string
  readonly how: 'import' | 'link'
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

/** One session with a turn in progress, for status displays (the board, LiveDots). */
export type BusySession = {
  /** Session id: `${provider}:${nativeId}` */
  readonly id: string
  /** Epoch ms the running turn was started — elapsed time derives from this */
  readonly startedAt: number
  /**
   * How Cockpit knows. `spawned`: a provider process it runs itself — the start is
   * exact and the entry ends the moment the process does. `observed`: a session driven
   * from a terminal or the provider's own app, judged from the tail of its log by
   * main's liveness tracker — the start is the turn's opening record (or the log's
   * last write when that has scrolled out), and the entry expires when the log stops
   * growing. Same id space either way; a spawned session's log is observed too, and
   * the spawned entry wins.
   */
  readonly source: 'spawned' | 'observed'
}

/* ---------- attention: notifications, sounds and the Dock badge ---------- */

/** Settings › Notifications — how Cockpit tells you an agent needs you. */
export type AttentionPrefs = {
  /** A desktop notification when a turn finishes or fails, an agent waits on you, a
   *  roundtable concludes, or a pull request turns red */
  readonly notifications: boolean
  /** A short macOS system sound on finish and on failure */
  readonly sound: boolean
  /** The number of landed, unopened sessions on the Dock icon */
  readonly badge: boolean
}

/** What the window shows. Main never notifies about it while the window is focused. */
export type AttentionFocus =
  | {
      readonly kind: 'session'
      /** `${provider}:${nativeId}`; null for a new chat whose agent hasn't named its session yet */
      readonly id: string | null
      readonly provider: Provider
      readonly cwd: string
    }
  | { readonly kind: 'roundtable'; readonly id: string }
  | { readonly kind: 'none' }

/** What an agent is blocked on: a question it asked, or a permission it wants. */
export type AttentionAsk = {
  readonly kind: 'question' | 'permission'
  /** One line — the question, the command — or '' when the log doesn't say */
  readonly detail: string
}

/** An open pull request that needs its author back. */
export type AttentionPr = {
  readonly number: number
  readonly title: string
  readonly url: string
  readonly checks: PrChecks
  readonly review: PrReview
}

/**
 * A session on the board's "needs you" list, one row per session. Main decides
 * (attention-core.ts): its turn ended while nobody was looking (`landed`), its agent
 * is waiting on an answer or a permission (`asks`), or the pull request on its branch
 * turned red (`pr`). A session with several reasons carries the most urgent one.
 */
export type Landing = {
  /** Session id: `${provider}:${nativeId}` */
  readonly id: string
  /** Epoch ms it became news */
  readonly at: number
} & (
  | { readonly kind: 'landed' }
  | { readonly kind: 'asks'; readonly asks: AttentionAsk }
  | { readonly kind: 'pr'; readonly pr: AttentionPr }
)

/** Where clicking a notification takes the window. */
export type AttentionTarget =
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'roundtable'; readonly id: string }
  | { readonly kind: 'home' }

/** What macOS did with a notification Cockpit asked it to show. */
export type NotificationDelivery =
  | { readonly status: 'shown' }
  /** macOS refused it — unsigned builds are never allowed to post notifications */
  | { readonly status: 'refused'; readonly message: string }
  /** No answer in time: it may be waiting on the permission prompt */
  | { readonly status: 'unknown' }

export type ChatEvent =
  | { readonly turnId: string; readonly type: 'session'; readonly nativeSessionId: string }
  | { readonly turnId: string; readonly type: 'text'; readonly text: string }
  | {
      readonly turnId: string
      readonly type: 'tool'
      readonly toolName: string
      readonly detail: string
      readonly preview?: string
      /** The tool is a question waiting on the user — its options (see AskPrompt) */
      readonly asks?: readonly AskPrompt[]
    }
  | { readonly turnId: string; readonly type: 'done'; readonly costUsd?: number }
  | { readonly turnId: string; readonly type: 'error'; readonly message: string }

/* ---------- roundtable (multi-agent shared discussion) ---------- */

/** Who wrote a roundtable entry: the moderating user, or one of the agent seats. */
export type RoundtableSpeaker = 'user' | Provider

/** One message in a roundtable's shared transcript. */
export type RoundtableEntry = {
  readonly speaker: RoundtableSpeaker
  readonly text: string
  readonly at: number
  /** The turn failed — text carries the error, not a contribution */
  readonly error?: boolean
  /** Consensus mode: the stance this seat declared at the end of its reply */
  readonly stance?: 'agree' | 'continue'
  /** Consensus mode: the seat's own one-line position (agree) or open point (not yet) —
   *  the outcome panel is assembled from these lines by the app, never by another AI */
  readonly stanceNote?: string
  /** Participant index that spoke — several seats may share a provider (old files
   *  lack it; resolvers fall back to the provider's first seat) */
  readonly seat?: number
}

/** How a table runs its rounds: user-driven, or auto-rounds until the seats agree. */
export type RoundtableMode = 'open' | 'consensus'

/** One agent seat at the table. */
export type RoundtableParticipant = {
  readonly provider: Provider
  /** Config home of the account this seat runs as (undefined = provider default) */
  readonly configDir?: string
  /** Copilot: which logged-in GitHub user this seat runs as */
  readonly copilotUser?: string
  /** Human-readable identity, display only */
  readonly accountLabel?: string
  /** Per-seat agent knobs chosen at creation (model) */
  readonly options?: AgentOptions
  /** Latest provider-native session id — null until the CLI announces one (copilot never does) */
  readonly nativeSessionId: string | null
  /** Transcript length this seat has been shown — its next delta prompt starts here */
  readonly seenUpTo: number
}

/**
 * A multi-agent discussion: several agent CLIs share one transcript and one working
 * directory. A user message opens a parallel wave (every seat answers at once);
 * discussion rounds relay sequentially so seats respond to each other. Cockpit owns
 * this record (userData) — each seat's provider session only sees its side of the relay.
 */
export type Roundtable = {
  readonly id: string
  readonly title: string
  /** The opening subject (also the first user entry) */
  readonly topic: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Shared working directory every seat runs in */
  readonly cwd: string
  /** Repo the shared worktree was cut from; null = free-standing discussion */
  readonly repoRoot: string | null
  readonly branch: string | null
  /** Always 'safe': roundtables are discussions — seats read the code, never change it */
  readonly permissionMode: PermissionMode
  /** 'consensus' = auto-rounds until every seat agrees, then a joint synthesis */
  readonly mode: RoundtableMode
  /** Consensus mode: max auto discussion rounds per user message (the wave is round 1) */
  readonly maxRounds: number
  /** Rounds completed since the last user message — mutable cycle state */
  roundsRun: number
  /** Consensus mode: the current cycle ended with a synthesis; a new message reopens */
  concluded: boolean
  readonly participants: RoundtableParticipant[]
  readonly entries: RoundtableEntry[]
}

/** A roundtable plus its live state (never persisted). */
export type RoundtableSnapshot = Roundtable & {
  readonly running: boolean
  /** Participant indexes with a turn in flight — several at once during a wave */
  readonly speaking: readonly number[]
}

/** List-row projection — transcripts stay out so the list is always light. */
export type RoundtableMeta = {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly providers: Provider[]
  readonly entryCount: number
  readonly running: boolean
  readonly branch: string | null
  /** Groups the table under its project in the tree; null = a Chats item */
  readonly repoRoot: string | null
  /** Hidden from the tree, the board and the palette until it is brought back */
  readonly archived: boolean
}

/** Renderer-supplied seat definition (main re-validates every field). */
export type NewRoundtableSeat = {
  readonly provider: Provider
  readonly configDir?: string
  readonly copilotUser?: string
  readonly accountLabel?: string
  readonly model?: string
}

/** Renderer request to open a roundtable. */
export type NewRoundtableRequest = {
  readonly topic: string
  /** null = no repo: the table runs in a scratch dir instead of a worktree */
  readonly repoRoot: string | null
  /** Seats may repeat a provider (different models); main caps the count */
  readonly seats: NewRoundtableSeat[]
  readonly mode?: RoundtableMode
  /** Consensus mode: auto discussion-round cap (main clamps to a sane range) */
  readonly maxRounds?: number
}

/** Push events for a live roundtable (renderer filters by id). */
export type RoundtableEvent =
  | {
      readonly id: string
      readonly type: 'round'
      readonly running: boolean
      /** Rounds completed this cycle — drives the consensus progress line */
      readonly roundsRun?: number
      /** The cycle just closed with a synthesis (consensus mode) */
      readonly concluded?: boolean
      /** The user stopped the round — nothing finished, so nobody is notified */
      readonly stopped?: boolean
    }
  | { readonly id: string; readonly type: 'turn'; readonly speaker: Provider; readonly seat: number }
  /** The seat's turn is over — fires even when no entry was produced (silent stop) */
  | { readonly id: string; readonly type: 'turn-end'; readonly speaker: Provider; readonly seat: number }
  | {
      readonly id: string
      readonly type: 'delta'
      readonly speaker: Provider
      readonly seat: number
      readonly text: string
    }
  | {
      readonly id: string
      readonly type: 'tool'
      readonly speaker: Provider
      readonly seat: number
      readonly toolName: string
      readonly detail: string
      readonly preview?: string
    }
  | {
      readonly id: string
      readonly type: 'entry'
      /** Absolute transcript index — lets the renderer dedupe against its snapshot */
      readonly index: number
      readonly entry: RoundtableEntry
    }

/* ---------- cleanup: stale sessions and worktrees ---------- */

/** Where a worktree came from — Cockpit's own userData tree, or anywhere else. */
export type WorktreeOrigin = 'cockpit' | 'external'

/**
 * Why a stale row refuses to be cleaned. Every block is a thing that would lose
 * work or break something live, so the UI shows them rather than offering a force.
 */
export type CleanupBlock =
  /** Uncommitted changes in the worktree */
  | 'dirty'
  /** An agent turn is running in it right now */
  | 'busy'
  /** The repository's primary checkout — never Cockpit's to remove */
  | 'main'
  /** `git worktree lock` was used on it */
  | 'locked'
  /** A roundtable's shared room: it belongs to the table, not to one session */
  | 'roundtable'
  /** A process (a dev server, a watcher, a shell) still runs inside it */
  | 'process'

/**
 * The worktree a session ran in, carried on the session itself: deleting the
 * session takes this with it. Only ever set when the worktree is removable —
 * the repo's own checkout and anything blocked is never attached to a session.
 */
export type SessionWorktree = {
  readonly path: string
  readonly branch: string | null
  readonly bytes: number | null
  /** Sessions indexed in it — it only goes when every one of them goes */
  readonly sessionCount: number
}

export type StaleSession = {
  /** Session id: `${provider}:${nativeId}` */
  readonly id: string
  readonly provider: Provider
  readonly title: string
  readonly repoName: string | null
  readonly cwd: string | null
  readonly updatedAt: number
  /** Size of the provider's own log file(s) for this session */
  readonly bytes: number
  /** Already archived in Cockpit — still listed, because deleting is the next tier */
  readonly archived: boolean
  /** The worktree deleting this session would also remove; null when it has none */
  readonly worktree: SessionWorktree | null
  readonly blocks: CleanupBlock[]
}

export type StaleWorktree = {
  readonly path: string
  /** Main repo root the worktree is linked to */
  readonly repoRoot: string
  readonly repoName: string
  readonly branch: string | null
  readonly origin: WorktreeOrigin
  /** Newest of: branch-tip commit, session activity in this cwd, directory mtime */
  readonly lastActivity: number
  /** Sessions Cockpit has indexed running in this directory */
  readonly sessionCount: number
  /** Registered in .git/worktrees but gone from disk — prune territory */
  readonly missing: boolean
  /** Commits on HEAD that no remote has. Informational: removing a worktree keeps
   *  its branch, so this only decides whether the branch can go too. */
  readonly unpushed: number
  /** Bytes on disk; null when the directory couldn't be measured */
  readonly bytes: number | null
  readonly blocks: CleanupBlock[]
}

export type CleanupReport = {
  /** Idle threshold the scan applied, in days */
  readonly staleDays: number
  /** The instant the scan called "now" — rows age against it, not against render time */
  readonly scannedAt: number
  /** Oldest-first, capped (CLEANUP_ROW_CAP) — the full index never crosses IPC */
  readonly sessions: StaleSession[]
  /** Stale sessions before the row cap, and what they occupy in total */
  readonly staleSessionCount: number
  readonly staleSessionBytes: number
  /**
   * Stale worktrees no listed session claims — the leftovers. A worktree that a
   * stale session runs in rides on that session instead, so every worktree
   * appears exactly once across the report.
   */
  readonly worktrees: StaleWorktree[]
  readonly staleWorktreeCount: number
  /**
   * Processes still running in a stale worktree, or in one already removed from
   * under them — the dev server nobody stopped. Oldest first, capped.
   */
  readonly processes: OrphanProcess[]
  /** Denominators behind "47 of 312" — everything known, stale or not */
  readonly totalSessions: number
  readonly totalWorktrees: number
}

/** A process left running in an old worktree. */
export type OrphanProcess = {
  readonly pid: number
  /** Full command line, as `ps` shows it */
  readonly command: string
  /** Epoch ms; 0 when unknown */
  readonly startedAt: number
  readonly cwd: string
  /** The worktree it runs in — or, when that is gone, the removed directory */
  readonly worktreePath: string
  readonly repoName: string | null
  readonly branch: string | null
  /** Its worktree is gone: removed under it, leaving the process running */
  readonly worktreeGone: boolean
}

/**
 * A process picked for stopping, as the scan described it. A pid alone can name a
 * different process by the time Stop is clicked, so main signals it only while the
 * command line and start time still match.
 */
export type ProcessTarget = Pick<OrphanProcess, 'pid' | 'command' | 'startedAt'>

/** What one clean actually did. Failures are per-target and never throw the batch. */
export type CleanupResult = {
  readonly cleaned: number
  readonly freedBytes: number
  /** Targets that were refused, each with the reason to show */
  readonly failed: { readonly target: string; readonly reason: string }[]
  /** Branches deleted alongside their worktrees (only fully-merged ones ever are) */
  readonly branchesDeleted?: string[]
}

/** Clock format for session timestamps shown in the UI */
export type TimeFormat = '12h' | '24h'

/* app updates: an installed build checks GitHub Releases; anything else reports unsupported */
export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export type UpdateState = {
  readonly status: UpdateStatus
  /** The build on offer — set from `available` onward */
  readonly version?: string
  /** Download progress, 0–100, while `downloading` */
  readonly percent?: number
  /** The reason for `unsupported`, the failure for `error` */
  readonly message?: string
  /** When the last check against GitHub Releases completed */
  readonly checkedAt?: number
  /**
   * The previous install was rolled back, and why. Carried on every state until a
   * check is asked for by hand: nothing downloads by itself while it is set, so a
   * build that cannot be installed is never fetched again and again in silence.
   */
  readonly installFailure?: string
}

/** Settings › About — how much of updating Cockpit does without being asked. */
export type UpdatePrefs = {
  /** Fetch a newer build as soon as a check finds one */
  readonly download: boolean
  /** Swap the downloaded build in when Cockpit next quits */
  readonly install: boolean
}

export type AppInfo = {
  readonly version: string
  /** false under `npm run dev` and the e2e runs against out/ — the About row says so */
  readonly packaged: boolean
  readonly platform: string
  readonly arch: string
  readonly electron: string
  /** The GitHub Releases page — release notes live there, not in the app */
  readonly releasesUrl: string
}

/* backup: one file holding everything of Cockpit's own that is worth keeping */

export type BackupCounts = {
  readonly scopes: number
  readonly entries: number
  readonly skills: number
  readonly endpoints: number
  readonly sessions: number
}

export type BackupExportResult = {
  readonly path: string
  readonly counts: BackupCounts
  /** true when a passphrase sealed the secrets into the file */
  readonly secretsIncluded: boolean
  /** what a passphrase-less backup had to leave behind ("github (GITHUB_TOKEN)") */
  readonly withheld: readonly string[]
  /** keys this machine's keychain would not decrypt — left out, never silently */
  readonly unreadableKeys: number
  /** skill files skipped for being over the size budget */
  readonly skippedFiles: number
}

/** What an opened file would bring in, shown before anything is written. */
export type BackupPreview = {
  /** handle for the parsed file main is holding; expires after 10 minutes */
  readonly token: string
  readonly createdAt: string
  readonly appVersion: string
  /** secrets are sealed — restoring needs the passphrase */
  readonly sealed: boolean
  readonly counts: BackupCounts
  /** scopes this machine has no repo for; restore the same file again later */
  readonly unmatched: readonly string[]
  /** every distinct MCP command the file would add — read them before restoring */
  readonly commands: readonly string[]
}

export type RestoreSummary = {
  readonly added: {
    readonly entries: number
    readonly skills: number
    readonly endpoints: number
    readonly sources: number
    readonly instructions: number
  }
  /** local things the backup disagreed with and did not replace */
  readonly kept: readonly string[]
  readonly skipped: readonly string[]
  /** restored without their secrets — what to supply, and where */
  readonly needsValues: readonly string[]
  /** handle for undoing this restore, while the config is still untouched since */
  readonly undoId: string | null
}

/**
 * The outcome of sharing a repo's instructions: a pull request opened, the open
 * one updated, or nothing to say that the repo doesn't already say.
 */
export type ShareResult =
  | { readonly status: 'opened' | 'updated'; readonly url: string }
  | { readonly status: 'unchanged'; readonly url?: string }

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
  /** Resolves once the index has finished its first full scan — until then no repos means "not read yet" */
  readonly whenIndexed: () => Promise<void>
  readonly pageSessions: (query: SessionQuery) => Promise<SessionPage>
  /** One indexed session by id (lineage navigation); null when unknown */
  readonly getSession: (sessionId: string) => Promise<SessionMeta | null>
  readonly getSessionMessages: (id: string) => Promise<SessionMessage[]>
  /** Full-text search over transcript contents; a newer call cancels the one in flight */
  readonly searchTranscripts: (query: TranscriptSearchQuery) => Promise<TranscriptSearchResult>
  /** Stop the in-flight transcript search early (the palette closed) */
  readonly cancelTranscriptSearch: () => Promise<void>
  /** Deterministic context briefing for handing this session to another agent */
  readonly getHandoffBriefing: (sessionId: string) => Promise<HandoffBriefing>
  /** Ask the source session's own CLI to rewrite the briefing (resumes it read-only) */
  readonly improveHandoffBriefing: (sessionId: string) => Promise<string>
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
  /* cleanup: one place for stale sessions and worktrees across every agent and repo */
  /** Idle threshold the cleanup view applies, in days (default 30) */
  readonly getStaleDays: () => Promise<number>
  readonly setStaleDays: (days: number) => Promise<void>
  /** Walk every source and every known repo for things idle past the threshold */
  readonly scanCleanup: () => Promise<CleanupReport>
  /** Reversible tier: hide them in Cockpit, touch nothing on disk */
  readonly archiveSessions: (ids: readonly string[]) => Promise<CleanupResult>
  /** Destructive tier: delete the provider's own log files */
  readonly deleteSessions: (ids: readonly string[]) => Promise<CleanupResult>
  /** `git worktree remove` each path, then drop any branch git says is fully merged */
  readonly removeWorktrees: (paths: readonly string[]) => Promise<CleanupResult>
  /**
   * SIGTERM processes the scan reported as left in old worktrees (re-derived first;
   * a pid whose command or start time no longer matches is refused)
   */
  readonly stopProcesses: (targets: readonly ProcessTarget[]) => Promise<CleanupResult>
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
  readonly getExtensions: () => Promise<ExtensionsInventory>
  /** Probe the server (spawn stdio / hit URL) and report whether it answers */
  readonly checkMcp: (name: string) => Promise<McpProbeResult>
  /** Run the agent CLI's own OAuth login for the server; resolves with its output */
  readonly loginMcp: (name: string, agent: Provider, projectPath?: string) => Promise<string>
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
  readonly getAccounts: () => Promise<AccountsSnapshot>
  /** Current subscription usage per configured provider account */
  readonly getUsage: () => Promise<UsageSnapshot>
  /** Aggregate cross-agent work profile (heatmap, per-agent totals, languages) */
  readonly getProfile: () => Promise<ProfileStats>
  readonly getModelEndpoints: () => Promise<ModelEndpoint[]>
  readonly addModelEndpoint: (ep: NewModelEndpoint) => Promise<ModelEndpoint[]>
  readonly removeModelEndpoint: (id: string) => Promise<ModelEndpoint[]>
  /** Give an existing provider its API key (a restore brings definitions, not keys) */
  readonly setEndpointKey: (id: string, apiKey: string) => Promise<ModelEndpoint[]>
  /** Ask the provider itself which models it serves (also refreshes the cached list) */
  readonly listEndpointModels: (id: string) => Promise<string[]>
  /* backup: export to a file the user keeps, restore it here or on another Mac */
  /** Native save dialog, then write the file; null when the user cancels */
  readonly exportBackup: (passphrase?: string) => Promise<BackupExportResult | null>
  /** Native open dialog, then parse and describe the file; null when the user cancels */
  readonly openBackup: () => Promise<BackupPreview | null>
  readonly restoreBackup: (token: string, passphrase?: string) => Promise<RestoreSummary>
  readonly undoRestore: (undoId: string) => Promise<void>
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
  /** Renderer zoom (webFrame) — synchronous, clamped to sane limits */
  readonly getZoomFactor: () => number
  readonly setZoomFactor: (factor: number) => void
  readonly openExternal: (url: string) => Promise<void>
  readonly onIndexUpdated: (cb: () => void) => () => void
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
