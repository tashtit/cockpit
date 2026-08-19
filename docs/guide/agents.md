# The Agents view

The **Agents** view is one place to manage the AI experience you share across Claude Code, Codex, and Copilot: instructions, MCP servers, skills, and plugins — with Cockpit translating between each agent's own format so you don't have to.

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

Skills, plugins, and marketplaces are inventoried per agent, and skills can be copied between Claude Code and Copilot (both use the same `SKILL.md` format).

::: tip Repo-level skills
For a shared per-repository setup, a `.agents/skills/` directory with a `.claude/skills` symlink lets Codex and Copilot read skills natively while Claude Code follows the symlink — one source of truth, three consumers.
:::
