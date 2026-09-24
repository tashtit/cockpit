# Worktrees & PRs

Cockpit's model for new work is **always worktrees, always PRs**: agents never edit your checkout, and finished work always ships as a reviewable pull request.

## Starting a task

Hit **New task** (⌘N) or use the composer on the Home view: pick a repository, an agent, an account, and a permission mode, then ⌘Enter.

Cockpit then:

1. creates a `cockpit/<name>` branch — named from the first words of your task (`cockpit/add-changelog-entry-retry-fix`) unless you set one in the full New session form,
2. checks it out in an **isolated git worktree** under the app's own data directory — outside your checkout,
3. runs the agent there.

Your working copy stays untouched no matter what the agent does. Uncommitted work in your checkout can't be clobbered, and parallel tasks on the same repo can't collide with each other.

## Reviewing before you ship

**Changes** in the chat header (⌘D) swaps the transcript for the worktree's diff, so you read what the agent did before it becomes a pull request:

- **Branch** — everything since the base branch (commits plus the working tree): what the PR would carry. The summary says how many commits the branch is ahead of and behind `origin/main`, and flags uncommitted changes, which Create PR refuses.
- **Staged** / **Unstaged** — the two sides of the index. Untracked files the agent created appear under Unstaged and Branch, marked *untracked*.

Files read the way GitHub shows them — unified or side by side, both line numbers, renames and binaries called out. Hover a line and press **+** to pin a note to it; **Send notes to <Agent>** drops them into the composer as one message (path, line, the line itself, your note), so the agent's next turn answers your review. The view reloads by itself once the turn finishes.

## Shipping

When a task is done, **Create PR** pushes the branch and runs `gh pr create`. From then on the session carries a PR state badge — open, draft, merged, or closed, in GitHub's colors — sourced from `gh pr list` and cached for 60 seconds per repository.

While the PR is open, the badge also shows what it is waiting on: a check, an x or a dot for its checks (passing, failing, still running), a speech-bubble glyph with the number of unresolved review threads when a reviewer is waiting on a reply, and a red dot when changes were requested. Hover the badge for the same in words. The thread count comes from one extra GitHub API call per repository, made only when that repository has an open PR; if it fails, the badge still shows everything else.

::: tip Prerequisite
PR features need the [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated. Cockpit shows which `gh` user you're signed in as in Settings.
:::

## Fixing what the PR is waiting on

Once the branch has an open PR, **Changes** (⌘D) leads with it: how many checks fail or are still running, whether a reviewer asked for changes, how many review threads are unresolved, and whether the branch conflicts with its base. Each failing check, change request and thread has a row that opens it on GitHub, and in the **Branch** view the reviewers' threads sit right under the lines they're about.

**Fix with <Agent>** gathers all of it into one prompt in the composer: the merge conflict, each failing check with the output of its failed step (read with `gh run view --log-failed`, for GitHub Actions), the requested changes and every unresolved thread with its file and line. It asks the agent to fix everything, commit and push so the PR updates. Nothing is sent until you press Enter — edit the prompt first if you want to leave something out.

Checks from external CI have no log `gh` can read; the prompt links to them instead. The PR is read when you open the view and again after each turn — it is never polled in the background.

## Permission modes

Every chat runs under one of three permission modes, mapped to each provider's own flags:

| Mode | What it means | Under the hood |
| --- | --- | --- |
| **Safe** | Provider defaults. Some tools may be blocked entirely in headless mode. | no extra flags |
| **Auto-edit** | File edits proceed without asking; everything else still gated. | `--permission-mode acceptEdits` (Claude) / `--full-auto` (Codex) |
| **YOLO** | All approvals bypassed. | provider bypass flags |

::: warning YOLO means it
YOLO disables the agent's approval gates entirely. Use it only on repositories you trust — the worktree isolation protects your checkout, not the wider machine.
:::

## Per-agent options

The New session and Handoff forms also expose per-agent session options, validated in the main process before they ever reach a command line:

- **Model** — picked from every model the agent offers under the chosen account, the same list a [roundtable seat](./roundtables.md#seats) picks from: Claude Code's aliases (`fable`, `opus`, `sonnet`, `haiku`) and current full names, Codex's own cached catalog, Copilot's `auto` plus the models your recent Copilot sessions have run. On a [custom provider](./custom-providers.md) it is that provider's own list; one that lists nothing (an Azure deployment) takes a typed name instead. Leave it on **default** for the CLI's own choice.
- **Thinking** — how hard the agent reasons: the levels the chosen model takes, with its default shown where the agent says (Codex does, per model).
- **Sandbox mode** — Codex.

The choices ride every later turn of the session.
