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
for its result. Your draft stays in the composer meanwhile.

Once you send from Cockpit, the turn streams in as usual and the transcript is Cockpit's
until it ends; a turn typed in the terminal after that shows up here again as it lands.

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

## When the agent asks you something

An agent that stops to ask — Claude Code's `AskUserQuestion` or its plan gate, Codex's
`request_user_input` — records the question *and the answers it offered*. Cockpit reads
them off the transcript and renders the last unanswered one as a card in the chat: the
question, its options with the agent's own one-line descriptions, and **Send answer**.
Multi-select questions take several picks; a question the conversation has moved past
stays a plain tool row.

When the question is Claude's plan gate, the card shows the plan itself above
**Approve the plan** and **Keep planning**, so you approve what you have read, not a
title. A long plan scrolls inside the card, or **Open in the Work panel** gives it the
whole side of the window.

The pick is sent as your next message, worded from the question (`Answering your
question: - Which layout…? → packages/<runtime>`), so it stands on its own in the
transcript the agent resumes from — and you can always ignore the card and type your
own answer instead. Nothing is sent until you press the key.

::: tip A question is also a badge
The same stopped-to-ask state puts `asks you` on the session's row, on the home board
and in the Dock badge, whether the session runs in Cockpit or in a terminal; see
[Notifications](/guide/notifications).
:::

## Plans, to-dos and edits: the Work panel

Agents hand you things to look at while they work: a plan to approve, a to-do list they
tick off, edits to your files, and the checks they ran on them. Cockpit reads each of them
from the agent's own tool calls and opens them in the **Work** panel beside the
conversation. The panel has four tabs:

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

A tool row that carries one of these is a single click: the row names the plan, the list's
progress or the files and their `+`/`−` counts, and clicking it opens the panel at that
item; a check's row also says whether it passed or failed. The header's **Work** key (⌘J)
appears once the conversation holds any of them. It opens the panel on whatever matters
now: a plan waiting for you, else a list still in progress, else a check that failed,
else the edits. Escape closes the panel and returns you to where you were.

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

## Continuing in another agent

**Continue in…** in the header starts a new session with another agent (or a fresh one
with the same agent) in the same directory and on the same branch. The new agent's first
message is a **Briefing** you can read and edit before sending: the original request,
the agent's latest plan, its to-do list (finished steps checked), how each of its checks
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
