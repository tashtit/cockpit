# The Agents view

The **Agents** view is one place to manage the AI experience you share across Claude Code, Codex, and Copilot: instructions, MCP servers, skills, plugins, and marketplaces — with Cockpit translating between each agent's own format so you don't have to.

## Global or project

The first thing on the view is a scope switch, because the same setting means something
different depending on where it lives:

- **Global** — every session, in every repo. Written into each agent's own config in your
  home folder.
- **Project** — one repository only. Global settings still apply on top.

Reach a project's setup from the sliders button on its row in the sidebar, from ⌘K, or by
picking the repo in the switch. A repo can carry its own instructions, its own Claude Code
MCP servers, and its own skills. Plugins and marketplaces are installed per machine, so a
repo can't change them — the project view says so rather than showing you controls that
wouldn't work.

## The panel

The panel shows **one section at a time** — instructions, MCP servers, skills, plugins,
marketplaces — with the count on each. When anything has drifted it opens on **Needs
you**: every disagreement across every section, in one short list. **Search looks
everywhere**, whichever section you're in, and tags each result with where it lives.

Every row is one thing, and everything about that thing is in its row: open it to see what
each agent runs, check whether a server actually answers, or take it out. Each agent is a
chip you click to turn it on or off for that agent — the chip carries the agent's own
colour, so a glance down the list tells you who runs what.

Every agent gets a switch, and the switch says **where a thing is applied**. On writes it
into that agent's own config; off takes it back out.

Cockpit keeps a copy of each thing — but it's a **backup, not a version**. It's refreshed
from whatever your agents actually run, and it exists for one reason: so switching an
agent back on, or putting something back after you removed it, has something to write.
Cockpit never sets itself up as the correct answer your agents are judged against.

A row raises a flag when something disagrees:

| Flag | What happened |
| --- | --- |
| `not applied` | The switch is on, but the agent doesn't have it |
| `differs` | This agent runs something different from the other agents |
| `added outside` | The switch is off, yet the agent has it anyway |

Open the row and you get **what each agent actually runs**, side by side, with the
differing lines marked. When they disagree there's no "right" side for Cockpit to pick, so
it asks: *Claude and Copilot don't run the same github. Which one is right?* — and copies
the one you choose to the others. The third answer is **Keep as they are**: the agents are
meant to differ. Cockpit then remembers what each differing agent runs as intended, the row
goes quiet, and it only comes back to **Needs you** if one of those agents changes its copy
again; the row's detail says who runs their own on purpose, with *Treat as drift again* to
undo. Env var *values* are never shown or compared, only their names, so a row never
claims a difference you can't see.

The shared instructions are the exception: you write that baseline in Cockpit, so a file
that's out of step with it is simply out of date, whatever the other agents are doing.

### Removing, and getting it back

- **Switch it off** for one agent — it leaves that agent, nothing else changes.
- **Remove everywhere**, in the row's detail, takes it out of every agent at once. It then
  appears under **Removed**, with *Put it back* — which restores it to the same agents it
  was on. This is what the kept copy is for: removing everywhere would otherwise be the
  one action in the panel you couldn't undo.
- Removing everywhere, and switching a plugin or marketplace off, each ask for a second
  click first, because they run a real uninstall.

### How each kind is applied

| Kind | Switching it on |
| --- | --- |
| Instructions | Writes the shared baseline into that agent's own file |
| MCP servers | Writes the definition into the agent's config, translated to its format |
| Skills | Copies Cockpit's copy of the skill folder into the agent |
| Plugins, marketplaces | Runs the agent's own CLI (`plugin install`, `plugin marketplace add`) — only it can clone and register them properly |

::: tip Nothing to set up
The first time you open a scope, everything your agents already have is picked up
automatically and switched on. Cockpit starts by agreeing with reality.
:::

## Shared instructions

Write one baseline of instructions — global, or per-repository — and fan it out to each agent's own file:

| Scope | Claude Code | Codex | Copilot CLI |
| --- | --- | --- | --- |
| Global | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `~/.copilot/copilot-instructions.md` |
| Per-repo | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` (read natively) |

The shared text lives between `<!-- agent-parity:shared -->` markers inside each file — the same managed block the [agent-parity](https://github.com/tashtit/marketplace) plugin compares and writes, so running both never leaves a file with two copies of it. **Everything outside the markers is that agent's own and is never touched** — you can keep agent-specific instructions alongside the shared baseline in the same file.

Files written by an earlier Cockpit carry `<!-- cockpit:shared -->` markers. Those are read as the same block, and renamed to the current pair the next time the file is applied. A marker counts only on a line of its own, outside fenced code, so a document that quotes the markers in a code block is not managed by them.

A repository `CLAUDE.md` that is a symlink to `AGENTS.md`, or that imports it with `@AGENTS.md` and holds no block of its own, is never written: Claude Code already reads the block through `AGENTS.md`, and a second copy would have it load the text twice. That `AGENTS.md` row carries Claude's logo too, and says which file reads it.

Each target shows a drift state:

- **In sync** — the file carries the current baseline.
- **Out of date** — the baseline changed since this file was last applied, or the file carries the block twice (one copy per marker spelling); one click re-applies, folding any second copy into the one block.
- **Not applied** — the file has no shared block yet.

### Review before you apply

The editor's **Changes** tab shows what applying would write, file by file, before you
write it: the shared block as a line diff — what comes out, what goes in — between the two
markers, with the lines outside them counted and left exactly where they are. It compares
against the text in the editor, so an unsaved draft is reviewed as the draft. Read it as one
column or side by side with the **Unified / Split** switch; Cockpit remembers which. Every
out-of-date row has a *see changes* link that jumps straight to its block, and the same
diff opens from the row in **Needs you**, with the re-apply button beside it.

You can also edit any of the full files inline, right in the view.

### Sharing a repo's instructions

A repository's instructions belong to everyone working in it, so Cockpit shares them
through the repository itself. **Save & open PR** writes the baseline into that repo's
`CLAUDE.md` and `AGENTS.md` and opens a pull request with the change — in a fresh worktree
off the default branch, never in your own checkout, and using your own git identity and
hooks. Merge it and your teammates get the instructions the next time they pull.

If an instructions pull request is already open, the next share adds a commit to it rather
than opening a second one. If the repo already says exactly what your baseline says, nothing
is opened at all.

Coming the other way: when a teammate's change lands and you pull it, the repo's file now
carries a block that differs from your baseline, so the row reads **out of date**. Apply
yours over it, or take theirs with **use this file's version**. And a repo you have just
cloned, whose files already carry a shared block, is adopted on first view — the block is
the baseline, with nothing to apply.

::: tip Global instructions stay yours
Only per-repository instructions are shareable. A global baseline has no repository to go
to, and nobody to share it with.
:::

## MCP servers

A server's switch translates one definition into each agent's own config format:

- Claude Code — `~/.claude.json`
- Codex — `~/.codex/config.toml`
- Copilot CLI — `~/.copilot/mcp-config.json`

Define a server once, run it everywhere. The **MCP health** tab covers the one thing a
switch can't tell you: whether the server actually answers. Check probes it, and when it
reports *needs login* you can run the agent's own OAuth flow from there.

## Skills, plugins, marketplaces

All three agents read personal skills from the same `SKILL.md` format — `~/.claude/skills`, `~/.codex/skills` and `~/.copilot/skills` — so a skill copies to any other agent as-is.

Plugins and marketplaces are read from wherever each agent keeps them (`installed_plugins.json` and `known_marketplaces.json` for Claude Code, `[plugins]` / `[marketplaces]` sections in `~/.codex/config.toml` for Codex, the `~/.copilot/installed-plugins/<marketplace>/<plugin>` tree for Copilot) and keyed by the `<name>@<marketplace>` id all three use — so the same plugin lines up across agents in Compare.

::: tip Repo-level skills
For a shared per-repository setup, a `.agents/skills/` directory with a `.claude/skills` symlink lets Codex and Copilot read skills natively while Claude Code follows the symlink — one source of truth, three consumers.
:::
