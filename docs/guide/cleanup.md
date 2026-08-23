# Cleanup

Agent work leaves residue. Every task cuts a worktree, every conversation leaves a transcript, and both outlive the work that produced them — across three CLIs and every repository you touch. **Cleanup** is the one place that shows what has gone quiet and lets you throw it away.

Open it from the trash icon in the sidebar rail, or with ⌘K → "Cleanup".

## What counts as stale

One setting drives the whole view: the **idle threshold**, default **30 days**. Anything untouched for longer than that is listed; everything else is invisible here. The presets run 30 / 60 / 90 days, 6 months, and a year, and the choice is remembered.

The threshold has a hard floor of 7 days — short thresholds would sweep up work you're merely between sittings on.

::: tip Not the same as the history window
Settings → History controls what the **sidebar** shows. Cleanup's threshold controls what this view offers to **delete**. They are independent on purpose.
:::

## Stale sessions

Every session from every agent, oldest first, with its size on disk. Two actions, two very different consequences:

- **Delete** — removes the agent's own log file (for Copilot, the session's state directory) **and the worktree the session ran in**, and the branch when git reports it as fully merged. This cannot be undone. It takes two clicks: the first arms the button, the second commits.
- **Archive** — hides the session in Cockpit. Nothing on disk is touched, nothing is reclaimed, and you can bring it back from the archived toggle in the sidebar. The reversible tier, for getting something out of the sidebar rather than off the disk.

Sessions with an agent currently running in them are listed but never selectable.

### The worktree goes with the session

A session and the checkout it ran in are one piece of work, so the row says what it will take: **takes its worktree · 412 MB**. Deleting the transcript while leaving a 412MB abandoned checkout behind would not be a cleanup.

Two rules keep that safe:

- A worktree hosting **several** sessions only goes when *every* one of them is being deleted. The row marks these `shared ×3`, and the running total beside the button only counts a worktree once it is fully covered.
- The blocks below still apply. A worktree with uncommitted work, a live agent, or your own main checkout is never attached to a session in the first place — deleting the session leaves it alone.

## Worktrees with no session

The leftovers: checkouts nothing in the list above claims. Cockpit asks **git itself** which worktrees each repository has, so this is not limited to the ones Cockpit created:

- **cockpit** — cut by Cockpit for a task, under the app's own data directory.
- **external** — everything else: Claude Code's own `.claude/worktrees`, worktrees you made by hand, another tool's. Found, listed, and cleanable all the same.

Each row shows its repository, branch, age, size on disk, how many indexed sessions ran in it, and any commits no remote has. Every worktree appears exactly once across the view — either on the session that owns it, or here.

**Remove** runs `git worktree remove` — never with `--force`. Afterwards, the branch is deleted only if git reports it as fully merged (`git branch -d`, which refuses anything else). Removing a worktree never loses commits: the branch stays in the repository unless git itself says everything on it is already merged.

### What is never removed

Rows that can't be cleaned stay visible with the reason spelled out, and their checkbox is disabled. There is no override:

| Reason | Why |
|---|---|
| uncommitted changes | the work isn't saved anywhere else |
| an agent is running | a live turn is using the directory |
| the repo's own checkout | Cockpit never touches your main working copy |
| a roundtable's room | it belongs to the table, not to one session |
| locked | you ran `git worktree lock` on it |

A worktree whose directory is already gone shows as **directory gone** — cleaning it just clears the dead registration (`git worktree prune`).

## Finding things

Each list has a filter bar. Free text on the left searches titles, projects and paths; to its right sit **dimension pills** — one per axis, each summarising its own selection:

| | |
|---|---|
| Sessions | Agent, Project, State (has a worktree, archived, blocked) |
| Worktrees | Origin, Project, State (removable, blocked, unpushed, directory gone) |

Click a pill to open it, then click values to include them. Every option also carries a **⊘** on hover that *excludes* it instead — so "every project except docs" is one click. Within a dimension the values are OR-ed; across dimensions they are AND-ed. The pill tells you where it stands: `Any` → `web` → `not docs` → `2 selected, 1 excluded`.

**Add filter** puts another dimension on the bar, and **Remove from bar** takes one off. A dimension that is currently filtering always stays visible whether pinned or not, so the bar can never hide something that is shaping the list. **Clear all** appears once anything is active.

## Selecting in bulk

- The checkbox in each group header selects **everything the current filter shows** — filter to one agent, select all, act. It skips blocked rows, so it can never arm something that would only be refused.
- **Shift-click** a second row to select the whole range between it and the last one you touched. Shift also works from the keyboard.
- Selections survive a filter change. If some of what you have selected is no longer on screen, the header says so (`3 not shown`) rather than acting on it silently.
- The header adds up what the selection actually frees, worktrees included: `12 selected · 840 MB · 3 worktrees`.

## Safety

Nothing in this view acts on a path the renderer supplied. Session ids are re-looked-up in the index and their files re-checked against your configured source directories before anything is unlinked; worktree paths are re-derived from git immediately before removal, and a worktree that picked up uncommitted changes since the scan is refused rather than forced.
