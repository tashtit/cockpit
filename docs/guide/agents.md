# The Agents view

The **Agents** view is one place to manage the AI experience you share across Claude Code, Codex, and Copilot: instructions, MCP servers, skills, plugins, and marketplaces — with Cockpit translating between each agent's own format so you don't have to.

## Compare

The **Compare** tab is the front door: every shared thing as a row, every agent as a column.

| | Claude Code | Codex | Copilot CLI |
| --- | --- | --- | --- |
| `linear` | ✓ | + | + |
| `github` | ✓ | ✓ | ≠ |

- **✓** — the agent has it, and its definition matches the others.
- **≠** — the agent has it, but configured differently.
- **+** — the agent is missing it. Click to copy it over.
- **·** — the agent can't hold this kind of thing.

Open a row to see the field-by-field diff — which command, which arguments, which version — with the agent the others are compared against marked as the reference. Env var *values* are never compared or shown; only their names, so a row never claims a difference you can't see.

**Filling gaps is one click; overwriting isn't.** A cell's `+`, a row's "Sync all" and a group's "Fill N gaps" only ever *add* what's missing — nothing already configured is touched. Replacing an agent's own definition lives inside the expanded diff and takes a second, confirming click.

::: tip Only differences
The filter is on by default, so the tab opens on the work rather than the full inventory. Untick it to see everything your agents already agree on.
:::

How each kind syncs:

| Kind | How Cockpit syncs it |
| --- | --- |
| Instructions | Applies the shared baseline to each agent's own file |
| MCP servers | Writes the definition into the agent's config, translated to its format |
| Skills | Copies the skill directory into the agent's `skills/` |
| Plugins, marketplaces | Runs the target agent's own CLI (`plugin install`, `plugin marketplace add`) — only it can clone and register them properly |

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

## MCP sharing

The Agents view inventories every MCP server each agent knows about — including Claude's per-project servers (under `projects.*` in `~/.claude.json`), labeled with their project.

One-click **sharing translates a server definition into each agent's own config format**:

- Claude Code — `~/.claude.json`
- Codex — `~/.codex/config.toml`
- Copilot CLI — `~/.copilot/mcp-config.json`

Define a server once, run it everywhere.

## Skills, plugins, marketplaces

All three agents read personal skills from the same `SKILL.md` format — `~/.claude/skills`, `~/.codex/skills` and `~/.copilot/skills` — so a skill copies to any other agent as-is.

Plugins and marketplaces are read from wherever each agent keeps them (`installed_plugins.json` and `known_marketplaces.json` for Claude Code, `[plugins]` / `[marketplaces]` sections in `~/.codex/config.toml` for Codex, the `~/.copilot/installed-plugins/<marketplace>/<plugin>` tree for Copilot) and keyed by the `<name>@<marketplace>` id all three use — so the same plugin lines up across agents in Compare.

::: tip Repo-level skills
For a shared per-repository setup, a `.agents/skills/` directory with a `.claude/skills` symlink lets Codex and Copilot read skills natively while Claude Code follows the symlink — one source of truth, three consumers.
:::
