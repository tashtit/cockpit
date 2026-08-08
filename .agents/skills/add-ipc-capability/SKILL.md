---
name: add-ipc-capability
description: Add or extend a Cockpit IPC capability — a new window.cockpit method, IPC channel, or main-process feature exposed to the React renderer. Use when a feature needs data or an action to cross the renderer/main boundary.
---

# Add an IPC capability

The entire renderer↔main surface is the `CockpitApi` interface. Touch exactly these four places, in order:

1. **`src/shared/types.ts`** — define the request/response types and add the method to `CockpitApi`. This is the contract; everything else follows from it.
2. **`src/main/index.ts`** — `ipcMain.handle('domain:verb', …)`. Channel names are `domain:verb` (`sessions:page`, `workspace:pr`, `extensions:share-mcp`).
3. **`src/preload/index.ts`** — bridge method calling `ipcRenderer.invoke('domain:verb', …)`.
4. **`src/renderer/src/api.ts`** — the typed wrapper the UI imports. Components never touch `window.cockpit` directly.

Keep handler bodies in `index.ts` thin: real logic lives in a dedicated main module (`indexer.ts`, `instructions.ts`, `workspace.ts`, …) so it can be tested without Electron.

## Security rules (non-negotiable)

- Renderer args are untrusted. Coerce primitives (`String(x)`, `Boolean(x)`) before use.
- Any path argument must be validated against roots the indexer itself derived — use `assertKnownRepoRoot` in `src/main/index.ts` (or the worktrees-dir check in `workspace:pr`). Never act on an arbitrary renderer-supplied path.
- All fs / git / child_process work stays in main. The renderer is sandboxed (`contextIsolation`, `sandbox: true`) and must remain so.
- Cap what crosses the bridge: paginate lists (`SessionQuery`/`SessionPage`), cap message text (`capText`), never ship a full index.

## Push events (main → renderer)

Use `win.webContents.send('event-name', payload)` plus a preload `onX(cb)` subscription that returns an unsubscribe function — follow `onIndexUpdated` / `onChatEvent`.

## Verify

`npm run typecheck && npm test`. If the new logic is non-trivial, add a vitest file under `tests/` using real tmpdir fixtures (see `tests/indexer.test.ts` for the pattern — no mocking framework).
