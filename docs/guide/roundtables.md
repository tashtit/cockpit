# Roundtables

A **roundtable** is one session with several agents in it. Claude Code, Codex, and Copilot share a single transcript, answer your question, and then answer *each other* — so the disagreement between them becomes visible instead of staying hidden behind whichever model you happened to ask.

Roundtables are discussion-only by design. A table **decides**; a normal session **ships**.

## How a table runs

Open one from the home composer ("Start a roundtable") or the sidebar. You seat two to four agents, optionally attach a project, and write the topic.

- **Your message opens a wave.** Every seat receives it at once and streams simultaneously, each in its own attributed block — the seats think in parallel, not in a queue.
- **"One more round" is the discussion pass.** It runs a sequential round with no new message from you: each seat sees what the earlier seats just said, so they push back, agree, or build on it.
- **Each seat keeps its own provider session.** Later turns are resumed with only the delta since that seat last spoke, so a long table doesn't re-send the whole transcript to every agent.

The table at the top of the view shows each seat's live state: thinking, agrees, not yet.

## Reaching an understanding

Set the goal to **Reach an understanding** and the table drives itself: it keeps running discussion rounds until every seat ends its reply with an agreement line, or the round cap (2–5) is reached.

The conclusion is assembled by Cockpit, not written by an agent — no seat speaks for the table. Each seat's own closing line is laid out side by side, headed **Shared understanding** when everyone agreed, or **No full agreement** when the cap closed a split table. A split is never dressed up as agreement, and the open points stay on the record.

Send another message to reopen a concluded table for a fresh cycle.

## Seats

A seat is an agent plus an account and a model. The same provider can sit twice with different models — "Claude · opus" against "Claude · haiku" — which is how you settle a model-tier question on your own repository instead of on benchmarks.

## Discussion-only, enforced

Roundtables have no permission mode. Every turn runs in the safest mode the provider offers, Codex is sandboxed read-only, and the seats are told the workspace is read-only:

- **With a project attached**, the seats read it from an isolated worktree on a `cockpit/` branch. They can ground their arguments in the actual code; they cannot change it.
- **With no project**, the table runs in a scratch room — a pure discussion.

The provider sessions the seats spawn are the table's internals, not work of yours: they never appear in the board, tree, or search, they can't be handed off, and opening one (behind the table row's chevron) is read-only.

## When a roundtable earns its cost

A roundtable is several full agent turns per round instead of one. It's worth that when the *disagreement* is the product:

- **A decision you're about to commit to** — architecture, a migration strategy, an API shape. Asking one model anchors you to its first answer; a table forces the counter-arguments out before you build.
- **Plan and design review** — "what breaks with this approach?" is exactly where different training shows up as different blind spots.
- **As a disagreement detector.** If three frontier models can't converge in three rounds, the question is genuinely contested, and the call is yours to own.

## When to use a normal session instead

- **Doing the work.** One agent in a worktree beats three agents talking about it. The natural flow is: table concludes → start a session from the winning position.
- **Anything one model answers fine.** Lookups, quick questions, routine edits — a table just costs more.
- **Open-ended brainstorming.** Models converge on agreeable mush fastest where there's no ground truth.

::: warning Read the dissent, not just the verdict
The "not yet" lines are more informative than the "agree" lines. Models are agreeable by disposition, so an easy consensus is weak evidence — while a specific objection one model raised and the others hadn't considered is usually the whole reason to hold the table.
:::

::: tip Different platforms decide, twin seats calibrate
Two seats from the same provider share training lineage, so their agreement is a weaker signal than Claude and Codex agreeing. Use cross-vendor tables for decisions, and twin seats to compare model tiers.
:::
