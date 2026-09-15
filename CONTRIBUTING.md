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

There is no packaged build: `npm run dev` launches the stock `Electron.app` out of `node_modules`, and macOS names a running app after that bundle's `Info.plist`, never after the window title — the app menu, the Dock and Mission Control's full-screen spaces would all say "Electron". No runtime API changes that, so `predev` runs [`scripts/brand-dev-electron.mjs`](scripts/brand-dev-electron.mjs), which rewrites `CFBundleName` / `CFBundleDisplayName` in that bundle to `Cockpit` before every dev launch (the bundle is ad-hoc, linker-signed with the plist unbound, so its signature stays valid). It is idempotent, re-brands after an Electron upgrade or `npm ci` re-downloads the binary, and never blocks the launch — on failure it warns and the app keeps its stock name.

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

Adding a runtime dependency means adding a row here in the same pull request, with the license read from the package's own `package.json`.
