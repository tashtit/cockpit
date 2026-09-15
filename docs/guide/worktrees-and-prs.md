# Worktrees & PRs

Cockpit's model for new work is **always worktrees, always PRs**: agents never edit your checkout, and finished work always ships as a reviewable pull request.

## Starting a task

Hit **New task** (⌘N) or use the composer on the Home view: pick a repository, an agent, an account, and a permission mode, then ⌘Enter.

Cockpit then:

1. creates a `cockpit/<name>` branch,
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

::: tip Prerequisite
PR features need the [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated. Cockpit shows which `gh` user you're signed in as in Settings.
:::

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

The task composer also exposes per-agent session options, validated in the main process before they ever reach a command line:

- **Model override** — all agents.
- **Sandbox mode** — Codex.
