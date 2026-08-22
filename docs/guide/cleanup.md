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

- **Archive** — hides the session in Cockpit. Nothing on disk is touched, and you can bring it back from the archived toggle in the sidebar. This is the reversible tier.
- **Delete files** — removes the agent's own log file (or, for Copilot, the session's state directory). This cannot be undone. It takes two clicks: the first arms the button, the second commits.

Sessions with an agent currently running in them are listed but never selectable.

## Stale worktrees

Cockpit asks **git itself** which worktrees each repository has, so this list is not limited to the ones Cockpit created:

- **cockpit** — cut by Cockpit for a task, under the app's own data directory.
- **external** — everything else: Claude Code's own `.claude/worktrees`, worktrees you made by hand, another tool's. Found, listed, and cleanable all the same.

Each row shows its repository, branch, age, size on disk, how many indexed sessions ran in it, and any commits no remote has.

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

## Safety

Nothing in this view acts on a path the renderer supplied. Session ids are re-looked-up in the index and their files re-checked against your configured source directories before anything is unlinked; worktree paths are re-derived from git immediately before removal, and a worktree that picked up uncommitted changes since the scan is refused rather than forced.
