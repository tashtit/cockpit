# Troubleshooting

## "Electron failed to install correctly"

This message means the first-run Electron binary download failed. Run the downloader directly to see the underlying error:

```bash
npx install-electron
```

Common causes:

- **Proxy or firewall** blocking the fetch from GitHub releases — set `ELECTRON_MIRROR` to a mirror you can reach, then re-run `npx install-electron`.
- **Corrupt cached download** — `rm -rf ~/Library/Caches/electron` and retry.

## Sessions missing from the sidebar

Work through these in order:

1. **History window** — if Settings has a history window set, sessions idle longer than N days are hidden (not deleted). Widen or clear the window.
2. **Archived in the provider's own app** — sessions archived or deleted in Copilot (`data.db`), Codex (`archived_sessions/`), or the Claude desktop app are hidden entirely, by design.
3. **Copilot specifically** — its session format is the least documented, and the parser is best-effort. If your Copilot sessions don't appear, grab one file from `~/.copilot` and [open an issue](https://github.com/tashtit/cockpit/issues) with it (redact anything sensitive); the parser lives in `src/main/parsers/copilot.ts`.

Session log formats are provider-internal and drift between releases — Cockpit's parsers deliberately skip what they can't read rather than fail the whole scan, so a parser gap shows up as missing sessions, never a broken app.

## The agent says it can't use tools

That's the **Safe** permission mode: in headless mode, provider defaults may block tool use entirely. Re-run the task with **Auto-edit** (or, on a trusted repo, YOLO). See [permission modes](/guide/worktrees-and-prs#permission-modes).

## Wrong Node version

Cockpit needs **Node 22** (pinned in `.nvmrc`). Symptoms of an older Node range from install failures to test workers dying at startup. Fix:

```bash
nvm use
npm ci
```

## Placing the dev window

`electron-vite dev` relaunches the app on every main-process change, so a relaunch that fronts and focuses the window pulls you out of whatever you were typing. Dev builds therefore open the window **without taking focus** — it appears, your editor keeps the keyboard. Two env vars (dev-only, never in a packaged app) tune that:

| | |
| --- | --- |
| `npm run dev:fg` | opt back in to a fronted, focused window (`COCKPIT_DEV_BACKGROUND=0`) |
| `COCKPIT_DEV_DISPLAY=1 npm run dev` | open centered on a specific display (0-based OS index) |

Display order is OS-assigned and won't necessarily match your mental "first/second screen" — when `COCKPIT_DEV_DISPLAY` is set, the dev console prints the display table so you can pick the right index.

## PR features don't work

Cockpit shells out to the [GitHub CLI](https://cli.github.com) for everything PR-shaped. Check that `gh` is installed and authenticated (`gh auth status`) — Settings shows the detected `gh` user.
