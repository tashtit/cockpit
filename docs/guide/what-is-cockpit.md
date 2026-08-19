# What is Cockpit?

Cockpit is a macOS desktop hub for the three big coding agents — **Claude Code**, **Codex**, and **GitHub Copilot CLI**. If you use more than one of them, your work is scattered across three home directories, three session formats, and three configuration systems. Cockpit puts all of it in one window: browse every session across providers, continue any conversation, start new agent runs in isolated worktrees, and manage the shared AI setup once instead of three times.

## The problem it solves

Each agent CLI keeps its own world:

| | Sessions | Instructions | MCP config |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/**` | `~/.claude/CLAUDE.md` | `~/.claude.json` |
| Codex | `~/.codex/sessions/**` | `~/.codex/AGENTS.md` | `~/.codex/config.toml` |
| Copilot CLI | `~/.copilot/**` | `~/.copilot/copilot-instructions.md` | `~/.copilot/mcp-config.json` |

Cockpit indexes all three, groups everything by **git repository**, and gives you one place to read transcripts, resume conversations, launch new work, and keep instructions and MCP servers in sync across agents.

## GitHub-first by design

Cockpit organizes around repositories, not providers:

- The sidebar shows one **`owner/repo` row per repository**, with that repo's sessions from every provider underneath, ordered by last activity. Sessions in linked worktrees group under their main repo; the `owner/repo` identity comes from the origin remote.
- New work follows an **always-worktrees, always-PRs** model: every task gets its own branch in an isolated git worktree, and finished work ships as a pull request via the GitHub CLI. Your checkout is never touched. See [Worktrees & PRs](/guide/worktrees-and-prs).
- PR state badges (open, draft, merged, closed) appear on sessions, straight from `gh pr list`.

Sessions that don't belong to any repository land in a flat **Chats** section at the bottom of the sidebar.

## What's in the window

- **Home — mission control.** A task composer front and center: pick a repo, agent, account, and permission mode, then ⌘Enter to start. Recent activity lives below; the sidebar stays the exhaustive list.
- **Sessions.** Click any session for a parsed transcript — messages, tool calls, results. Type in an indexed session to continue it. See [Sessions & the index](/guide/sessions).
- **Chat.** Cockpit spawns the provider CLI headless and streams replies and tool activity live. See [Chat](/guide/chat).
- **Agents.** Shared instructions with drift detection, MCP/skills/plugins inventory, and one-click sharing across the three agents. See [The Agents view](/guide/agents).
- **Settings.** Accounts and config-home sources, subscription usage, history window, GitHub identity. See [Accounts & usage](/guide/accounts-and-usage).

## How it's built

Three Electron processes with a strict boundary: all filesystem, git, and CLI work happens in the main process; the React UI is fully sandboxed and only ever sees paged, validated data over a typed IPC surface. The indexer is deliberately frugal — it walks only per-provider session roots, reads at most 256&nbsp;KB per file, and persists a stat-cache so restarts re-parse only what changed. Session log formats are provider-internal and drift between releases, so parsers skip what they can't read rather than fail the scan.

::: tip Dark, and only dark
Cockpit is dark-mode-only by design — these docs follow suit.
:::
