---
name: add-session-parser
description: Add or fix a provider session-log parser in src/main/parsers (Claude, Codex, Copilot, or a new agent). Use when a session's title, cwd, branch, timestamps or message count are wrong, a transcript opens empty, a provider changed its log format after an upgrade, or a new provider's session files need indexing. Not for sessions hidden by the history window, provider-side archiving or roundtable seat filtering — check those first.
---

# Session parsers

One module per provider in `src/main/parsers/`, wired into `src/main/indexer.ts` through four per-provider maps (`FILE_LISTERS`, `ROOT_LISTERS`, `META_PARSERS`, `MESSAGE_PARSERS`). Each parser exports, in the order the indexer uses them:

- `list<P>SessionRoots(sourceDir)` — the ONLY subdirectories the indexer walks and watches (e.g. claude: `projects/`). Never return the whole config dir: provider homes contain `pkg/`, `repos/`, logs, and SQLite files that must not be scanned.
- `list<P>SessionFiles(sourceDir)` — the candidate transcript files under those roots; this is what the scan loop calls.
- `parse<P>Meta(file, label)` — cheap metadata scan producing `SessionMeta` (`src/shared/types.ts`).
- `parse<P>Messages(sourcePath)` — full transcript parse into `SessionMessage[]`, on demand only (when a session is opened).

`list<P>Sessions(sourceDir, label)` also exists, but only tests call it; the indexer does not.

## Not a parser bug if…

Check these before touching a parser when a session is "missing":

- the history window hides it (`historyDays` in Settings);
- the provider's own app archived or deleted it (`src/main/provider-archived.ts`);
- it is a roundtable seat — those are hidden from every normal listing and page only under `SessionQuery.roundtableId`;
- its config home is not a registered source, or the file lives outside `list<P>SessionRoots`;
- the stat-cache is serving stale meta (see `CACHE_VERSION` below).

## Invariants

- **Bump `CACHE_VERSION`** in `src/main/indexer.ts` whenever `parse<P>Meta` output changes shape or values. The stat-cache is keyed on mtime+size, so without the bump a corrected parser changes nothing for files already indexed — the fix looks broken.
- **Bounded reads.** Each parser declares `const META_HEAD_BYTES = 256 * 1024` and reads meta with `readHead(file, META_HEAD_BYTES)`; transcripts read a ≤4MB tail via `readJsonlTail`. A 58MB log must never be fully parsed. Use the helpers in `parsers/util.ts` (`readHead`, `readTail`, `readJsonlTail`, `parseJsonlText`, `contentToText`, `capText`, `toMs`, `truncate`, `walkFiles`, `fileTimes`, `toolPreview`).
- **Failure-tolerant.** Formats are provider-internal and drift between releases. Skip unreadable files/lines (return `null` / skip). The indexer wraps every parser call in try/catch and the read helpers swallow IO errors, so a throw is lost data plus log noise rather than a crash — still never throw. Files may be mid-write: pass `head.truncated` as `dropLast` to `parseJsonlText` so a cut-off last line is dropped.
- **Format drift is expected.** Handle old and new shapes side by side (codex handles both `msg.type` and `thread.started`/`item.completed` events); don't remove support for an older shape when adding a newer one.
- **One event, one row.** A log can record the same thing twice in different shapes — Codex writes each message as a ResponseItem *and* an `event_msg` echo, and a code-mode `exec` script *and* a typed `item_completed` per tool run it made. Pick the canonical source per file from what the file itself contains (`usesEventEchoes`, `usesFileChangeItems`, `usesToolItems` in `codex.ts`), never both, and never by CLI version.
- **Names stored outside the transcript** (codex `session_index`, copilot `workspace.yaml`) must be stamped into the cache key via `auxStamp` in `indexer.ts`, or a rename never invalidates the entry.
- **Meta fields matter downstream:** `cwd` and `gitBranch` drive repo grouping (`repos.ts`, worktree-aware); `repoFullName`, when the provider states owner/repo itself (copilot does), wins over the git lookup; `id` is `${provider}:${nativeId}`; `sourcePath` is what `parse<P>Messages` receives later.

## Adding a fourth provider

`Provider` is a closed union and several provider lists are hand-maintained. Follow `references/new-provider.md`: the full touchpoint checklist, split by what typecheck catches and what it does not.

## Tests

Every parser change gets a vitest case in `tests/parsers.test.ts` (or `tests/indexer.test.ts` for grouping behavior): write a realistic fake session log into a tmpdir fixture with the `jsonl()` helper at the top of the file and run the real parser over it — including a malformed/truncated variant. No mocks.
