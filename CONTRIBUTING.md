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
| `electron-updater` | Checks GitHub Releases for a newer build and hands the downloaded bundle to macOS's native updater (`src/main/updates.ts`) | MIT | Electron's own `autoUpdater` needs a server speaking the Squirrel.Mac protocol; this reads a static manifest off the release instead — no update server to run |

Adding a runtime dependency means adding a row here in the same pull request, with the license read from the package's own `package.json`.

## Packaging

`npm run package` builds `out/` and then runs electron-builder (`electron-builder.config.js`) for macOS: a `.dmg` and a `.zip` for each of arm64 and x64 land in `dist/`, plus `latest-mac.yml`, the manifest the in-app updater reads. Locally the result is unsigned — macOS asks you to clear the quarantine flag (README, "Install") — and versioned `0.0.0`: the real version is stamped at release time and never committed, which is why `package.json` says `0.0.0`.

`npm run test:packaged` launches the bundle for your architecture under Playwright and checks that it boots as an installed app with the updater wired to GitHub Releases. Unlike the other e2e specs it uses your real userData directory and provider homes, because a packaged build refuses the `COCKPIT_USER_DATA` override by design.

The bundle ships with Electron fuses flipped (`electronFuses` in the config): no `ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, asar integrity validation, app code only from the asar. Node's `--inspect` flags stay enabled because Playwright attaches to the packaged bundle through them in the smoke test.

## Releases

Releases are cut by [semantic-release](https://semantic-release.gitbook.io/) from `main` — the `release` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml), after the `ci` job passes on that push. There is no release branch, no version-bump commit and no changelog file: **the git tag is the version**, and the release notes live on the GitHub Release. `.releaserc.json` holds the rules.

| Commits since the last tag | Next version |
| --- | --- |
| only `docs`, `chore`, `ci`, `test`, `style`, `refactor` | no release |
| `fix`, `perf`, `revert`, `build` (dependency bumps ship in the app — Electron is one) | patch |
| `feat` | minor |
| any type with `!`, or a `BREAKING CHANGE:` footer | major |

What the job does, in order: decide the version from the commits; `npm version` it into `package.json` (working tree only); `npm run package`; `npm run test:packaged` against that exact bundle; push the tag; create the GitHub Release with the disk images, zips, blockmaps and `latest-mac.yml`; attest build provenance for the shipped files (`gh attestation verify Cockpit-1.2.3-arm64.dmg --owner tashtit`). A re-run on an already-released commit is a no-op, and `workflow_dispatch` on `main` runs the same job by hand.

The first release semantic-release ever makes is `1.0.0` when no tag exists. To keep the app in `0.x`, push a `v0.1.0` tag on `main` before the first release run (`git tag v0.1.0 <sha> && git push origin v0.1.0`); the next release then becomes `0.2.0` or `0.1.1`.

### Signing and notarization

The release job reads its Apple credentials from the `release` [environment](https://github.com/tashtit/cockpit/settings/environments). Without them the build is unsigned and the README tells users how to open it; with them electron-builder signs with the hardened runtime (`build/entitlements.mac.plist`) and notarizes, and the in-app updater can complete installs.

| Secret | What |
| --- | --- |
| `CSC_LINK` | Developer ID Application certificate — the `.p12`, base64-encoded |
| `CSC_KEY_PASSWORD` | its password |
| `APPLE_ID` | the Apple account notarization runs as |
| `APPLE_APP_SPECIFIC_PASSWORD` | an [app-specific password](https://support.apple.com/102654) for that account |
| `APPLE_TEAM_ID` | the developer team |

Signing needs the first two, notarization all five; `electron-builder.config.js` switches each on by presence, so a missing set degrades to an unsigned build rather than a failed job.

### How updates reach users

An installed Cockpit runs `electron-updater` (`src/main/updates.ts`): it reads the bundle's `app-update.yml`, fetches `latest-mac.yml` from the newest GitHub Release and compares versions — on launch, every four hours, and from **Settings › About**. Nothing downloads on its own; the About row offers the version, downloads the `.zip` on request and installs it on the next quit (or "Restart to install"). macOS will only swap in a signed bundle, so until the signing secrets exist an update ends in an error at the install step and users replace the app from the disk image.
