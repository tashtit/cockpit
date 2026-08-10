# Cockpit

Unified desktop hub for **Claude Code**, **Codex**, and **GitHub Copilot CLI**: browse every session across providers, continue any conversation, start new agent runs in isolated worktrees, and manage the shared AI setup — from one window.

## Run

```bash
npm install
npm run dev        # dev mode with HMR
npm run typecheck  # tsc (the static gate — there is no linter)
npm test           # vitest: unit + component tiers
npm run test:e2e   # Playwright against the built app (npm run build first)
```

CI (`.github/workflows/ci.yml`) runs typecheck plus all three test tiers.

## What it does (GitHub-first)

- Auto-detects `~/.claude`, `~/.codex`, `~/.copilot` on first run and indexes all sessions found there, **grouped by git repository** (worktree-aware: sessions in linked worktrees group under their main repo; GitHub `owner/repo` is read from the origin remote). Non-repo sessions land in a flat "Chats" section at the bottom of the sidebar.
- Compact **treeview sidebar**, flattened: one **`owner/repo` row per repository** with its sessions under it, ordered by last activity (paginated "more…", global search, per-repo archived section, agent-generated session names). The full index is never shipped to or rendered by the UI.
- **Home — mission control**: a task composer front and center (repo + agent + account + permission mode, ⌘Enter to start), recent activity below. The sidebar stays the exhaustive list.
- **AI Setup**: one place to manage the shared AI experience across all three agents.
  - **Shared instructions**: write one baseline (global, or per-repo) and fan it out into each agent's own instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.copilot/copilot-instructions.md`; in repos `CLAUDE.md` + `AGENTS.md` — Codex and Copilot both read AGENTS.md natively). The shared text lives inside `<!-- cockpit:shared -->` markers; everything outside is that agent's own and never touched. Drift detection (in sync / out of date / not applied) with one-click re-apply, plus inline editing of each full file.
  - **MCP / skills / plugins / marketplaces** inventory, with one-click **MCP sharing** that translates a server definition into each agent's own config format (`~/.claude.json`, `~/.codex/config.toml`, `~/.copilot/mcp-config.json`) and **skill copying** between Claude and Copilot. Claude's per-project MCP servers (under `projects.*` in `~/.claude.json`) are inventoried too, labeled with their project.
- **Per-agent session options**: model override for all agents, sandbox mode for Codex — validated main-side before touching argv.
- **Agent accounts**: detects who each CLI is signed in as per config home (Claude `.claude.json` OAuth, Codex `auth.json` JWT, Copilot's native multi-account `config.json`) plus the `gh` user; identity chips appear throughout, and New Session lets you pick the account when a provider has several config homes.
- **Subscription usage** (in Settings), without ever touching credentials: Claude measured locally from session JSONLs (5h block + trailing 7 days), Codex from the rate-limit snapshots its CLI persists, Copilot premium requests via the GitHub billing API.
- **Fast by architecture**: only per-provider session roots are walked/watched (never `pkg/`, `repos/`, logs, or SQLite files); meta parsing reads at most 256KB per file (copilot's session.start line carries repo/branch/cwd); the stat-cache (mtime+size) persists to userData so restarts only re-parse changed files; scans yield to the event loop so IPC never blocks.
- **Archiving**: sessions can be archived in-app (stored in cockpit config — provider logs have no such flag); archived sessions collapse into a dimmed per-repo section. Sessions archived or deleted in the provider's own app (Copilot's `data.db`, Codex's `archived_sessions/`, the Claude desktop app's session store) are hidden entirely.
- **Settings** view: agent accounts & sources (add/remove extra per-account config homes, with per-source identity and health), a history window (show all sessions or just the last N days), subscription usage, and GitHub identity.
- Watches source dirs — sessions you run in any terminal appear/update live.
- Click a session → parsed transcript (messages, tool calls, results).
- **Always worktrees, always PRs**: "+ New session" creates a `cockpit/<name>` branch in an isolated git worktree (under the app's userData, outside your checkout) and runs the agent there. "Create PR" pushes the branch and runs `gh pr create`. PR state badges (open/draft/merged/closed, GitHub colors) come from `gh pr list`, cached 60s per repo.
- **Working chat**: pick a provider + repo path → chat spawns the CLI headless (`claude -p --output-format stream-json`, `codex exec --json`, `copilot -p`) and streams replies, tool activity, and errors into the window. Multi-turn works via each provider's resume (`--resume` / `exec resume`). Opening an indexed session and typing continues that conversation.
- Permission modes per chat: **Safe** (provider defaults; tools may be blocked in headless mode), **Auto-edit** (`--permission-mode acceptEdits` / `--full-auto`), **YOLO** (bypass approvals — trusted repos only).
- Extra source dirs (isolated per-account config homes) are stored in the app config (`~/Library/Application Support/cockpit/cockpit-config.json`) as `{path, provider, label}`.

## Layout

```
src/shared/types.ts       shared contracts (SessionMeta, RepoInfo, CockpitApi, …)
src/main/parsers/         per-provider session log parsers (failure-tolerant)
src/main/repos.ts         cwd → git repo resolution (worktree-aware, GitHub remote)
src/main/indexer.ts       scan + stat-cache + fs.watch(recursive) + repo grouping + paging
src/main/extensions.ts    MCP/skills/plugins inventory + cross-agent MCP/skill sharing
src/main/instructions-core.ts  shared-instructions pure logic (markers, drift, targets)
src/main/instructions.ts  shared-instructions IO (baseline storage + fan-out)
src/main/github.ts        PR status per repo via `gh pr list` (cached)
src/main/workspace.ts     worktree/branch creation + push/`gh pr create`
src/main/chat.ts          ChatManager: spawn provider CLIs, parse stream events
src/main/accounts.ts      who each agent CLI is signed in as, per config home + `gh` user
src/main/usage.ts         subscription usage per provider (local measurement / CLI snapshots / GitHub billing API)
src/main/providerArchived.ts  sessions archived/deleted in the provider's own app → hidden
src/main/env.ts           PATH fix for GUI-launched CLI spawns (macOS)
src/main/config.ts        source-dir registry + history window
src/main/index.ts         electron bootstrap + IPC
src/preload/index.ts      contextBridge → window.cockpit
src/renderer/             React UI (HomeView, TreeSidebar, ChatView, NewSession, AiSetup, Settings, Select, logos.tsx)
```

## Notes

- File watching uses Node's `fs.watch(root, {recursive: true})` (FSEvents on macOS) — chokidar was dropped after its bundled `fsevents` native module broke on the Electron 43 upgrade; the indexer does its own debouncing and stat-based dirty tracking.

- Session log formats are provider-internal and drift between releases; parsers skip anything they can't read rather than fail.
- The Copilot parser is best-effort (least documented format). If your sessions don't show up, open an issue-to-self: grab one file from `~/.copilot` and adjust `src/main/parsers/copilot.ts`.
- No SQLite yet on purpose — in-memory index is plenty for M1 and avoids native-module rebuild pain. Revisit at M6 (full-text search).
- Copilot chat streams plain text (no structured events), so a *new* Copilot chat doesn't learn its session id mid-conversation — the session appears in the sidebar after the first turn; click it to continue with proper resume. Claude/Codex bind their session id from the first response.
- Codex event stream shapes changed between releases; both the old (`msg.type`) and new (`thread.started`/`item.completed`) shapes are handled.

## License

[Apache-2.0](LICENSE)
