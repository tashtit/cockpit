# Sessions & the index

Everything in Cockpit starts from the session index: a live, repo-grouped view of every conversation you've had with any of the three agents, on any machine account, in any terminal.

## Where sessions come from

Cockpit watches each provider's session root — `~/.claude`, `~/.codex`, `~/.copilot`, plus any extra source directories you add in Settings. Sessions you run in a plain terminal appear and update live; there's no import step and no daemon.

Each session's working directory is resolved to its **git repository**, worktree-aware: a session run in a linked worktree groups under the main repository, and the sidebar row is named `owner/repo` from the origin remote. Sessions with no repository land in a flat **Chats** section at the bottom.

## The sidebar

One row per repository, ordered by last activity, with that repo's sessions underneath:

- **Pagination** — long histories load behind a "more…" row; the full index is never shipped to the UI at once.
- **Search** — global, across all providers and repos.
- **Names** — sessions carry their agent-generated titles where the provider records one.
- **PR badges** — sessions on a Cockpit-created branch show their pull request state (open, draft, merged, closed) in GitHub's colors.

Click a session to read its parsed transcript — messages, tool calls, and results. Type below the transcript to continue the conversation with the same provider; see [Chat](/guide/chat).

### Keyboard

| | |
| --- | --- |
| <kbd>⌘K</kbd> | command palette |
| <kbd>⌘N</kbd> | new task |
| <kbd>⌘[</kbd> / <kbd>⌘]</kbd> | back and forward through views you've visited |
| <kbd>⌘,</kbd> | settings |
| <kbd>Esc</kbd> | back out of a secondary view |

Backing into the conversation that's currently running just flips the view — the live log keeps streaming, untouched.

## Archiving

Two kinds of "gone", handled differently:

- **Archived in Cockpit** — you can archive sessions in-app; they collapse into a dimmed per-repo section. Provider logs have no archive flag, so this state lives in Cockpit's own config.
- **Archived or deleted in the provider's own app** — Cockpit reads each provider's native archived/deleted state (Copilot's `data.db`, Codex's `archived_sessions/`, the Claude desktop app's session store) and hides those sessions entirely.

## The history window

By default Cockpit shows your full history. If years of sessions make the sidebar noisy, set a **history window** in Settings — sessions idle for longer than N days disappear from the index (the files on disk are never touched).

## Why it's fast

The index stays snappy on huge histories because of a few deliberate constraints:

- Only per-provider session roots are walked and watched — never package caches, cloned repos, logs, or SQLite files.
- Meta parsing reads at most 256&nbsp;KB per file, and parsers are failure-tolerant: session formats are provider-internal and drift between releases, so anything unreadable is skipped rather than failing the scan.
- A stat-cache (mtime + size) persists across restarts, so relaunching only re-parses files that actually changed.
- Scans yield to the event loop, so the UI never blocks behind indexing.

::: tip Sessions missing?
If a provider's sessions don't show up — most commonly Copilot, whose log format is the least documented — see [Troubleshooting](/guide/troubleshooting#sessions-missing-from-the-sidebar).
:::
