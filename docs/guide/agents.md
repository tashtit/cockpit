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
marketplaces — with the count on each tab. When anything has drifted it opens on **Needs
you**: every disagreement across every section, in one short list. **Search looks
everywhere**, whichever section you're in, and tags each result with where it lives.

Cockpit keeps a config of its own, and every agent gets a switch:

**The switch is what you asked for. The lamp under it is what the agent actually has.**

Switching an agent on writes the entry into that agent's own config. Switching it off
takes it back out — and Cockpit keeps the entry, so you can put it back later. That is the
difference between *off* and *removed*: off is a setting, removing is forgetting.

Most of the time the switch and the lamp agree and the lamp stays dark. When they don't,
it lights amber and says which way:

| Lamp | What happened |
| --- | --- |
| `not applied` | The switch is on, but the agent doesn't have it |
| `differs` | The agent has it, but not the definition Cockpit holds |
| `added outside` | The switch is off, yet the agent has it anyway |

Open the row and you get Cockpit's definition beside each agent's, field by field, with
the differing lines marked — and the only two honest answers: **write Cockpit's version**
into the agent, or **take this agent's version** into Cockpit. Env var *values* are never
shown or compared, only their names, so a row never claims a difference you can't see.

### Removing

- **Switch it off** for one agent — reversible, and Cockpit remembers the entry.
- **Remove everywhere**, in the row's detail, takes it out of every agent and stops
  tracking it. Both that and switching a plugin or marketplace off ask for a second click
  first, because they run a real uninstall.

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

The shared text lives between `<!-- cockpit:shared -->` markers inside each file. **Everything outside the markers is that agent's own and is never touched** — you can keep agent-specific instructions alongside the shared baseline in the same file.

Each target shows a drift state:

- **In sync** — the file carries the current baseline.
- **Out of date** — the baseline changed since this file was last applied; one click re-applies.
- **Not applied** — the file has no shared block yet.

You can also edit any of the full files inline, right in the view.

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
