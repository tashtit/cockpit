# ACP agents

The **Agent Client Protocol** is an open standard for editors and agents to talk to each
other: JSON-RPC over the agent's stdin and stdout, in the spirit of the Language Server
Protocol. Cockpit can drive an agent over ACP instead of that CLI's own one-shot flags.

It is a strictly better conversation, and for Copilot the difference is stark:

| | `copilot -p` | `copilot --acp` |
| --- | --- | --- |
| Stream | plain text | typed events |
| Session id | never announced | returned when the session starts |
| Resuming | unreliable | supported |
| Tool calls | invisible | shown as they happen, with the command |
| Permissions | pre-answered by a flag | asked, and answered here |

## It happens on its own

Cockpit runs one ACP handshake per agent at startup. If your CLI answers it, new sessions
for that agent go over the protocol; if it doesn't — an older CLI, or one that never
supported it — nothing changes and sessions run exactly as they did before.

Nothing about your session history changes either. An ACP session is written to the same
place that CLI always wrote to, so it appears in the sidebar, resumes, and reports live
status like any other.

## Agents Cockpit otherwise only reads

For Gemini CLI, Cursor, Cline and opencode, ACP is the only way Cockpit runs them. Each has a built-in definition, used once its CLI answers the handshake:

| Agent | Command |
| --- | --- |
| Gemini CLI | `gemini --acp` |
| opencode | `opencode acp` |
| Cursor | `cursor-agent acp` |
| Cline | `cline --acp` |

Once one answers, that agent appears in the New session form, in Home's composer and in **Continue in…**, and its sessions open with a composer. It has no Account, Model or Thinking to pick. It runs as whoever it is signed in as, with its own settings, since Cockpit never learns them.

A CLI installed while Cockpit is running is found without a restart. Opening the New session or Continue in… form checks again, at most once a minute. **Settings › Providers** shows which built-ins answered. If your version uses another command, add your own definition for that agent (see below).

Continuing one of these sessions reopens the conversation in its agent. If the agent can't do that, because it can't load a past session over ACP or no longer knows this one, the turn fails and says so. It never starts a fresh conversation without the history you are looking at. **Continue in…** still works either way.

## Answering a permission request

Over ACP an agent can stop mid-turn and ask before it runs something. The question appears
just above the composer with the agent's own options — *Allow once*, *Always allow*,
*Deny* — and the turn stays stopped until you pick one. The answer is recorded in the
transcript, since it is what the rest of the turn was conditioned on.

When what it wants to run is a command, the card shows the command itself — every line,
exactly as it would run — with the agent's own description of it above. A command too long
to show whole says how much is missing, and characters that would hide or reorder part of
it (a right-to-left override, a carriage return, a zero-width space) are shown as their
code, such as `U+202E`, rather than passed through. Only *Allow once* is highlighted:
*Always allow* lets every later call of that kind through without asking.

This is also what finally makes the **Auto-edit** permission mode mean what it says: file
work goes ahead without asking, and anything that *executes* still stops for you. Safe
asks about everything; Yolo asks about nothing. Claude Code sessions get the same card
without ACP — Cockpit answers the CLI's own permission prompts — with *Allow* and *Deny*.

A [roundtable](./roundtables.md) seat has no composer to put the card above, so its
requests are never shown: each one is refused for that call alone — never with a
standing refusal, which would stay in the agent's own settings — and the seat carries on
without it.

::: tip Not the same as "the agent asked you a question"
A session running in your own terminal can also stop to ask something, and Cockpit will
offer you its options — but there it composes your next message, because Cockpit isn't
holding that process. An ACP permission request is answered directly, down the protocol.
:::

## Adding your own agent

**Settings › Providers**, under **ACP agents**, lists what Cockpit will use, and lets you
add more. A definition is a name, the agent it drives, a command, and optional arguments —
for example `claude-code-acp` for Claude Code, or `codex acp` for Codex, depending on what
your versions support. It can drive any agent Cockpit reads, so a definition is also how
you run one whose built-in command your version spells differently.

**Test** runs the real handshake before anything is stored, and reports what answered:
the agent's name and version, the protocol version, whether it can resume sessions, and
how to sign in if it needs you to. An agent you define for a CLI is used in preference to
the built-in one.

::: warning A definition is a command Cockpit will run
So it is checked carefully. The command must be an executable name or a full path — a
relative path like `./agent` is refused, because it would resolve inside whichever
repository the agent happens to be working in. Environment variables that redirect what
actually runs (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, and similar) are refused
too: they would turn a harmless-looking command into a loader for something else. The
rules are re-applied every time the list is read, so a hand-edited config can't slip past
them.
:::

## What Cockpit doesn't do

ACP lets an agent ask the *editor* to read a file or run a command on its behalf. Cockpit
declines both, and agents fall back to their own tools — which is what they do anyway when
run from a terminal.
