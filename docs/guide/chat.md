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

## Provider quirks

Cockpit smooths over the differences it can, and is honest about the ones it can't:

- **Copilot streams plain text** — no structured events. A *new* Copilot chat can't learn its session id mid-conversation, so the session appears in the sidebar after the first turn; click it there to continue with proper resume. (Claude and Codex bind their session id from the first response.)
- **Codex event shapes changed between releases** — both the old (`msg.type`) and new (`thread.started` / `item.completed`) stream formats are handled, so old and new CLI versions both work.
- **Safe mode can block tools** — in headless mode, provider defaults may refuse tool use entirely. If an agent reports it can't run tools, that's the permission mode, not a bug; see [permission modes](/guide/worktrees-and-prs#permission-modes).

::: tip Which model?
The task composer's per-agent options let you override the model for any provider — and if you've configured [custom providers](/guide/custom-providers), the model picker lists their catalogs too.
:::
