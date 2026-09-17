# Notifications

Agents run for minutes, often several at once, and most of them run outside Cockpit — in a terminal, in Claude's or Copilot's own app. Cockpit tells you when one needs you, so you don't have to watch any window: a desktop notification, a short sound, and a count on the Dock icon.

## When Cockpit tells you

- **A turn finishes or fails** in any session Cockpit is running — the one you started from the home composer, a conversation you continued, a handoff.
- **A turn ends in a session running somewhere else** — a terminal, the provider's own app. Cockpit reads the session's log as it grows (that is what shows the session flying on the board), and the record the agent writes as it finishes is what lands it. Only that record does: a CLI that was killed, or a tool call that has gone quiet, never produces a notification — the session just stops showing as flying.
- **An agent stops to ask you something.** Claude Code's questions (`AskUserQuestion`) and plan approvals, Copilot CLI's permission prompts, and Codex's `request_user_input` and approval requests are all read off the log the same way. The session is marked **asks you** — or **needs permission** — with what was asked, until the log moves past it: you answer where the agent runs, or you open the session in Cockpit. A permission prompt for an ordinary Claude tool leaves nothing in the log while it waits, so Cockpit can't tell that one from a long-running tool.
- **A pull request goes red.** An open PR whose head branch a session is working on has failing checks, or a reviewer asked for changes. It is raised once per push: the PR badges refresh every minute, and a refresh never repeats it — a new head commit that goes red does. Checks passing again, or the PR merging or closing, takes it off the list. Cockpit learns this from the same `gh` call that draws the badges; nothing polls GitHub separately.
- **A roundtable concludes** — consensus reached, the round cap closed a split table, or a round of replies came back. A table speaks once, when its run ends, not once per seat.

It never tells you about the session in front of you while the Cockpit window is focused — you watched it happen. Switch to another app and the same session *does* notify you; come back and it clears. A turn you stopped yourself is not news, and neither is closing the window.

Sessions Cockpit runs itself are also visible in their logs, so an ending would be seen twice. It isn't: the process exit lands the session, and the log's own ending record arriving a moment later is recognised as the same ending.

## What you get

**The notification** names the agent and how long it ran, the session, and how it ended — the first line of the agent's closing words, or the error in one line:

> **Claude finished after 4m**
> Fix the login flake
> Retried the token refresh; the suite is green.

A question reads as one, with what was asked:

> **Claude asks you**
> Create the release checklist repo
> Which GitHub owner should the new repository live under?

And a red pull request names the PR and the branch:

> **PR #57 has failing checks**
> Fix login retry flake
> cockpit/login-retry-flake

Click any of them to bring Cockpit forward on that session. When several things land within a second or two of each other, they arrive as **one** notification ("2 finished · 1 waiting on you") listing them, and clicking it opens the home board where they all are.

**The sound** is a macOS system sound: *Glass* when a turn finishes or an agent asks you something, *Basso* when a turn fails or a pull request goes red. Several endings at once play one sound, the graver one.

**The Dock badge** counts sessions that need you and you haven't opened yet — the same sessions the home board and the sidebar mark **landed**, **asks you** or with the red PR mark, plus roundtables that concluded. A session with several reasons counts once and shows its most urgent one: a question, then a red PR, then an ended turn. Opening it takes it off the count, clears every reason, and takes its notification out of Notification Center.

## Settings

**Settings › Notifications** has a switch for each of the three and a **Send a test notification** button, which posts a sample and reports what macOS did with it. The switches cover every kind of news alike — there is no per-kind switch.

In the installed app all three start on. In a development run (`npm run dev`) and in the test suites they start off, and stay off until you flip them.

## Unsigned builds

macOS only lets apps signed with an Apple Developer ID post notifications. Cockpit's releases aren't signed yet, so on most Macs the test reports **refused** — `UNErrorDomain error 1` is macOS's way of saying so. Cockpit falls back: the sound still plays, and the Dock icon bounces once when something lands while you're in another app.

A development run is the same story: macOS attributes its notifications to **Electron**, and refuses them for the same reason.
