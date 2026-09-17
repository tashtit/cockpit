# Notifications

Agents run for minutes, often several at once, and most of them in a terminal rather than in Cockpit. Cockpit tells you when one needs you, so you don't have to watch any window: a **Needs you** group at the top of the home board, a mark on the session's row in the sidebar, a count on the Dock icon, a short sound, and a desktop notification.

## When Cockpit tells you

- **A turn finishes or fails** — in a session Cockpit is running, and in one running in a terminal or the provider's own app: Cockpit reads the ending off the session's log, the same way it shows the session as flying.
- **An agent is waiting on you** — Claude Code stopped to ask a question (or wants its plan approved), Copilot wants permission for a command, Codex asked for an approval or an input. The question or the command is in the row and in the notification. A plain Claude permission prompt leaves no trace in its log, so Cockpit can't see that one; the terminal still shows it.
- **A pull request on one of your branches goes red** — its checks fail, or a reviewer requested changes. Only PRs whose branch one of your sessions is on; a teammate's PR in the same repository waits on the teammate.
- **A roundtable concludes** — consensus reached, the round cap closed a split table, or a round of replies came back. A table speaks once, when its run ends, not once per seat.

It never tells you about the session in front of you while the Cockpit window is focused — you watched it happen. Switch to another app and the same session *does* notify you; come back and it clears. A question that appeared while you were looking is raised the moment you leave the session with it still unanswered.

A turn you stopped yourself is not news, and neither is closing the window.

## What you get

**The notification** names the agent and how long it ran, the session, and how it ended — the first line of the agent's closing words, or the error in one line:

> **Claude finished after 4m**
> Fix the login flake
> Retried the token refresh; the suite is green.

An agent waiting reads "Claude is asking" or "Copilot needs approval" with the question or the command as the body; a PR reads "Checks failing on #57" or "Changes requested on #57" over its title. Click any of them to bring Cockpit forward on that session (a PR with no session of its own opens on GitHub). When several things happen within a second or two of each other, they arrive as **one** notification ("2 finished · 1 failed", or "3 need you") listing them, and clicking it opens the home board where they all are.

**The sound** is a macOS system sound: *Glass* when a turn finishes, *Basso* when one fails or a PR's checks do, *Ping* when an agent is waiting on you. Several at once play one sound, the most urgent.

**The Dock badge** counts everything that needs you and you haven't looked at yet — the rows in the home board's **Needs you** group, plus roundtables that concluded. Opening the session (or the table, or the PR) takes it off the count and takes its notification out of Notification Center. A question also clears itself once you answer it in the terminal, and a red PR once it recovers — and a question nobody answers for twelve hours is assumed abandoned.

## Settings

**Settings › Notifications** has a switch for each of the three and a **Send a test notification** button, which posts a sample and reports what macOS did with it.

In the installed app all three start on. In a development run (`npm run dev`) and in the test suites they start off, and stay off until you flip them.

## Unsigned builds

macOS only lets apps signed with an Apple Developer ID post notifications. Cockpit's releases aren't signed yet, so on most Macs the test reports **refused** — `UNErrorDomain error 1` is macOS's way of saying so. Cockpit falls back: the sound still plays, and the Dock icon bounces once when something lands while you're in another app.

A development run is the same story: macOS attributes its notifications to **Electron**, and refuses them for the same reason.
