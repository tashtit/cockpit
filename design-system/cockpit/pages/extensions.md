# Extensions (`Extensions.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** wide card (`.ns-card.wide`, 760px) with four tabs — MCP Servers, Skills,
Plugins, Marketplace — inventorying extensions **across all three agents**, with
cross-agent sharing as the key action.

## Rules

- Tabs: `.ext-tab` underline style with `role="tablist"`/`role="tab"` + `aria-selected`.
  Tab order is fixed; MCP first because sharing lives there.
- Every list is `.ext-list` of `.ext-row`s: leading agent logo(s), `.ext-body`
  (bold name + dimmed mono detail), actions right. All four tabs share this row shape —
  new tabs must too.
- Agent presence on an MCP row = one logo per configured agent (13px, `title` +
  group `aria-label`). Share buttons are ghost-small `+ <Agent>`, rendered only for
  agents that *don't* have the server — absence is the affordance.
- Sharing feedback: `.ext-notice` inline above the lists — ok = accent, error = danger
  border. Notices state the consequence ("restart that CLI to pick it up"). No toasts.
- Loading state: `.tree-empty` "loading…" while the inventory fetch is in flight; every
  tab has a specific empty-state line explaining *why* it might be empty.
- External links (marketplace repos, MCP registry) go through `onOpenUrl` (system
  browser) and are visually marked with a trailing `↗`. GitHub `owner/repo` sources are
  validated by regex before an Open button is offered.
- Hints name real config paths in `<code>` (`~/.claude.json`, `~/.codex/config.toml`,
  `~/.copilot/mcp-config.json`) — this view's job is demystifying where things live.
- Heading focus-on-mount, same as Settings.
