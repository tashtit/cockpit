---
name: add-session-parser
description: Add or fix an agent's session parser in src/main/parsers (Claude, Codex, Copilot, Gemini CLI, Cursor, Cline, Roo Code, opencode, Antigravity, or a new agent). Use when a session's title, cwd, branch, timestamps or message count are wrong, a transcript opens empty, an agent changed its log or database format after an upgrade, or a new agent's sessions need indexing. Not for sessions hidden by the history window, provider-side archiving or roundtable seat filtering — check those first.
---

# Session parsers

One module per agent in `src/main/parsers/` (Cline and Roo Code share `cline.ts`), wired into `src/main/indexer.ts` through four maps keyed by `SessionProvider` (`FILE_LISTERS`, `ROOT_LISTERS`, `META_PARSERS`, `MESSAGE_PARSERS`). Each parser exports, in the order the indexer uses them:

- `list<P>SessionRoots(sourceDir)` — the ONLY subdirectories the indexer walks and watches (e.g. claude: `projects/`). Never return the whole config dir: agent homes contain `pkg/`, `repos/`, logs, and SQLite files that must not be scanned. A database holding many sessions is not a root; it is watched on its own (see Invariants).
- `list<P>SessionFiles(sourceDir)` — the candidate sessions under those roots; this is what the scan loop calls. A file path, or `sessionRef(db, id)` for a session inside a shared database.
- `parse<P>Meta(file, label)` — cheap metadata scan producing `SessionMeta` (`src/shared/types.ts`).
- `parse<P>Messages(sourcePath)` — full transcript parse into `SessionMessage[]`, on demand only (when a session is opened).

`list<P>Sessions(sourceDir, label)` — the listing and meta parse without the indexer — is for tests only: the three CLIs' live in `tests/list-sessions.ts`, the other agents' beside their parser. The indexer never calls it.

## Not a parser bug if…

Check these before touching a parser when a session is "missing":

- the history window hides it (`historyDays` in Settings);
- the agent's own app archived or deleted it (`src/main/provider-archived.ts` reads Claude's and Copilot's apps; Codex's `archived_sessions/` and opencode's `time_archived` are honored by their parsers);
- the tree's eye popover hides its agent (`agent-filter.ts`) or its side (*In Cockpit* / *Outside Cockpit*);
- it is a roundtable seat — those are hidden from every normal listing and page only under `SessionQuery.roundtableId`;
- its config home is not a registered source (an agent Cockpit only reads is found by `src/main/agent-homes.ts`, and a home the person removed stays removed), or the session lives outside `list<P>SessionRoots`;
- the stat-cache is serving stale meta (see `CACHE_VERSION` below).

## Stores and their readers

Agents keep sessions in three kinds of store. Each has a bounded reader — a 58MB log must never be fully parsed:

- **A JSONL log** (Claude, Codex, Copilot, Gemini CLI, Cursor's agent transcripts). Meta from the head: each parser declares `const META_HEAD_BYTES = 256 * 1024` and reads `readHead(file, META_HEAD_BYTES)` through `parseJsonlText`. The transcript from a ≤4MB tail, `readJsonlTail` (`TRANSCRIPT_TAIL_BYTES`).
- **One JSON document or array** (the Cline family's `ui_messages.json`, older Gemini CLI `session-*.json` logs, opencode's older file store, Copilot's legacy layout). An array is read from its end element by element with `readJsonArrayTail`, its meta from the head with `jsonArrayItems`; a document is read whole or not at all under a cap (`readSmallFile`, `readJson`).
- **A SQLite database** (opencode, Antigravity, Cursor's editor chats and its ACP server's conversations), through `parsers/sqlite.ts`: `queryAll` opens read-only for one query and returns null rather than throw (another app owns the database and is writing to it), and `snapshotCache` keeps one listing per database change — a failed read keeps the last good answer instead of dropping every session in it. Transcripts spend the same `TRANSCRIPT_TAIL_BYTES` newest first through `queryEach`, which steps one row at a time and stops at the budget, and oversized rows are left unread in the SQL itself. The file must end in `.db` or `.vscdb`: only those go by their stamp, write-ahead log counted (`isDatabase` in `indexer.ts`) — any other name is cached by mtime and size, and its writes never reach the index until `isDatabase` learns it. Rows that are protobuf with no published schema (Antigravity's steps, Cursor's ACP blobs) are read by field path with `parsers/protobuf.ts` (`protoString`, `protoAll`, …).

The rest of `parsers/util.ts` is shared by all three: `readTail`, `contentToText`, `capText`, `toMs`, `truncate`, `usableCwd`, `walkFiles`, `fileTimes`, `toolPreview`.

## Invariants

- **Bump `CACHE_VERSION`** in `src/main/indexer.ts` whenever `parse<P>Meta` output changes shape or values. The stat-cache is keyed on mtime+size, so without the bump a corrected parser changes nothing for files already indexed — the fix looks broken.
- **Failure-tolerant.** Formats are agent-internal and drift between releases. Skip unreadable files/lines/rows (return `null` / skip). The indexer wraps every parser call in try/catch and the read helpers swallow IO errors, so a throw is lost data plus log noise rather than a crash — still never throw. Files may be mid-write: pass `head.truncated` as `dropLast` to `parseJsonlText` so a cut-off last line is dropped.
- **Format drift is expected.** Handle old and new shapes side by side (codex handles both `msg.type` and `thread.started`/`item.completed` events; Gemini CLI reads its older one-document logs beside the JSONL ones; opencode its file store beside the database); don't remove support for an older shape when adding a newer one.
- **One event, one row.** A log can record the same thing twice in different shapes — Codex writes each message as a ResponseItem *and* an `event_msg` echo, and a code-mode `exec` script *and* a typed `item_completed` per tool run it made. Pick the canonical source per file from what the file itself contains (`usesEventEchoes`, and `toolRecords` for tool runs, in `codex.ts`), never both, and never by CLI version. The Profile's tallies (`deepCodex` in `profile.ts`) read tool runs through the same `toolRecords`, so a new tool shape belongs in both.
- **A session inside a shared database** is keyed `<db>#<id>` (`sessionRef` / `splitSessionRef` in `parsers/sqlite.ts`), and the database's file name goes in `SHARED_DBS` in `indexer.ts`: the indexer watches the database's folder (not recursively) for its own files and stat-checks the database, its `-wal` counting, in the sessions' place. A database per session under a session root (Antigravity's conversations, Cursor's ACP store) needs an `OWN_DBS` predicate instead — the watcher ignores `.db` and `-wal` files, so without one a conversation's writes never reach the index. That path in `sessionRootEvent` matches only `*.db` and its `-wal`/`-shm`/`-journal`, so a database named otherwise needs it taught as well as `isDatabase`.
- **Names stored outside the transcript** must invalidate the cache entry, or a rename never shows. Copilot's `workspace.yaml` is stamped into the entry by `auxStamp` in `indexer.ts` (a database's sessions go by its `dbStamp`, `-wal` counted, in `CacheEntry.db` instead); Codex's names live in one shared `session_index.jsonl`, whose mtime cannot stand for any one rollout, so `sameThreadName` re-checks the entry's own thread (`CacheEntry.threadId`/`threadName`), and the indexer watches the home for that file.
- **Meta fields matter downstream:** `cwd` drives repo grouping (`repos.ts`, worktree-aware); `logBranch` is the branch the log itself records — a parser never reads the checkout, the indexer's `annotate()` derives `repo`, `isWorktree` and `gitBranch`; `repoFullName`, when the agent states owner/repo itself (Copilot and Antigravity do), wins over the git lookup; `id` is `${provider}:${nativeId}`; `sourcePath` is what `parse<P>Messages` receives later (`<db>#<id>` for a shared database).

## Adding an agent

`Provider` (the CLIs Cockpit drives) and `ReadOnlyProvider` (the agents it only reads) are closed unions, and several lists of them are hand-maintained. Follow `references/new-provider.md`: the checklist in data-flow order, marking what typecheck catches and what it does not.

## Tests

Every parser change gets a vitest case in `tests/parsers.test.ts` (or `tests/indexer.test.ts` for grouping and watching behavior): write a realistic fake session log into a tmpdir fixture with the `jsonl()` helper at the top of the file — a database with `scripts/ui-tour/store-fixtures.mts` (`writeOpencodeDb`, `writeCursorChats`, `writeCursorAcpSession`, `writeAntigravityConversation`, `protoEncode`) — and run the real parser over it, including a malformed/truncated variant. No mocks. `tests/ui-tour-world.test.ts` parses the tour's world with the same parsers, so a change that stops reading its fixtures fails there too.
