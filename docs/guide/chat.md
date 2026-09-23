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

The pick is sent as your next message, worded from the question (`Answering your
question: - Which layout…? → packages/<runtime>`), so it stands on its own in the
transcript the agent resumes from — and you can always ignore the card and type your
own answer instead. Nothing is sent until you press the key.

::: tip A question is also a badge
The same stopped-to-ask state puts `asks you` on the session's row, on the home board
and in the Dock badge, whether the session runs in Cockpit or in a terminal; see
[Notifications](/guide/notifications).
:::

## Provider quirks

Cockpit smooths over the differences it can, and is honest about the ones it can't:

- **Copilot streams plain text** — no structured events. A *new* Copilot chat can't learn its session id mid-conversation, so the session appears in the sidebar after the first turn; click it there to continue with proper resume. (Claude and Codex bind their session id from the first response.)
- **Codex event shapes changed between releases** — both the old (`msg.type`) and new (`thread.started` / `item.completed`) stream formats are handled, so old and new CLI versions both work.
- **Safe mode can block tools** — in headless mode, provider defaults may refuse tool use entirely. If an agent reports it can't run tools, that's the permission mode, not a bug; see [permission modes](/guide/worktrees-and-prs#permission-modes).

::: tip Which model?
The task composer's per-agent options let you override the model for any provider — and if you've configured [custom providers](/guide/custom-providers), the model picker lists their catalogs too.
:::
