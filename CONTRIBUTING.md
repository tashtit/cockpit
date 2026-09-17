# Contributing to Cockpit

## Prerequisites

- **macOS** — the primary target (the app indexes `~/.claude`, `~/.codex`, `~/.copilot` and is dark-mode-only). Linux works for development and CI.
- **Node 24** — pinned in [`.nvmrc`](.nvmrc); run `nvm use` (or your version manager's equivalent) before installing.
- **npm 11** — the one Node 24 bundles, pinned as `packageManager` in `package.json`. It is also the npm Dependabot regenerates the lockfile with, so CI, the bot and your machine all write the same lockfile shape (npm 10 reads that shape as out of sync). The repo ships a `package-lock.json`; install with `npm ci` to match CI exactly.
- **git**, and the **GitHub CLI (`gh`)** if you want the PR features to work at runtime (not needed to build or test).
- Optional: the `claude` / `codex` / `copilot` CLIs. Without them the app runs with an empty session index; tests don't need them — they run against fixtures written to a tmpdir.

## Setup

```bash
nvm use
npm ci
npm run dev
```

`npm ci` installs only Electron's JS stub — the actual Electron binary (~200 MB) downloads automatically the **first time you run `npm run dev`** ("Downloading Electron binary...") and is cached in `~/Library/Caches/electron`, so it only happens once per Electron version.

### "Electron failed to install correctly"

This message means that first-run binary download failed. Run the downloader directly to see the underlying error:

```bash
npx install-electron
```

Common causes:

- **Proxy or firewall** blocking the fetch from GitHub releases — set `ELECTRON_MIRROR` to a mirror you can reach, then re-run `npx install-electron`.
- **Corrupt cached download** — `rm -rf ~/Library/Caches/electron` and retry.

## Development workflow

| Command | What |
| --- | --- |
| `npm run dev` | Electron app with HMR |
| `npm run typecheck` | `tsc --noEmit` — the static gate (there is no linter) |
| `npm test` | vitest: unit + component tiers |
| `npm run test:e2e` | Playwright against the built app — run `npm run build` first |
| `npm run package` | macOS disk images and zips into `dist/` — unsigned unless Apple credentials are in the env |
| `npm run test:packaged` | Playwright smoke test against the `.app` that `npm run package` produced |

`npm run typecheck` and `npm test` must both pass before a PR; CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck plus all three test tiers.

### Keeping the dev window out of your way

`electron-vite dev` relaunches the app on every main-process change, so a relaunch that fronts and focuses the window pulls you out of whatever you were typing in. Dev builds therefore open the window **without taking focus** — it appears, your editor keeps the keyboard. Two env vars (honored only in dev, never in a packaged app) tune this:

| | |
| --- | --- |
| `npm run dev:fg` | opt back in to a fronted, focused window (`COCKPIT_DEV_BACKGROUND=0`) |
| `COCKPIT_DEV_DISPLAY=1 npm run dev` | open centered on a specific display (0-based index into the OS display list) |

They compose: `COCKPIT_DEV_DISPLAY=1 npm run dev` parks the app on your second screen and leaves your editor focused.

Display order is OS-assigned and won't necessarily match your mental "first/second screen" — when `COCKPIT_DEV_DISPLAY` is set, the dev console prints the table so you can pick:

```
[dev] display 0: 1920x1080 at (0,0) primary
[dev] display 1: 1728x1117 at (-1728,96) ← COCKPIT_DEV_DISPLAY
[dev] display 2: 1920x1080 at (1920,0)
[dev] window shown at {"x":-1414,"y":291,"width":1100,"height":760}
```

### Why macOS calls the dev app "Cockpit"

A dev run has no bundle of its own: `npm run dev` launches the stock `Electron.app` out of `node_modules`, and macOS names a running app after that bundle's `Info.plist`, never after the window title — the app menu, the Dock and Mission Control's full-screen spaces would all say "Electron". No runtime API changes that, so `predev` runs [`scripts/brand-dev-electron.mjs`](scripts/brand-dev-electron.mjs), which rewrites `CFBundleName` / `CFBundleDisplayName` in that bundle to `Cockpit` before every dev launch (the bundle is ad-hoc, linker-signed with the plist unbound, so its signature stays valid). It is idempotent, re-brands after an Electron upgrade or `npm ci` re-downloads the binary, and never blocks the launch — on failure it warns and the app keeps its stock name.

## Conventions

- **Conventional Commits** (`feat(indexer): …`, `fix(parser): …`, `docs: …`), matching existing history.
- **UI work**: read `design-system/cockpit/MASTER.md` first. Components use the design tokens from the `:root` block of `src/renderer/src/style.css` — never raw hex. Dark mode only.
- Session log parsers must stay failure-tolerant and bounded (≤256 KB per file read) — provider formats drift between releases; skip what you can't read rather than fail the scan.

## Runtime dependencies

Cockpit ships three runtime packages; everything else in `package.json` is dev tooling. Each one is here because the platform does not cover it, and this table is what a reviewer checks when one of them is bumped or replaced.

| Package | Purpose | License | Why not the platform |
| --- | --- | --- | --- |
| `react-markdown` | Renders Markdown content in `src/renderer/src/Markdown.tsx` as a React element tree, without `dangerouslySetInnerHTML` | MIT | A safe CommonMark renderer is a parser, not a few lines of app code |
| `remark-gfm` | Tables, task lists and strikethrough in that Markdown | MIT | GitHub-flavored extensions on the same parser |
| `rehype-highlight` | Syntax highlighting for fenced code blocks | MIT | Language grammars are a maintained corpus, not app code |
| `electron-updater` | Checks GitHub Releases for a newer build (`src/main/updates.ts`) | MIT | Electron's own `autoUpdater` needs a server speaking the Squirrel.Mac protocol; this reads a static manifest off the release instead — no update server to run. Only the check: downloading and installing are Cockpit's own (`src/main/update-install.ts`), because the Squirrel.Mac installer behind it refuses an ad-hoc signed build |

Adding a runtime dependency means adding a row here in the same pull request, with the license read from the package's own `package.json`.

## Packaging

`npm run package` builds `out/` and then runs electron-builder (`electron-builder.config.js`) for macOS: a `.dmg` and a `.zip` for each of arm64 and x64 land in `dist/`, plus `latest-mac.yml`, the manifest the in-app updater reads. Locally the result is unsigned — macOS asks you to clear the quarantine flag (README, "Install") — and versioned `0.0.0`: the real version is stamped at release time and never committed, which is why `package.json` says `0.0.0`.

`npm run test:packaged` launches the bundle for your architecture under Playwright and checks that it boots as an installed app with the updater wired to GitHub Releases. Unlike the other e2e specs it uses your real userData directory and provider homes, because a packaged build refuses the `COCKPIT_USER_DATA` override by design.

The bundle ships with Electron fuses flipped (`electronFuses` in the config): no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, asar integrity validation, app code only from the asar. Node's `--inspect` flags stay enabled because Playwright attaches to the packaged bundle through them in the smoke test.

The app icon is committed, not built: `resources/icon-original.webp` is the artwork, and `npm run icon` (`scripts/build-app-icon.swift`, macOS only) renders it into the macOS icon template as `resources/icon.png` — the dev Dock icon — and packs `build/icon.icns` with `iconutil`. electron-builder could render the `.icns` from a PNG itself, but its converter writes the 16/32/64px entries in chunk types Finder decodes as raw pixels, so those sizes come out as noise; `tests/app-icon.test.ts` pins the committed file to `iconutil`'s layout. Rerun the script after changing the artwork and commit both outputs.

## Releases

Releases are cut by [semantic-release](https://semantic-release.gitbook.io/) from `main` — the `release` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), after the `ci` job passes on that push. There is no release branch, no version-bump commit and no changelog file: **the git tag is the version**, and the release notes live on the GitHub Release. `.releaserc.json` holds the rules.

| Commits since the last tag | Next version |
| --- | --- |
| only `docs`, `chore`, `ci`, `test`, `style`, `refactor` | no release |
| `fix`, `perf`, `revert`, `build` (dependency bumps ship in the app — Electron is one) | patch |
| `feat` | minor |
| any type with `!`, or a `BREAKING CHANGE:` footer | major |

It takes two jobs after `ci`. The `package` job runs the same way on every pull request and on `main`, with a read-only token: it decides the version from the commits (`node scripts/next-version.mts`, the same analyzer and rules semantic-release uses, which you can run locally); `npm version` stamps it into `package.json` (working tree only; with no release due the build stays `0.0.0`); then it runs `npm run package` and `npm run test:packaged` against that exact bundle and uploads the disk images, zips, blockmaps and `latest-mac.yml` to the run. On `main` only, and only when a version is due, the `release` job takes those files with a write token, pushes the tag, creates the GitHub Release with them, and attests build provenance for the shipped files (`gh attestation verify Cockpit-1.2.3-arm64.dmg --owner tashtit`). It builds nothing itself, and it refuses to publish if semantic-release decides a different version from the one that was packaged. A re-run on an already-released commit is a no-op, and `workflow_dispatch` on `main` runs the same jobs by hand.

A release is not one atomic step: semantic-release pushes the tag, creates the release as a draft, uploads the assets one at a time and clears the draft flag last. A GitHub 500 on one of the ~130MB disk images breaks that in the middle — it happened to `v0.11.0` — and the wreck cannot be cleared by re-running, because the tag now exists and the next run decides no release is due. So the `🎉 Finish a release left half-published` step picks up after a failed `🚢 Release`: `node scripts/finish-release.mts` re-uploads any asset that is missing or was stored short, publishes the draft, and lets the provenance attestation run as usual. It touches only a release carrying the version the package job built, and refuses otherwise, so a failure that is not this one still fails the run — the version check after it is the gate either way.

Versions start at `0.1.0`: semantic-release only ever bumps from an existing tag (with none it would begin at `1.0.0`), so the root commit carries a `v0.0.0` baseline tag and the first release is the minor bump from there, with the whole history in its notes. Breaking changes bump the major even below `1.0.0` — a `feat!` takes the app to `1.0.0`.

### Signing and notarization

The package job reads its Apple credentials from the `release` [environment](https://github.com/tashtit/cockpit/settings/environments). Without them the build is ad-hoc signed and the README tells users how to open it; with them electron-builder signs with the hardened runtime (`build/entitlements.mac.plist`), notarizes and staples, Gatekeeper opens the app without a prompt, and the in-app updater can complete installs.

| Secret | What |
| --- | --- |
| `CSC_LINK` | Developer ID Application certificate — the `.p12`, base64-encoded |
| `CSC_KEY_PASSWORD` | the password that `.p12` was exported with |
| `APPLE_ID` | the Apple account notarization runs as |
| `APPLE_APP_SPECIFIC_PASSWORD` | an [app-specific password](https://support.apple.com/102654) for that account |
| `APPLE_TEAM_ID` | the ten-character developer team id |

All five or none: `electron-builder.config.js` refuses a partial set at load, because Gatekeeper refuses a signed-but-unnotarized bundle exactly like an unsigned one. With the set present, signing is mandatory (`forceCodeSigning`) and `npm run package` ends with `scripts/verify-signing.mts`, which checks every bundle under `dist/` for a Developer ID Application signature from `APPLE_TEAM_ID`, the hardened runtime, a stapled notarization ticket and a passing `spctl` assessment — a release whose credentials failed to sign stops there instead of shipping unsigned. Without the set the same script checks that the bundles stayed ad-hoc: nothing that happens to sit in a keychain may sign a build.

#### Getting the five

Everything comes from an [Apple Developer Program](https://developer.apple.com/programs/) membership (individual or organization; the team id is on the membership page of the developer account). Once, per certificate:

1. **Certificate request** — Keychain Access › Certificate Assistant › *Request a Certificate From a Certificate Authority*, with your email, *Saved to disk*. This creates the private key in your login keychain and a `.certSigningRequest` file.
2. **Certificate** — under [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/add) create a certificate of type *Developer ID Application* from that request, download the `.cer` and double-click it so it joins its private key in the login keychain.
3. **Export** — in Keychain Access › My Certificates, select the *Developer ID Application* certificate (expand it to confirm the private key is attached), right-click › *Export*, format `.p12`, and give it a password. Base64 the file and the two secrets exist:

   ```bash
   base64 -i cockpit-developer-id.p12 | gh secret set CSC_LINK --env release --repo tashtit/cockpit
   gh secret set CSC_KEY_PASSWORD --env release --repo tashtit/cockpit   # paste the export password
   ```

4. **Notarization login** — `APPLE_ID` is the account's email and `APPLE_TEAM_ID` the team id; `APPLE_APP_SPECIFIC_PASSWORD` is generated for that account under *Sign-In and Security › App-Specific Passwords* on the Apple account page (never the account password). Set all three the same way, as secrets of the `release` environment — not repository secrets, so only the package job on `main` runs with them, never pull request code.

Dry-run locally before trusting a release to it: with the same five variables exported, `npm run package` signs, notarizes (a few minutes per architecture) and verifies exactly as the job does. Developer ID Application certificates are valid for five years; rotate by exporting the new one and replacing `CSC_LINK` and `CSC_KEY_PASSWORD`.

### How updates reach users

An installed Cockpit uses `electron-updater` (`src/main/updates.ts`) for the check alone: it reads the bundle's `app-update.yml`, fetches `latest-mac.yml` from the newest GitHub Release and compares versions — on launch, every four hours, and from **Settings › About**. Left alone it then fetches the new build and swaps it in the next time the app quits; both steps are switches in About, and "Restart now" does it sooner.

Downloading and installing are Cockpit's own (`src/main/update-install.ts`, decisions in `-core.ts`) rather than electron-updater's. Its macOS installer is Squirrel.Mac, which only swaps in a bundle carrying the same Developer ID signature as the running one — so with releases ad-hoc signed (above), *every* install ended in an error and the app could only announce versions it could not fetch for you. Installing here works signed or not, and it is the one place that can clear the quarantine flag before the new bundle lands rather than leaving Gatekeeper to block it afterwards.

What Squirrel's signature check stood for is done explicitly instead: the zip must hash to the `sha512` the feed publishes, and the bundle inside must carry the same `CFBundleIdentifier`, be the version that was offered, and — once releases are signed — be signed by the same team as the bundle it replaces. The swap itself is a detached `/bin/sh` script that waits for the app's pid to go, renames the old bundle aside within the same folder, `ditto`s the new one in and puts the old one back if that fails. A failed install leaves a line in `<userData>/updates/last-install`; the next launch reads it, says so in About and holds the automatic path until the user checks by hand, so a build that cannot be installed is never fetched again and again in silence.
