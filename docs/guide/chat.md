# Chat

Cockpit's chat is a real working surface, not a log viewer: it spawns the provider's own CLI headless and streams the conversation — replies, tool activity, errors — into the window as it happens.

## How a turn runs

When you send a message, Cockpit launches the provider CLI in the session's working directory:

| Provider | Spawn |
| --- | --- |
| Claude Code | `claude -p --output-format stream-json` |
| Codex | `codex exec --json` |
| Copilot CLI | `copilot -p` |

The structured event stream (where the provider has one) is parsed into messages, tool calls, and results. Multi-turn conversation works through each provider's native resume (`--resume` for Claude, `exec resume` for Codex), so a chat started in Cockpit is a normal session you could equally continue from a terminal — and vice versa.

## Continuing an indexed session

Open any session from the sidebar and type: Cockpit resumes that conversation with the same provider, in the same working directory. There's no separate "import" — the index *is* the chat history.

### Taking over and releasing

The chat header says who drives the session, first thing under the title: **In Cockpit**, or, for one that lives with its agent, where it was opened — **In the Claude app**, **In a terminal** — or just **In Claude** when its log doesn't say. See [In Cockpit or with its agent](/guide/sessions#in-cockpit-or-with-its-agent).

A session that came from a terminal or the agent's own app is Cockpit's to read, not to send to. A bar above the composer says so, and **Send** stays off — your draft is kept — until you press **Take over**. From then on Cockpit sends its turns. Close it where it was open first — the bar names the place when the log does — so the two don't both write to it. **Take over** waits while the agent is running a turn elsewhere; if that turn is waiting on a question the agent asked there, the bar says so — answer it there, then take the session over.

A session Cockpit holds opens the same bar from its **In Cockpit** chip:

- **Release to Claude** hands it back. Cockpit stops sending to it and goes back to following its log. It waits while a turn Cockpit started is still running.
- **Open in Terminal** releases it and resumes it in the agent's own interactive CLI, in the session's directory, as the account it was recorded under: `claude --resume <id>`, `codex resume <id>` or `copilot --resume=<id>`. It is offered on a session with its agent as well.

Cockpit asks nothing of the agent to do this. Who drives a session is Cockpit's own record, kept beside its archive list and carried by [Backup](/guide/backup). Sessions in Cockpit's own worktrees count as started by Cockpit.

### Coming back to a turn in flight

A turn Cockpit started keeps running while you look elsewhere — another session, the
board, ⌘[ back through your history, even a reload of the window. Open its session again
and you are back in the turn: the transcript is read from the log, the reply streams in
from there without repeating a line, and **Stop** stands where **Send** was. A permission
question the agent asked while you were in another chat is waiting for you.

A session runs one turn at a time. Cockpit won't start a second one beside a turn that is
still going; stop it, or wait for it to finish.

### A session that is running somewhere else

Most sessions are not Cockpit's: they run in a terminal or in the provider's own app, and
what Cockpit shows is their log. While such a session is [flying](/guide/sessions#flying-and-landed),
the transcript follows the log — every write the index notices re-reads it, so the
conversation grows on screen as the agent works — and the chat carries the same pulsing
line the board does, *Claude is working elsewhere…*.

**Send waits for it.** Cockpit cannot stop a turn it did not start, and resuming a session
under one would run a second turn on the same log (Claude forks the conversation; Codex
and Copilot append to the same file). The button lifts on its own once the log goes
quiet — the windows are the ones in [Flying and landed](/guide/sessions#flying-and-landed):
a minute and a half after the last write, ten minutes while a tool call is still waiting
for its result, and for as long as the agent is still waiting there on a question it asked.
Your draft stays in the composer meanwhile.

Once you take it over and send from Cockpit, the turn streams in as usual and the
transcript is Cockpit's until it ends; a turn typed in the terminal after that shows up
here again as it lands.

Long transcripts open on their newest 400 messages; the line at the top says how many
there are and shows the next 400 when you ask, without moving what you were reading. If
you scroll up while the agent is still writing, the transcript stays where you put it and a
**New messages** key appears at the bottom edge — press it to go back to the latest.

The permission mode sits beside **Send** and applies to the next turn you send. Tool activity reads one row per call: the command or file it touched, and its result's first line on the right — expand the row for the full input and output. In a narrow window a long first line steps aside so the command stays readable; a short verdict such as `ok` or `20 passed` keeps its place.

Replies render as markdown: code blocks carry a **Copy** button, and a link opens in your
default browser rather than inside Cockpit — the window itself never navigates away from
the app. Relative paths and `mailto:` links are shown as plain text, since there is
nowhere for them to go. A reply longer than 64 KB, or one the markdown renderer cannot
draw, is shown as its plain text instead — in its own row, with the rest of the
transcript formatted as usual.

Quitting Cockpit stops the turns it started, tools and all; closing the window stops them
too, but on macOS Cockpit keeps running in the Dock and keeps watching everything else.

## Moving between your messages

A long session is mostly the agent talking, and what you asked gets buried under it. Once
you have sent two messages, a column of short marks runs down the right edge of the
transcript, one per message you sent, oldest at the top. Point at a mark to read the
message. Click it and the transcript scrolls so that message sits at the top with the
agent's answer below it. The mark of the part you are reading is the longer blue one.

From the keyboard, **⌥⌘↑** and **⌥⌘↓** go to your previous and next message from wherever
you are. Part-way through a long answer, ⌥⌘↑ first goes back to the message that asked for
it. The rail is also a single Tab stop: ↑ and ↓ walk the marks, Home and End go to your first
and latest message.

The chat draws only the newest 400 messages at first, but every message you sent has a mark.
Going to an older one draws the transcript back to it.

## When the agent asks you something

An agent that stops to ask — Claude Code's `AskUserQuestion` or its plan gate, Codex's
`request_user_input`, Copilot CLI's `ask_user` or its plan gate — records the question
*and the answers it offered*. Cockpit reads
them off the transcript and renders the last unanswered one as a card in the chat: the
question, its options with the agent's own one-line descriptions, and **Send answer**.
Multi-select questions take several picks; a question the conversation has moved past
stays a plain tool row. When none of the answers fits, pick **Other** at the bottom of
the list and write your own — it is sent in place of a pick (or beside the picks, on a
multi-select question). Enter sends it, Shift+Enter starts a new line.

When the question is a plan gate, the card shows the plan itself above
**Approve the plan** and **Keep planning**, so you approve what you have read, not a
title. A long plan scrolls inside the card, or **Open in the Work panel** gives it the
whole side of the window.

The pick is sent as your next message, worded from the question (`Answering your
question: - Which layout…? → packages/<runtime>`), so it stands on its own in the
transcript the agent resumes from — and you can always ignore the card and type in
the message box instead. Nothing is sent until you press the key.

While the agent is still waiting in a terminal or its own app, the card shows the
question but holds **Send answer**: answer it there, where the process is blocked on it.
Answering here as well would start a second turn on the same session. Once that turn
ends, the card can send.

::: tip A question is also a badge
The same stopped-to-ask state puts `asks you` on the session's row, on the home board
and in the Dock badge, whether the session runs in Cockpit or in a terminal; see
[Notifications](/guide/notifications).
:::

## Plans, to-dos and edits: the Work panel

Agents hand you things to look at while they work: a plan to approve, a to-do list they
tick off, edits to your files, the checks they ran on them, files and pages they share
with you, and work they suggest for later. Cockpit reads each of them from the agent's own
tool calls and opens them in the **Work** panel beside the conversation. The panel has six
tabs:

- **Plan**: the plan the agent proposed (Claude Code's plan mode, Copilot CLI's
  `exit_plan_mode`), rendered as a document. If the agent revised it, **Earlier** and
  **Later** step through each version. While the plan is waiting for your approval, the
  tab says so. Copilot writes its plan to a file (`plan.md`) and asks for approval with
  only a summary, so the tab shows the file as it stood when Copilot asked.
- **To-dos**: the agent's list as it stands now: Claude Code's tasks (or its older
  `TodoWrite` list), Codex's plan, Copilot's to-do table, or an ACP agent's plan. Each
  step shows as not started, in progress, done or, for Copilot, blocked.
- **Edits**: every file the agent changed, in the order it first touched them, including
  the edits of any subagent Claude Code handed work to. Each change appears the way the
  call described it: a Claude `Edit` or `Write`, a Codex or Copilot patch, a Copilot
  `edit` or `create`. An edit whose call failed is still listed, marked **didn't
  apply**. Copilot's writes to its own plan file are the plan, not edits, so they are not
  listed.
- **Checks**: how the agent's tests, typecheck, linter, end-to-end tests and build last
  ended, whichever of them it ran. Each shows **passed** or **failed**, the command, the
  end of what it printed and the exit code. A check is marked **edited since** when the
  agent changed files after it ran, since it no longer covers them. Earlier runs of the
  same check are one click away. Cockpit recognizes a check by the tool it runs
  (`vitest`, `tsc`, `eslint`, `cargo test`, …) or by the script it hands `npm`, `pnpm`,
  `yarn`, `bun`, `nx` or `turbo` (`npm run typecheck`). It reads how the run ended from
  the test runner's own summary, since a test run piped through `tail` exits with
  `tail`'s status, and from the exit code when nothing else in the command could have
  set it. A `git rebase` that fails before the tests run isn't blamed on the tests. A
  run the agent sent to the background has no result until it finishes, and one you
  refused has none at all.

- **Files**: what the agent sent you and the pages it opened for you, newest first:
  - files Claude Code sends you (`SendUserFile`) and pages it publishes;
  - what Copilot CLI writes to its session's own `files/` folder, such as a drafted PR
    body or a report;
  - the local previews either agent opens.

  An image shows as itself, a Markdown file renders, and other text shows its first lines.
  **Open** hands a document or image to its app, and **Show in Finder** reveals any file.
  Cockpit only opens a file the session itself shared, and never opens anything that
  would run. A file an agent kept in a temporary folder may be gone by the time you
  look; the tab says so. Copilot's writes to its `files/` folder are listed here rather
  than under Edits, since they aren't changes to your repository.

- **Follow-ups**: work the agent noticed outside the task and suggested for a session of
  its own. In the Claude desktop app these appear as suggestion chips. Each one shows its
  title, why the agent suggested it, and the prompt it was written to start with.
  **Start a session…** opens New session with the suggestion's title and prompt filled
  in, on the project the suggestion names or else this session's own. The title becomes
  the branch name and the session's name. Pick any agent to take it. Cockpit notes
  on this Mac which suggestions you've started. A suggestion the agent later withdrew is
  marked **withdrawn**, with its reason, and can't be started.

A tool row that carries one of these is a single click: the row names the plan, the list's
progress or the files and their `+`/`−` counts, and clicking it opens the panel at that
item; a check's row also says whether it passed or failed. The header's **Work** key (⌘J)
appears once the conversation holds any of them. It opens the panel on whatever matters
now: a plan waiting for you, else a list still in progress, else a check that failed,
else what the agent shared, else the edits, else its follow-ups. Escape closes the panel and returns you to where you were.

The panel's width is yours. Drag its left edge — the cursor changes over it — to give a
long diff more room, or the conversation more; the conversation always keeps enough room
to read, so on a smaller window the edge stops sooner. The edge is in the Tab order too,
just before the panel's tabs: <kbd>←</kbd> / <kbd>→</kbd> move it a step, <kbd>Home</kbd> /
<kbd>End</kbd> take it to its narrowest and widest. Double-click the edge to go back to the
default width. The width is remembered on this Mac, and a roundtable's **Evidence** panel
shares it.

When the window is too narrow to hold the conversation and the panel side by side, the
panel covers the conversation until you close it, the same way **Changes** does.

::: tip What the agent said, and what is on disk
The Edits tab shows what each call *said* it changed. [**Changes**](/guide/worktrees-and-prs)
(⌘D) is the worktree's own diff, which is the record of what is actually on disk. A Codex
turn that Cockpit is streaming reports which files it changed but not the lines; reopen
the session once the turn ends to read the lines from its log.
:::

A subagent's edits appear in the conversation too, right after the call that started
it, so you can see where the work was handed off.

Copilot CLI keeps its to-dos in a table of the session's own database rather than in
its log. Cockpit reads that table as it stands now, so the list appears on the last
call that changed it; earlier versions of the list aren't kept anywhere.

## Side chat: questions that don't join the session

Sometimes you want to ask the agent something without adding it to the session. You might
want to know why it chose an approach, what is left, or what a file it just read does. The
header's **Side chat** key (⌘L) opens a panel beside the conversation for that. Each question
is answered by a throwaway copy of the conversation as it stands, so:

- **You can ask while a turn is running.** The copy knows everything up to the moment you
  ask, and the session keeps working. That applies to a turn running in Cockpit, in a
  terminal or in the agent's own app.
- **Nothing reaches the session.** The question and the answer aren't written to the
  session's log. The agent working on the task never sees them, and the session doesn't
  show up twice in the sidebar.
- **The copy can read files but not change them.** It can open a file to answer, and the
  answer lists what it looked at.

| Agent | How the copy is made |
| --- | --- |
| Claude Code | `claude -p --resume <id> --fork-session --no-session-persistence`, with only the Read, Grep and Glob tools and no MCP servers |
| Codex | `codex exec fork <id> --ephemeral`, in a read-only sandbox that never asks to leave it |

Copilot CLI can't copy a session or run without saving one, so its sessions have no side
chat. A roundtable seat's session doesn't have one either. The copy runs as the session's
account, and on its custom provider if it has one.

Follow-up questions build on each other: every answer so far goes along with the next
question. **Add to message** puts an answer in your message to the session's agent, where
you can edit it before sending. **Clear** starts the side chat over. One question runs at a
time, and **Stop** ends it. The side chat keeps its answers while the window is open, even
when you switch sessions or close the panel. A reload forgets them.

The side chat and the Work panel share the space beside the conversation, and the width you
drag it to, so opening one closes the other. A half-typed question is still there when you come back, and the first
Escape leaves the question box without closing the panel.

## Continuing in another agent

**Continue in…** in the header starts a new session with another agent (or a fresh one
with the same agent) in the same directory and on the same branch. The new agent's first
message is a **Briefing** you can read and edit before sending: the original request,
the agent's latest plan, its to-do list (finished steps checked), the files and pages it
shared, the follow-ups it suggested (marked as outside the task), how each of its checks
last ended, the recent conversation and tool calls, and the git state of the directory. **Improve with AI**
asks the original agent to write the briefing itself instead.

## Provider quirks

Cockpit smooths over the differences it can, and is honest about the ones it can't:

- **Copilot streams plain text** — no structured events. A *new* Copilot chat can't learn its session id mid-conversation, so the session appears in the sidebar after the first turn; click it there to continue with proper resume. (Claude and Codex bind their session id from the first response.)
- **Codex event shapes changed between releases** — both the old (`msg.type`) and new (`thread.started` / `item.completed`) stream formats are handled, so old and new CLI versions both work.
- **Newer Codex runs its tools from a script** — rather than calling tools one at a time, it writes a short JavaScript cell that calls them. A transcript shows what the cell ran, one row per command, MCP call, web search or viewed image, with each command's exit status: the same rows a live turn streams, not the script itself. A session whose log records no individual runs shows each script as one `exec` row instead, named after the first tool it calls (`git status (+2 more)`).
- **Safe mode can block tools** — in headless mode, provider defaults may refuse tool use entirely. If an agent reports it can't run tools, that's the permission mode, not a bug; see [permission modes](/guide/worktrees-and-prs#permission-modes).

::: tip Which model?
**New session**'s per-agent options pick the model and thinking level for any agent, from the models that agent offers under your account — and if you've configured [custom providers](/guide/custom-providers), the model picker lists their catalogs too.
:::
