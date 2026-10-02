# Adding an agent

There are two unions in `src/shared/types.ts`, and a new agent joins one of them:

- `Provider` — `'claude' | 'codex' | 'copilot'`, the CLIs Cockpit **drives** (spawns, resumes, seats, signs in, measures).
- `ReadOnlyProvider` — the agents Cockpit only **reads** (Gemini CLI, Cursor, Cline, Roo Code, opencode, Antigravity), though an ACP agent can still drive one (`acpAgentFor` in `src/main/services.ts`). `SessionProvider` is both: it types every session, source and index query, and `isDrivable` (`src/shared/providers.ts`) is the guard wherever a session reaches something that spawns a CLI.

**A read-only agent** is the short path: everything that drives a CLI already refuses it, so it skips the steps marked *driven*. **A driven agent** takes every step. A step marked *(typecheck)* fails `npm run typecheck` until it is done; every other one fails nothing — the agent is simply missing from a list, a watch or a picker until a user notices. `Partial<Record<…>>` maps compile without the new key, which is why `SHARED_DBS`, `OWN_DBS` and `EXTRACTORS` are steps of their own.

The steps follow a session from the disk to the screen.

## 1. Name it

- `src/shared/types.ts` — add it to `ReadOnlyProvider` (driven: `Provider`).
- `src/shared/providers.ts` — `READ_ONLY_PROVIDERS` (driven: `PROVIDERS`), in the order the app lists agents; `SESSION_PROVIDERS`, `isProvider`, `isSessionProvider` and `isDrivable` follow from them, and IPC input goes through those (`src/main/ipc/guards.ts`). `AGENT_NAME` (its product name, for sentences) and `AGENT_LABEL` (what every surface calls it; `logos.tsx` re-exports it as `PROVIDER_LABEL`) *(typecheck)*. Driven: `CONFIG_HOME_VAR` *(typecheck)*; `SEAT_NAME` in `src/shared/roundtable.ts` is `AGENT_NAME`.

## 2. Find its home

- `src/main/agent-homes.ts` `detectAgentHomes()` — where its home is and the label Settings shows for it, counted once its session root exists. Every launch adds a home that appeared and never re-adds one the person removed (`reconcileDetected`). The CLIs Cockpit drives are found as `~/.<provider>` from the home alone; a driven agent whose home is named otherwise needs a line of its own.

## 3. Read its sessions

- `src/main/parsers/<agent>.ts` — the four exports, each store read with its bounded helper (see `SKILL.md`).
- `src/main/indexer.ts` — `FILE_LISTERS`, `ROOT_LISTERS`, `META_PARSERS`, `MESSAGE_PARSERS` *(typecheck)*.
- A database of many sessions: its file name in `SHARED_DBS`, each session keyed `<db>#<id>` (`sessionRef`), so the database is watched and stat-checked in the sessions' place. A database per session under a session root (Antigravity): an `OWN_DBS` predicate — the watcher ignores `.db` and `-wal` files, so without one a conversation's writes never reach the index. Either kind of database is named `*.db` or `*.vscdb`, or `isDatabase` (and for a database per session, the `*.db` pattern in `sessionRootEvent`) learns its name — otherwise it is cached by mtime and size and its write-ahead log goes unseen.
- Names kept outside the log: stamped by `auxStamp`, or re-checked per entry as Codex's are (`sameThreadName`), with a watch on the file that holds them.

## 4. Hide and delete it the way its app does

- Archived or deleted in its own app: a mark in the session's own store is the parser's to honor (Codex's `archived_sessions/`, opencode's `time_archived`); state kept elsewhere is read by `ProviderArchivedReader.list()` in `src/main/provider-archived.ts`, with a watch on that store in `indexer.ts` (the Claude desktop app's records, Copilot's `data.db`).
- `src/main/session-disposal.ts` `disposalOf` — what deleting one session removes, the way the agent keeps it *(typecheck)*.

## 5. Search it

- `src/main/transcript-search.ts` — a JSONL log is streamed line by line and needs a record extractor in `EXTRACTORS`; any other store is searched through its parser's rows and needs nothing.

## 6. Drive it

- An agent with an ACP server: a `BUILTIN_ACP_AGENTS` entry in `src/shared/acp.ts` (`command`, `args`, `provider`, `builtin: true`, and `signIn`, `authMethod` or `env` where its login needs them). Every launch runs its handshake; once it answers, `acpAgentFor` drives the agent and the renderer offers it (`acp-readiness.ts`). Without one the agent stays read-only, continued through **Continue in…**.
- Driven, typecheck finds: `buildCommand` in `src/main/chat.ts` (spawn arguments), `judgeTail` in `src/main/liveness-core.ts` (whether its log says a turn is running), `buildSummarizeCommand` in `src/main/handoff-core.ts`, `getAccounts` in `src/main/accounts.ts` (how it signs in), `DEEP_READ_BYTES` and `DEEP_READERS` in `src/main/profile.ts`, `PLUGIN_CMD` and `MARKET_REFRESH` in `src/main/library.ts`, `PanelReport.cells` in `src/shared/library.ts`, `SIGN_IN_COMMAND` (`src/shared/agent-auth.ts`), `CLI_PACKAGE` (`src/shared/agent-cli.ts`), `BUILTIN_MODELS` and `EFFORT_LEVELS` (`src/shared/agent-models.ts`), `AGENT_BLURB` (`src/renderer/src/agent-choice.ts`), `USAGE_SOURCE` (`src/renderer/src/AccountsSection.tsx`).
- Driven, typecheck does not find: how its output becomes `ChatEvent`s (`parseClaudeStreamLine` and `parseCodexStreamLine` beside `buildCommand`). `buildSnapshot` in `src/main/usage.ts` branches on the provider by hand, ending at Copilot, so a new agent has no usage at all until it has a branch of its own — read only what can be read without touching credentials. Then grep `src/` for `'copilot'`: every other hand-written branch on the provider (`mcp.ts`, `turn-ledger.ts`, `roundtable-core.ts`, `handoff.ts`) names one of its siblings.

## 7. Draw it

- `src/renderer/src/logos.tsx` — its mark in `ProviderLogo` *(typecheck: the dispatch's last branch indexes `MARK_PATH`)*, drawn in its brand's own colours with a one-colour `mono` form for the chat header's solid badge, and its source named in the file's header comment.
- `src/renderer/src/style.css` — its colour in `:root`: a brand colour of its own as `--<agent>` and `--<agent>-rgb` (`--gemini`), or the shared `--mono-mark` for a brand with none; a mark in several colours adds `--<brand>-*` tokens and `.mark-*` classes. Then a rule in every per-agent slot: `.logo-*`/`.plogo-*`, `.acct-*`, `.badge-*`, `.tint-*`, `.avatar.plogo-*`, `.session-row.selected:has(.plogo-*)`, `.lineage-chip.acct-*:hover`; one that can start sessions (driven, or over ACP) also `.ns-provider.ns-*.active` and `.composer-agent.active.plogo-*`; a driven one the home board's livery (`.pulse-*`, `.board-agent-*`, the `.board-row.flying` and `.board-row.landed` `:has(…)` rules). Grep the stylesheet for an existing agent's name to find every slot.
- `design-system/cockpit/MASTER.md` — its row in the colour-token table, its `-rgb` in the alpha companions, and its name in the livery rule under them.
- `scripts/licenses/notices.ts` `fixedNotices` — the licence of the mark's path data when it comes from a licensed source: name the mark in an existing entry's text (Lobe Icons names Gemini, Antigravity and Cursor) or add an entry. Notices are generated, never hand-written.

## 8. Put it in the tour

- `scripts/ui-tour/world.mts` — a home and sessions for it in `populate`, landing in one of the world's repositories (databases through `store-fixtures.mts`, which the tests share). When it is driven, its CLI name in `writeStubs` and an answer in `stub-cli.mjs`; when it only has a built-in ACP agent the world does not run, its CLI name in `ABSENT_CLIS` (a stub that is not there) — `tests/ui-tour-world.test.ts` fails on a built-in ACP agent with neither: main always adds the common install dirs to PATH (`cliPath` in `env.ts`), so a copy installed on this machine would otherwise answer the launch-time probe and the tour would screenshot a different app.
- `tests/ui-tour-world.test.ts` — parses the world with the real parsers and lists the read-only agents' detected homes and sessions by name; add the new ones.

## 9. Tell the person

- `docs/guide/sessions.md` — the *Agents Cockpit reads* table (where its sessions are found) and the paragraphs under it that name which agents run over ACP and which stay read-only.
- The guide's other lists of agents: `what-is-cockpit.md` (the read-only agents sentence; a driven agent's row in the sessions, instructions and MCP table), `getting-started.md`, `accounts-and-usage.md`, `cleanup.md` (what deleting one removes), and `acp-agents.md` (its built-in command, and how to sign it in) when it has an ACP server.

## 10. Test it

- `tests/parsers.test.ts` — a fixture with a malformed variant; `tests/indexer.test.ts` if grouping or watching is affected; `tests/agent-homes.test.ts` for detection, `tests/session-disposal.test.ts` for deletion, `tests/component/logos.test.tsx` for a mark drawn in its brand's colours.
