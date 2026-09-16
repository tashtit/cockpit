# Notifications

Agents run for minutes, often several at once. Cockpit tells you when one needs you, so you don't have to watch the window: a desktop notification, a short sound, and a count on the Dock icon.

## When Cockpit tells you

- **A turn finishes or fails** in any session Cockpit is running — the one you started from the home composer, a conversation you continued, a handoff.
- **A roundtable concludes** — consensus reached, the round cap closed a split table, or a round of replies came back. A table speaks once, when its run ends, not once per seat.

It never tells you about the session in front of you while the Cockpit window is focused — you watched it happen. Switch to another app and the same session *does* notify you; come back and it clears.

A turn you stopped yourself is not news, and neither is closing the window.

## What you get

**The notification** names the agent and how long it ran, the session, and how it ended — the first line of the agent's closing words, or the error in one line:

> **Claude finished after 4m**
> Fix the login flake
> Retried the token refresh; the suite is green.

Click it to bring Cockpit forward on that session. When several sessions end within a second or two of each other, they arrive as **one** notification ("2 finished · 1 failed") listing them, and clicking it opens the home board where they all are.

**The sound** is a macOS system sound: *Glass* when a turn finishes, *Basso* when one fails. Several endings at once play one sound.

**The Dock badge** counts sessions that have landed and you haven't opened yet — the same sessions the home board and the sidebar mark **landed**, plus roundtables that concluded. Opening one takes it off the count and takes its notification out of Notification Center.

## Settings

**Settings › Notifications** has a switch for each of the three and a **Send a test notification** button, which posts a sample and reports what macOS did with it.

In the installed app all three start on. In a development run (`npm run dev`) and in the test suites they start off, and stay off until you flip them.

## Unsigned builds

macOS only lets apps signed with an Apple Developer ID post notifications. Cockpit's releases aren't signed yet, so on most Macs the test reports **refused** — `UNErrorDomain error 1` is macOS's way of saying so. Cockpit falls back: the sound still plays, and the Dock icon bounces once when something lands while you're in another app.

A development run is the same story: macOS attributes its notifications to **Electron**, and refuses them for the same reason.
