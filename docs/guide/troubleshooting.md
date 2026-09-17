# Troubleshooting

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

Signed and notarized releases open without any of this.

## An update fails at "Restart to install"

The About row in Settings shows `Could not install <version>: …` with a code-signature error. macOS only swaps in a signed bundle, so an unsigned release can be checked and downloaded but not installed in place. Download the new disk image from the [releases page](https://github.com/tashtit/cockpit/releases) and replace the app in Applications; your settings live in `~/Library/Application Support/Cockpit` and survive.

## Notifications never appear

**Settings › Notifications › Send a test notification** says what macOS did. **Refused** (`UNErrorDomain error 1`) means macOS won't let an unsigned build post notifications — true of every release until they're signed, and of `npm run dev`. The sound and a Dock bounce still tell you something needs you. **Showed it** but nothing on screen: check System Settings › Notifications › Cockpit, and whether a Focus mode is on. See [Notifications](/guide/notifications#unsigned-builds).

## Sessions missing from the sidebar

Work through these in order:

1. **History window** — if Settings has a history window set, sessions idle longer than N days are hidden (not deleted). Widen or clear the window.
2. **Archived in the provider's own app** — sessions archived or deleted in Copilot (`data.db`), Codex (`archived_sessions/`), or the Claude desktop app are hidden entirely, by design.
3. **Copilot specifically** — its session format is the least documented, and the parser is best-effort. If your Copilot sessions don't appear, grab one file from `~/.copilot` and [open an issue](https://github.com/tashtit/cockpit/issues) with it (redact anything sensitive); the parser lives in `src/main/parsers/copilot.ts`.

Session log formats are provider-internal and drift between releases — Cockpit's parsers deliberately skip what they can't read rather than fail the whole scan, so a parser gap shows up as missing sessions, never a broken app.

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

## PR features don't work

Cockpit shells out to the [GitHub CLI](https://cli.github.com) for everything PR-shaped. Check that `gh` is installed and authenticated (`gh auth status`) — Settings shows the detected `gh` user.
