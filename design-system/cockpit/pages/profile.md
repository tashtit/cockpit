# Profile — cross-agent work (`ProfileView.tsx`)

> Extends `MASTER.md`. Rules here win for this view.

**Pattern:** a read-only instrument panel. Cursor's public profile is the reference for the
*shape* (heatmap + headline numbers), but the reason this view exists is the thing Cursor
structurally cannot show: **the same work split across three agents**. When deciding what to
add here, prefer whatever sharpens the Claude-vs-Codex-vs-Copilot comparison.

Local-only by design — nothing is published, exported, or fetched. Every number is computed
in `src/main/profile.ts` from logs already on disk.

## Layout

Reuses the standard secondary-view shell (`.chat.settings-view` > `.ns-card.wide`), same as
Settings and AI Setup: `.ns-head` (h2 + Close), then sections led by `.ns-label`.

Order is fixed — identity line → `.pv-stats` → Activity → Agents → Languages → Top repos.
Each section is dropped entirely when it has no data; only the identity line and `.pv-stats`
are unconditional.

## The heatmap (`.pv-heat`)

- GitHub's grid geometry: 7 rows (Mon–Sun, `Mon`/`Wed`/`Fri` labelled), one column per week,
  oldest column left, capped at 53 weeks. Leading blanks (`.pv-sq-pad`) pad the first week so
  weekdays line up down every column.
- **Squares carry the agent's identity color, not the accent** — hue = the agent that ran
  most that day, so the grid doubles as an at-a-glance agent mix. Intensity is 4 steps scaled
  against the busiest day, so the pattern reads the same whether you run 5 or 50 a day.
- Squares are the one place agent tints exceed MASTER's 0.10–0.16 range (they run to 0.92).
  That range exists to keep text legible on a tint; these are 11px graphics with no text on
  them. The legend swatches use `--accent-rgb` — the legend explains *intensity*, not agent.
- Empty days are `--surface` + `--border`, never absent: `profile.ts` returns a dense day
  range so the grid can never grow a hole.
- 53 weeks never fits the 760px card, so `.pv-heat-scroll` scrolls **inside its own box**.
  The page itself must never scroll sideways (MASTER).
- Accessibility: the grid is one `role="img"` with a summarizing label; every square carries a
  `title` naming the date, count, and per-agent split. Don't make squares focusable — 371 tab
  stops would wreck keyboard navigation for no gain.

## Agent rows (`.pv-agent`)

- `.tint-{agent}` for identity (the shared bordered-row recipe), agent logo, name, session
  count as a `.repo-count` pill, then a meta line: line diff, files, top-3 tools, model chips.
- Model chips reuse `.acct-chip.acct-{agent}` — same "machine identifier" mono pill as
  account identities elsewhere.
- **Two distinct empty states, never conflated:**
  - `deepUnavailable` → `.source-warn`. The logs could not be read; a real failure.
  - zero lines with no failure → `.pv-untracked` "no measurable edits". Not a failure: Codex
    edits through shell commands rather than a structured edit tool, so nothing countable
    reaches the log. Never render a bare `+0 −0 0 files` — it reads as a bug.

## Honesty rules (load-bearing — don't soften these)

Line counts come from each agent's own edit-tool inputs. They measure **edits performed**, not
diff that survived to a commit: rewriting a file twice counts twice, and nothing is reconciled
against git. The standing hint under **Agents** says exactly this and must stay. Label these
numbers "lines edited" — never "lines shipped", "lines of code", or anything implying merged
work.

The profile deliberately covers **all** history, ignoring the `historyDays` display window
that trims the sidebar tree. A profile's job is the long view; that setting exists to keep the
tree short. Archived sessions (user's or the provider's own) stay excluded — those were
thrown away on purpose.
