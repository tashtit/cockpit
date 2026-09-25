# Troubleshooting

If nothing here fixes it, report it from the app: **Settings › About › Report a problem** (or **Sessions missing or wrong**) opens a GitHub issue with your Cockpit, macOS and agent CLI versions already filled in, and nothing else. See [Feedback](/guide/getting-started#feedback).

## "Electron failed to install correctly"

This message means the first-run Electron binary download failed. Run the downloader directly to see the underlying error:

```bash
npx install-electron
```

Common causes:

- **Proxy or firewall** blocking the fetch from GitHub releases — set `ELECTRON_MIRROR` to a mirror you can reach, then re-run `npx install-electron`.
- **Corrupt cached download** — `rm -rf ~/Library/Caches/electron` and retry.

## "Cockpit" is damaged and can't be opened

macOS says this — or "from an unidentified developer", or on macOS 15 and later "Apple could not verify Cockpit.app is free of malware" with a **Move to Trash** button — about an unsigned build: every release until the pipeline has an Apple Developer ID certificate. The download is fine; the quarantine flag the browser put on it is what Gatekeeper objects to. Click **Done**, then either open System Settings › Privacy & Security, find the notice that Cockpit was blocked and choose **Open Anyway**, or clear the flag once:

```bash
xattr -d com.apple.quarantine /Applications/Cockpit.app
```

Signed and notarized releases open without any of this, and so does a copy installed with the [one-line installer](/guide/getting-started#install-the-app), which downloads with `curl` and so never gets the flag.

## Homebrew won't install Cockpit

Two messages, both about a Cockpit Homebrew didn't expect to find — or expected and didn't:

- **"It seems there is already an App at '/Applications/Cockpit.app'"** — Cockpit is already installed, from the installer or the disk image, and Homebrew won't overwrite an app it didn't put there. Let it take over the one you have; because Cockpit updates itself, Homebrew adopts it at whatever version it is:

  ```bash
  brew install --cask --adopt tashtit/tap/cockpit
  ```

- **"Not upgrading cockpit, the latest version is already installed"**, and no Cockpit in Applications — the app was deleted by hand (dragged to the Trash, say), but Homebrew still has it on its books, so `brew install` does nothing. Reinstall puts it back:

  ```bash
  brew reinstall --cask tashtit/tap/cockpit
  ```

Either way your settings in `~/Library/Application Support/Cockpit` stay where they are. The cask can trail the newest release by a few hours, so Homebrew may install a version you have already seen; Cockpit fetches the newer one itself once it opens.

## An update did not install

Cockpit installs updates itself: it downloads the release zip, checks it against the checksum the release publishes, confirms the bundle inside is the same app at the version that was offered, clears the quarantine flag and swaps it in once Cockpit quits. Every step before the swap is reversible, and the swap puts the old bundle back if the copy fails — a failed update always leaves you with a working app.

The sidebar's update bar then reads **Update failed**, and clicking it opens **Settings › About**, which says why, verbatim, and nothing downloads on its own until you press **Check for updates** (which is also how you retry: the build stays downloaded, so it costs no second fetch).

Two causes are worth knowing:

- **"Could not move /Applications/Cockpit.app aside"** — the folder holding the app is not writable by you. Move Cockpit somewhere you own, or install it with an admin account.
- **"the download does not match the checksum the release publishes"** — the fetch was corrupted or intercepted. Retrying is safe; nothing from a mismatched download is ever unpacked.
- **"the download stalled (nothing arrived for 60s)"** — the connection stopped delivering without ever failing, usually because the Mac went to sleep mid-download or a proxy dropped it. The partial download is thrown away. Press **Check for updates** to start again, or leave it to the next automatic check.

Whatever the cause, replacing the app by hand always works: download the disk image from the [releases page](https://github.com/tashtit/cockpit/releases) and drag it into Applications. Your settings live in `~/Library/Application Support/Cockpit` and survive.

## Notifications never appear

**Settings › Notifications › Send a test notification** says what macOS did. **Refused** (`UNErrorDomain error 1`) means macOS won't let an unsigned build post notifications — true of every release until they're signed, and of `npm run dev`. The sound and a Dock bounce still tell you something landed. **Showed it** but nothing on screen: check System Settings › Notifications › Cockpit, and whether a Focus mode is on. See [Notifications](/guide/notifications#unsigned-builds).

## Sessions missing from the sidebar

Work through these in order:

1. **History window** — if **Settings › View** has a history window set, sessions idle longer than N days are hidden (not deleted). Widen or clear the window.
2. **Archived in the provider's own app** — sessions archived or deleted in Copilot (`data.db`), Codex (`archived_sessions/`), or the Claude desktop app are hidden entirely, by design.
3. **Copilot specifically** — its session format is the least documented, and the parser is best-effort. If your Copilot sessions don't appear, report it with **Settings › About › Sessions missing or wrong** and attach one file from `~/.copilot` if you can (redact anything sensitive); the parser lives in `src/main/parsers/copilot.ts`.

Session log formats are provider-internal and drift between releases — Cockpit's parsers deliberately skip what they can't read rather than fail the whole scan, so a parser gap shows up as missing sessions, never a broken app. Still missing, or listed with the wrong title, project, branch or time? **Sessions missing or wrong** is for that too, whichever agent the session came from.

## The agent says it can't use tools

That's the **Safe** permission mode: in headless mode, provider defaults may block tool use entirely. Re-run the task with **Auto-edit** (or, on a trusted repo, YOLO). See [permission modes](/guide/worktrees-and-prs#permission-modes).

## Wrong Node version

Cockpit needs **Node 24** (pinned in `.nvmrc`). Symptoms of an older Node range from install failures to test workers dying at startup. Fix:

```bash
nvm use
npm ci
```

## `npm ci` says the lockfile is out of sync

```
npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.
npm error Missing: react@18.3.1 from lock file
```

The lockfile was written by npm 11 — the one Node 24 bundles, pinned as `packageManager`, and the one Dependabot always uses — and is being installed by npm 10, which still expects the optional peer entries npm 11 no longer records (the react 18 ones nested under `@docsearch/js`, a VitePress transitive). Switch to the pinned toolchain:

```bash
nvm use
npm ci
```

Don't rewrite the lock with npm 10 to make it fit: that re-adds the entries, and the next Dependabot PR removes them again (its updater ignores the `packageManager` pin in practice — it installs the pinned npm with `corepack --cache-only`, which falls back to npm 11). CI's "npm matches the packageManager pin" step keeps `.nvmrc` and the pin on the same major.

## Placing the dev window

`electron-vite dev` relaunches the app on every main-process change, so a relaunch that fronts and focuses the window pulls you out of whatever you were typing. Dev builds therefore open the window **without taking focus** — it appears, your editor keeps the keyboard. Two env vars (dev-only, never in a packaged app) tune that:

| | |
| --- | --- |
| `npm run dev:fg` | opt back in to a fronted, focused window (`COCKPIT_DEV_BACKGROUND=0`) |
| `COCKPIT_DEV_DISPLAY=1 npm run dev` | open centered on a specific display (0-based OS index) |

Display order is OS-assigned and won't necessarily match your mental "first/second screen" — when `COCKPIT_DEV_DISPLAY` is set, the dev console prints the display table so you can pick the right index.

The e2e tier and `npm run ui:tour` follow `COCKPIT_DEV_DISPLAY` too, and never take focus. Two full-screen e2e cases would (macOS fronts a window entering full screen), so they are skipped unless `COCKPIT_E2E_TAKE_FOCUS=1` is set.

## PR features don't work

Cockpit shells out to the [GitHub CLI](https://cli.github.com) for everything PR-shaped. Check that `gh` is installed and authenticated (`gh auth status`) — Settings shows the detected `gh` user.
