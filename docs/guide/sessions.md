# Sessions & the index

Everything in Cockpit starts from the session index: a live, repo-grouped view of every conversation you've had with any of the three agents, on any machine account, in any terminal.

## Where sessions come from

Cockpit watches each provider's session root — `~/.claude`, `~/.codex`, `~/.copilot`, plus any extra config homes you add in Settings. Sessions you run in a plain terminal appear and update live; there's no import step and no daemon.

It also reads the sessions of agents it doesn't run — see [Agents Cockpit reads](#agents-cockpit-reads) below.

Each session's working directory is resolved to its **git repository**, worktree-aware: a session run in a linked worktree groups under the main repository, and the sidebar row is named `owner/repo` from the origin remote. Sessions with no repository land in a flat **Chats** section at the bottom.

## The sidebar

One row per repository, ordered by last activity, with that repo's sessions underneath:

- **Width** — drag the sidebar's right edge, or focus it and use the arrow keys; double-click it to reset. See [Resizing and zoom](/guide/what-is-cockpit#resizing-and-zoom).
- **Pagination** — long histories load behind a "more…" row; the full index is never shipped to the UI at once.
- **Search** — global, across all providers and repos, by title, branch, path or id.
- **Names** — sessions carry their agent-generated titles where the provider records one.
- **PR badges** — sessions on a Cockpit-created branch show their pull request state (open, draft, merged, closed) in GitHub's colors.
- **Child sessions** — a session that another session started sits under that session, indented one step per level. Copilot's app does this when a session creates new sessions for pieces of its work, each in its own workspace. Open a child to get a **by &lt;parent&gt;** chip in its chat header that takes you back to the session that started it.
  Fold a family with the **▾ N** button after the parent's title (or <kbd>←</kbd> / <kbd>→</kbd> on the parent's row); Cockpit remembers the fold. A folded parent still shows when a session inside it is running, finished or waiting for you, and the session you have open is never folded away.

Click a session to read its parsed transcript — messages, tool calls, and results. Type below the transcript to continue the conversation with the same provider; see [Chat](/guide/chat).

### In Cockpit or with its agent

Every session is driven from one place at a time:

- **In Cockpit** — Cockpit started it (a new task, a handoff, a follow-up), or you took it over. Cockpit sends its turns, and its row carries Cockpit's hexagon after the title.
- **In its agent** — it came from a terminal or the agent's own app, or you released it back there. Cockpit shows its log as it grows but sends nothing to it until you take it over.

Rows on the home board and in the <kbd>⌘K</kbd> palette carry the same hexagon. Hover a row to see which, and how it got there. For a session from outside Cockpit that includes where it was opened, as its log records it: *In the Claude app*, *In a terminal*, *In an editor*, *In the Codex app*. A session a script ran with `claude -p` or `codex exec` reads *run headless*. Copilot's CLI doesn't record whether it ran in a terminal or headless, so its sessions read *In the Copilot CLI*. To change hands, open the session: see [Taking over and releasing](/guide/chat#taking-over-and-releasing).

To see only one side, open the eye button beside the search field and pick **In Cockpit** or **Outside Cockpit** under *Sessions*. The tree keeps only the projects with sessions on that side, the counts follow, and search stays inside the filter. The choice outlives a restart, so while it's on a strip under the search field says *Only sessions in Cockpit* — **Show all** there puts every session back.

### Filtering by agent

The same eye button lists every agent with sessions under *Agents*, each with its count. Untick one to take its sessions out of the tree: projects with no session of a shown agent leave it, the counts follow, and search stays inside the filter. It combines with *Sessions* above, and is remembered the same way. The strip says what is hidden (*Only sessions not Cline*), and **Show all** clears both filters. An agent Cockpit starts reading later shows up ticked, and a hidden agent stays in the list to be ticked again even when it has no sessions right now.

### Searching inside transcripts

"Where did I discuss X?" — across every agent at once, which no single vendor can
answer. Press <kbd>⌘K</kbd>, type the words, and pick **search transcripts for …** under
the session matches. Cockpit streams through the transcripts on demand (nothing is
indexed or uploaded), scoped to the repo you are looking at — a row in the results widens
the search to every repo. It follows the tree's agent filter too: with an agent hidden,
the search leaves its transcripts out and says so (*in all repos, not Cline*), and a
**Search every agent** row takes them back in. Each hit shows the message around the match, marked, with who
said it; picking one opens that session **at that message** — scrolled into view and
briefly highlighted, however far back it is.

Only what you and the agents *said* is searched: tool calls and their output stay out,
so a file that every session read doesn't match every session. Large transcripts are
read only up to a cap and long searches stop after a time budget — the line under the
results says how much was read and whether it stopped early, so a partial answer never
looks like a complete one. <kbd>Backspace</kbd> on an empty query goes back to the
normal palette; <kbd>Esc</kbd> closes it.

### Keyboard

| | |
| --- | --- |
| <kbd>⌘K</kbd> | command palette |
| <kbd>⌘N</kbd> | new task |
| <kbd>⌘[</kbd> / <kbd>⌘]</kbd> | back and forward through views you've visited |
| <kbd>⌘,</kbd> | settings |
| <kbd>Esc</kbd> | back out of a secondary view |

Backing into the conversation that's currently running just flips the view — the live log keeps streaming, untouched.

### Flying and landed

A session whose agent is running right now is **flying**: a small turning ring on its row in the sidebar and the ⌘K palette, and a pulsing dot in the agent's color on the home board. When the turn ends and you haven't opened the session since, it has **landed** — a solid dot (blue in the sidebar and the palette, the agent's color on the board) and `landed <time>` — until you open it, or archive it here or in the agent's own app. Two more states say a session **needs you**: an agent that has stopped to ask a question or for a permission shows a question glyph and `asks you`, on top of the board whatever else is true of it — in place of the flying ring, and for as long as the question stays open, even after you have opened the session — and an open pull request on the session's branch that has failing checks or changes requested shows GitHub's red x and `#57 checks failing`. The same set is what the Dock badge counts; see [Notifications](/guide/notifications).

A session you run in a terminal or the provider's own app counts as flying while its log keeps growing — Cockpit reads the tail of the log on every write. When the log goes quiet for a minute and a half it drops back to the ground without landing; while the last thing written is a tool call still waiting for its result (a test suite, a build), Cockpit waits ten minutes instead, since those write nothing until they finish. An agent stopped on a question writes nothing until you answer, however long that takes, so it keeps its `asks you` mark for as long as the terminal or app that asked is still open and waiting, and drops only once that process has gone.

## Agents Cockpit reads

Cockpit drives Claude Code, Codex and Copilot. It also **reads** the sessions of these agents, so their work sits in the same sidebar, under the same repositories:

| Agent | Where its sessions are found |
| --- | --- |
| Gemini CLI | `~/.gemini/tmp/*/chats/` |
| Cursor | the editor's own chats, in its storage database, and the agent transcripts under `~/.cursor/projects/` |
| Cline | the extension's storage in every editor it is installed in — VS Code, Cursor, Windsurf or any other VS Code-family editor — and the Cline CLI's `~/.cline/data` |
| Roo Code | the extension's storage in every editor it is installed in |
| opencode | its database, `~/.local/share/opencode/opencode.db`, and the file store older versions kept beside it |
| Antigravity | one database per conversation under `~/.gemini/antigravity-ide/` and `~/.gemini/antigravity-cli/` |

A few things these agents keep cannot be read. Antigravity's earliest conversations are encrypted, so a home holding only those is not listed. Cursor chats that never got past a draft have nothing in them to show. A chat Cursor keeps both in its database and as an agent transcript appears once, from whichever record holds more of it.

Nothing needs setting up. Each launch looks for these homes, adds any that appeared since the last one, and lists them in **Settings › Accounts** under **Other agents · read only**. A home you remove there stays removed; detection never adds it back.

A session of one of these agents renders as any session does: its transcript, tool calls, edits, to-do lists and test runs, and ⌘K's transcript search covers it. Cleanup lists these sessions like any other, and deleting one removes what its agent keeps for it; see [Cleanup](/guide/cleanup).

Cockpit can also start and continue sessions of Gemini CLI, Cursor, Cline and opencode, through each agent's own ACP server. That works once the agent's CLI answers Cockpit's handshake, or once you add an ACP agent for it yourself; see [ACP agents](/guide/acp-agents#agents-cockpit-otherwise-only-reads). The agent then appears in the New session form, in Home's composer and in **Continue in…**. Its sessions open with a composer, and you take one over from its agent the same way you would a Claude session.

Until then, and for Roo Code and Antigravity, which have no ACP mode, a session opens read-only and has no composer. To pick the work up, use **Continue in…**. It hands the session, with a briefing built from its transcript, to another agent in the same directory. Live status and notifications for turns that run outside Cockpit follow the three agents Cockpit runs headless.

## Archiving

Two kinds of "gone", handled differently:

- **Archived in Cockpit** — you can archive sessions in-app; they collapse into a dimmed per-repo section. Provider logs have no archive flag, so this state lives in Cockpit's own config.
- **Archived or deleted in the provider's own app** — Cockpit reads each provider's native archived/deleted state (Copilot's `data.db`, Codex's `archived_sessions/`, the Claude desktop app's session store) and hides those sessions entirely.

## The history window

By default Cockpit shows your full history. If years of sessions make the sidebar noisy, set a **history window** in **Settings › View** — sessions idle for longer than N days disappear from the index (the files on disk are never touched). The presets run from **Last day**, for when you only want what you touched today, out to a year.

## Why it's fast

The index stays snappy on huge histories because of a few deliberate constraints:

- Only per-provider session roots are walked and watched — never package caches, cloned repos, logs, or SQLite files.
- Meta parsing reads at most 256&nbsp;KB per file, and parsers are failure-tolerant: session formats are provider-internal and drift between releases, so anything unreadable is skipped rather than failing the scan.
- A stat-cache (mtime + size) persists across restarts, so relaunching only re-parses files that actually changed.
- Scans yield to the event loop, so the UI never blocks behind indexing.

::: tip Sessions missing?
If a provider's sessions don't show up — most commonly Copilot, whose log format is the least documented — see [Troubleshooting](/guide/troubleshooting#sessions-missing-from-the-sidebar).
:::
