# Adding a provider

There are two unions in `src/shared/types.ts`, and a new agent joins one of them:

- `Provider` — `'claude' | 'codex' | 'copilot'`, the CLIs Cockpit **drives** (spawns, resumes, seats, signs in, measures).
- `ReadOnlyProvider` — the agents Cockpit only **reads** (Gemini CLI, Cursor, Cline, Roo Code, opencode, Antigravity). `SessionProvider` is both: it types every session, source and index query, and `isDrivable` (`src/shared/providers.ts`) is the guard wherever a session reaches something that drives a CLI.

An agent that keeps sessions in SQLite rather than log files reads them through `parsers/sqlite.ts` (read-only opens, a snapshot per database change). A database holding many sessions indexes each as `<db>#<id>` — add its file name to `SHARED_DBS` in `indexer.ts` so the database is watched and stat-checked in the sessions' place. One database per session (Antigravity) needs nothing more than the watcher's `.db`/`-wal` rule already gives it. Test fixtures for these stores are built by `scripts/ui-tour/store-fixtures.mts`, which the tour's world shares.

**A read-only agent** is the short path: add it to `ReadOnlyProvider` and `READ_ONLY_PROVIDERS`, write its parser, register it in the indexer's four maps, teach `src/main/agent-homes.ts` where its home is (so every launch detects it), and give it a `PROVIDER_LABEL`, a `ProviderLogo` mark and its `.plogo-*`/`.tint-*`/`.badge-*`/`.acct-*` rules. Typecheck walks you through the rest — every `Record<SessionProvider, …>` — and everything that drives a CLI already refuses it. Transcript search needs a record extractor for its log (`src/main/transcript-search.ts`).

**A driven agent** touches everything below. Work through both lists — the second is the one that bites, because nothing fails until a user notices the agent is missing from a picker.

## Typecheck finds these

Every `Record<Provider, …>` and every provider-keyed `as const` map refuses to compile until the new key exists:

- `src/main/indexer.ts` — `FILE_LISTERS`, `ROOT_LISTERS`, `META_PARSERS`, `MESSAGE_PARSERS`
- `src/main/accounts.ts` — the per-provider defaults record
- `src/main/profile.ts` — `DEEP_READ_BYTES`, `DEEP_READERS`
- `src/main/library.ts` — `PLUGIN_CMD`
- `src/shared/library.ts` — `PanelReport.cells`
- `src/shared/providers.ts` — `AGENT_NAME`, `CONFIG_HOME_VAR` (`SEAT_NAME` in `src/shared/roundtable.ts` is `AGENT_NAME`)
- `src/renderer/src/logos.tsx` — `PROVIDER_LABEL`, plus the SVG mark itself
- `src/renderer/src/agent-choice.ts` — `AGENT_BLURB`

`Partial<Record<Provider, …>>` sites compile without the key; they need no edit.

## Typecheck does not find these

Hard-coded arrays silently omit the new provider from the UI and from cross-agent loops. Grep for `['claude', 'codex', 'copilot']` to find any that remain:

- `src/shared/providers.ts` — `PROVIDERS`, `isProvider`, `AGENT_NAME`, `CONFIG_HOME_VAR`: every main-side list and check of the three reads these (IPC input goes through `isProvider` in `src/main/ipc/guards.ts`)
- the renderer's own labels and icons (`PROVIDER_LABEL` and the logos in `logos.tsx`)

Behavior that is provider-specific by construction:

- `src/main/agent-homes.ts` `detectAgentHomes()` — where its home is; every launch adds a home that appeared, and never re-adds one the person removed
- `src/main/indexer.ts` `auxStamp()` — only if the provider stores session names outside the transcript
- `src/main/provider-archived.ts` `listProviderArchivedIds()` — how the provider's own app marks sessions archived or deleted, so they stay hidden
- `src/main/chat.ts` — the provider `switch` near the top (spawn arguments and stream parsing), if the CLI can be driven headless
- `src/main/accounts.ts` and `src/main/usage.ts` — identity and usage, only where they can be read without touching credentials
- `src/renderer/src/style.css` — `--<provider>` and `--<provider>-rgb` tokens in `:root`, with the matching row in `design-system/cockpit/MASTER.md`
- `docs/guide/what-is-cockpit.md` — the table of session, instructions and MCP paths per agent
- `tests/parsers.test.ts` — a fixture with a malformed variant; `tests/indexer.test.ts` if grouping is affected
