# Adding a provider

`Provider` in `src/shared/types.ts` is a closed union: `'claude' | 'codex' | 'copilot'`. Adding a value touches the places below. Work through both lists — the second is the one that bites, because nothing fails until a user notices the agent is missing from a picker.

## Typecheck finds these

Every `Record<Provider, …>` and every provider-keyed `as const` map refuses to compile until the new key exists:

- `src/main/indexer.ts` — `FILE_LISTERS`, `ROOT_LISTERS`, `META_PARSERS`, `MESSAGE_PARSERS`
- `src/main/accounts.ts` — the per-provider defaults record
- `src/main/handoff-core.ts` — `AGENT_NAME`
- `src/main/profile.ts` — `DEEP_PARSERS`
- `src/main/library.ts` — `PLUGIN_CMD`
- `src/shared/library.ts` — `PanelReport.cells`
- `src/shared/roundtable.ts` — `SEAT_NAME`
- `src/renderer/src/logos.tsx` — `PROVIDER_LABEL`, plus the SVG mark itself
- `src/renderer/src/NewSession.tsx` — `MODEL_SUGGESTIONS`, `AGENT_BLURB`

`Partial<Record<Provider, …>>` sites compile without the key; they need no edit.

## Typecheck does not find these

Hard-coded arrays silently omit the new provider from the UI and from cross-agent loops. Grep for `['claude', 'codex', 'copilot']` to find every one:

- `src/shared/library.ts` — `PROVIDERS`
- `src/main/roundtable-core.ts` — `PROVIDERS`
- `src/main/extensions.ts` — the `for (const agent of […])` loop
- `src/main/index.ts` — the inline provider checks in `assertKnownConfigDir` and the chat handler
- `src/renderer/src/NewSession.tsx`, `NewRoundtable.tsx`, `HandoffView.tsx`, `HomeView.tsx`, `Settings.tsx` — each view's `PROVIDERS`

Behavior that is provider-specific by construction:

- `src/main/config.ts` `detectDefaults()` — the config home to auto-detect on first run
- `src/main/indexer.ts` `auxStamp()` — only if the provider stores session names outside the transcript
- `src/main/provider-archived.ts` `listProviderArchivedIds()` — how the provider's own app marks sessions archived or deleted, so they stay hidden
- `src/main/chat.ts` — the provider `switch` near the top (spawn arguments and stream parsing), if the CLI can be driven headless
- `src/main/accounts.ts` and `src/main/usage.ts` — identity and usage, only where they can be read without touching credentials
- `src/renderer/src/style.css` — `--<provider>` and `--<provider>-rgb` tokens in `:root`, with the matching row in `design-system/cockpit/MASTER.md`
- `docs/guide/what-is-cockpit.md` — the table of session, instructions and MCP paths per agent
- `tests/parsers.test.ts` — a fixture with a malformed variant; `tests/indexer.test.ts` if grouping is affected
