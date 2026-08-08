---
name: add-session-parser
description: Add or fix a provider session-log parser (Claude, Codex, Copilot, or a new agent). Use when sessions are missing or wrong in the sidebar, a provider changed its log format, or when adding support for a new provider's session files.
---

# Session parsers

One module per provider in `src/main/parsers/`, wired into `src/main/indexer.ts` via three per-provider maps. Each parser exports:

- `list<P>SessionRoots(sourceDir)` — the ONLY subdirectories the indexer walks and watches (e.g. claude: `projects/`). Never return the whole config dir: provider homes contain `pkg/`, `repos/`, logs, and SQLite files that must not be scanned.
- `list<P>Sessions(sourceDir, label)` / `parse<P>Meta(file, label)` — cheap metadata scan producing `SessionMeta` (`src/shared/types.ts`).
- `parse<P>Messages(sourcePath)` — full transcript parse into `SessionMessage[]`, on demand only (when a session is opened).

## Invariants

- **Bounded reads.** Meta parsing reads ≤256KB per file via `readHead`; transcripts read a ≤4MB tail via `readJsonlTail`. A 58MB log must never be fully parsed. Use the helpers in `parsers/util.ts` (`readHead`, `readTail`, `parseJsonlText`, `contentToText`, `capText`, `toMs`, `truncate`, `walkFiles`).
- **Failure-tolerant.** Formats are provider-internal and drift between releases. Skip unreadable files/lines (return `null` / skip), never throw out of a parser — one corrupt file must not kill the scan. Files may be mid-write.
- **Format drift is expected.** Handle old and new shapes side by side (codex handles both `msg.type` and `thread.started`/`item.completed` events); don't remove support for an older shape when adding a newer one.
- **Meta fields matter downstream:** `cwd` and `gitBranch` drive repo grouping (`repos.ts`, worktree-aware); `id` is `${provider}:${nativeId}`; `sourcePath` is what `parse<P>Messages` receives later.

## Tests

Every parser change gets a vitest case in `tests/parsers.test.ts` (or `tests/indexer.test.ts` for grouping behavior): write a realistic fake session log into a tmpdir fixture and run the real parser over it — including a malformed/truncated variant. No mocks.
