---
name: add-ipc-capability
description: Add or extend a Cockpit IPC capability — a new CockpitApi / window.cockpit method, ipcMain.handle channel, preload bridge method, or main-to-renderer push event. Use when a feature needs data or an action to cross the renderer/main boundary (expose a main-process function to the UI, persist a setting, subscribe the UI to main-process events). Not for renderer-only state or main-only refactors that leave the bridge unchanged.
---

# Add an IPC capability

The entire renderer↔main surface is the `CockpitApi` type in `src/shared/types.ts` — a `type` alias with `readonly` members, like every shared type here. A new capability is four edits, in this order, then a consumer:

1. **`src/shared/types.ts`** — define the request/response types and add the method to `CockpitApi` as a `readonly` member. This is the contract; everything else follows from it.
2. **`src/main/index.ts`** — `ipcMain.handle('domain:verb', …)`. Invoke channels are `domain:verb` (`sessions:page`, `workspace:pr`, `panel:set-switch`, `cleanup:set-stale-days`).
3. **`src/preload/index.ts`** — bridge method calling `ipcRenderer.invoke('domain:verb', …)` on the object handed to `contextBridge`.
4. **`tests/component/stub-api.ts`** — add the method to `freshApi()`. It is typed as a complete `CockpitApi` and `tsconfig.json` includes `tests/**`, so `npm run typecheck` fails until the stub has it.

Then call it from components as `api.<method>()` via `import { api } from './api'`. `src/renderer/src/api.ts` is a one-line re-export of `window.cockpit` and is never edited; components never touch `window.cockpit` directly.

Keep handler bodies in `index.ts` thin: real logic lives in a dedicated main module (`indexer.ts`, `instructions.ts`, `workspace.ts`, `cleanup.ts`, …) or an IO-free `-core.ts` so it can be tested without Electron.

## Worked example — the stale-days setting

```ts
// src/shared/types.ts, inside CockpitApi
readonly getStaleDays: () => Promise<number>
readonly setStaleDays: (days: number) => Promise<void>

// src/main/index.ts (abridged)
ipcMain.handle('cleanup:stale-days', () => loadConfig().staleDays ?? DEFAULT_STALE_DAYS)
ipcMain.handle('cleanup:set-stale-days', (_e, days: number) => {
  setStaleDays(Number(days)) // renderer input is coerced before use
  // …
})

// src/preload/index.ts, inside the exposed object
getStaleDays: () => ipcRenderer.invoke('cleanup:stale-days'),
setStaleDays: (days: number) => ipcRenderer.invoke('cleanup:set-stale-days', days),

// tests/component/stub-api.ts, inside freshApi()
getStaleDays: vi.fn(async () => 30),
setStaleDays: vi.fn(async () => {}),
```

## Security rules (non-negotiable)

- Renderer args are untrusted, whatever their TypeScript type says. Coerce primitives (`String(x)`, `Number(x)`) and re-check union-typed values before they reach a path, a spawned command, or a config key — `asPanelKind` and the `Provider` check inside `assertKnownConfigDir` are the pattern; the compile-time type does not survive the bridge.
- Any path argument must be validated against roots main itself derived, with the `src/main/index.ts` helper that matches its role: `assertKnownRepoRoot` (a repo the indexer found), `assertKnownCwd` (the app's worktrees dir, a known repo root or below, or an indexed session's cwd — the only places a chat turn may run), `assertKnownConfigDir` (a configured source or the provider default). Never act on an arbitrary renderer-supplied path.
- All fs / git / child_process work stays in main. The renderer is sandboxed (`contextIsolation`, `sandbox: true`) and must remain so.
- Cap what crosses the bridge: paginate lists (`SessionQuery`/`SessionPage`), cap message text (`capText` in `src/main/parsers/util.ts`), never ship a full index.

## Push events (main → renderer)

Push with `sendToWin('event-name', payload)` in `src/main/index.ts`, never `win.webContents.send` directly: streams and scans outlive the window on macOS, and sending to a destroyed webContents throws inside the stream handler and takes the main process down — the helper checks `win.isDestroyed()` first. Push channels are kebab-case nouns (`index-updated`, `busy-sessions`, `chat-event`, `roundtable-event`). Pair each with a preload `onX(cb)` that returns an unsubscribe function, a `readonly onX: (cb: …) => () => void` member on `CockpitApi`, and `onX: vi.fn(() => () => {})` in the stub — follow `onIndexUpdated` / `onBusySessions`.

## Verify

`npm run typecheck && npm test`. Main-side logic that is more than a pass-through gets a vitest file under `tests/` using real tmpdir fixtures (see `tests/indexer.test.ts` — no mocking framework). A view that starts calling the new method sets what the stub returns in its component test with `vi.mocked(window.cockpit.<method>).mockResolvedValue(…)` (see `tests/component/agent-panel.test.tsx`).
