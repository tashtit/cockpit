# Profile

The **Profile** is your work across every agent Cockpit indexes, side by side: when you work, which agent did it, and what it touched. Open it from the chart icon in the sidebar rail, or with ⌘K → "Profile".

Everything on it is computed on your machine from the session logs already on disk. Nothing is published, exported or fetched.

## The headline

Five numbers stay at the top of every tab: **sessions**, **active days**, your current **day streak** (it stays alive until a whole day goes by without a session), the **longest streak**, and **lines edited**, shown as lines added and removed.

Under them, one bar splits your sessions by agent — Claude, Codex and Copilot, largest share first. It is also the color key for the rest of the page: every square, bar and segment below uses the same three colors.

## Activity

- **By day** — a year of days, one square each, in GitHub's week-column layout. A square's color is the agent that ran the most sessions that day, and its brightness is how busy the day was compared with your busiest day. Hover a square for the date and the split by agent.
- **By hour** — sessions started in each hour of the day, local time, each bar split by agent. The line under it names your busiest hour.

## Agents

- **By agent** — a table with one column per agent and one row per measure, so reading across a row compares them:
  - **Prompts per session** — the messages you sent, counted the same way for every agent. Tool results, context the CLI adds to a turn and its own notes don't count; slash commands do.
  - **Tool calls per prompt** — how much an agent does for each thing you ask.
  - **Lines edited** and **Files edited** — counted from each agent's own edit tools. They measure edits made, not the diff that ended up in a commit: rewriting a file twice counts twice. An agent that edits through shell commands leaves nothing countable, and shows **none measured** rather than a zero.
  - **Top tools** — its three most-used tools; hover for the rest.
- **Models** — assistant messages per model, each bar split by the agent that served it. The same model can come from more than one agent (Copilot serves Claude models, for example), so this and the table answer different questions.
- **Accounts** — each [config home](/guide/accounts-and-usage) that has sessions, with the account it is signed in as, when you last used it, and its session count.

## Code

- **Languages** — lines added per file extension, split by agent.
- **Top repos** — the repositories with the most sessions, split by agent. Sessions outside any repository are grouped as **Chats**.

The Code tab is hidden until something has been edited or a session has run in a repository.

## What it covers

The profile covers your **whole history**. Settings › View › History only shortens the sidebar; it doesn't trim the profile. Sessions you archived, and ones archived or deleted in the agent's own app, are left out.

If Cockpit can't read an agent's logs, the table says **logs unreadable** in that agent's column. Its session counts come from the index, so they stay correct either way.
