import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProviderArchivedReader, type ProviderHidden } from '../src/main/provider-archived'
import type { SourceDir } from '../src/shared/types'

/** Nothing remembered from an earlier sweep. */
const NONE: ProviderHidden = { hidden: new Set(), deleted: new Set() }
/** Remembered as hidden (archived, not deleted) by an earlier sweep. */
const knew = (...ids: string[]): ProviderHidden => ({ hidden: new Set(ids), deleted: new Set() })

/**
 * The sweep runs before every rescan, so what it remembers between sweeps is as much
 * a contract as what it reports: an unchanged desktop record must not be re-read and
 * an unchanged copilot db must not be opened at all. Both are asserted here the only
 * way that proves it from outside — by making the file unreadable while leaving its
 * stamp alone, so only a cached answer can still be right.
 */

const root = mkdtempSync(join(tmpdir(), 'cockpit-archived-'))
const store = join(root, 'claude-store')
const claudeHome = join(root, 'claude-home')
const copilotHome = join(root, 'copilot-home')
const db = join(copilotHome, 'data.db')

const sources: SourceDir[] = [
  { path: claudeHome, provider: 'claude', label: 'c' },
  { path: copilotHome, provider: 'copilot', label: 'p' }
]

function hasSqlite3(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A desktop record of a fixed byte length, so a rewrite can keep the same stamp. */
function record(cliSessionId: string, isArchived: boolean): string {
  const bare = JSON.stringify({ cliSessionId, isArchived, pad: '' })
  return JSON.stringify({ cliSessionId, isArchived, pad: 'x'.repeat(220 - bare.length) })
}

function writeRecord(name: string, cliSessionId: string, isArchived: boolean): string {
  const dir = join(store, 'install-1', 'workspace-1')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`)
  writeFileSync(file, record(cliSessionId, isArchived))
  return file
}

function writeDb(rows: ReadonlyArray<{ id: string; archived: boolean }>): void {
  mkdirSync(copilotHome, { recursive: true })
  rmSync(db, { force: true })
  execFileSync('sqlite3', [db], {
    input: [
      'CREATE TABLE sessions (id TEXT PRIMARY KEY, archived_at TEXT);',
      ...rows.map((r) => `INSERT INTO sessions VALUES ('${r.id}', ${r.archived ? "'2026-01-01'" : 'NULL'});`)
    ].join('\n')
  })
}

/**
 * Rewrite a file's bytes leaving its stamp exactly as it was. The times go back as
 * numbers: `utimesSync` takes a Date only to millisecond precision, and APFS keeps
 * more than that, so a Date round-trip would quietly change the stamp.
 */
function rewriteKeepingStamp(file: string, bytes: string): void {
  const st = statSync(file)
  writeFileSync(file, bytes)
  utimesSync(file, st.atimeMs / 1000, st.mtimeMs / 1000)
  expect(statSync(file).mtimeMs).toBe(st.mtimeMs)
}

/** Replace a file's bytes with junk of the same length, keeping its stamp. */
function corruptInPlace(file: string): void {
  rewriteKeepingStamp(file, 'X'.repeat(statSync(file).size))
}

beforeAll(() => {
  mkdirSync(claudeHome, { recursive: true })
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ProviderArchivedReader', () => {
  it('reports what each provider archived, and nothing else', async () => {
    writeRecord('a', 'claude-archived', true)
    writeRecord('b', 'claude-live', false)
    if (hasSqlite3()) writeDb([{ id: 'cop-archived', archived: true }, { id: 'cop-live', archived: false }])
    const { hidden: ids } = await new ProviderArchivedReader(store).list(sources, NONE)
    expect(ids.has('claude:claude-archived')).toBe(true)
    expect(ids.has('claude:claude-live')).toBe(false)
    if (hasSqlite3()) {
      expect(ids.has('copilot:cop-archived')).toBe(true)
      expect(ids.has('copilot:cop-live')).toBe(false)
    }
  })

  it('does not re-read a record whose mtime and size are unchanged', async () => {
    const file = writeRecord('c', 'claude-cached', true)
    const reader = new ProviderArchivedReader(store)
    expect([...(await reader.list(sources, NONE)).hidden]).toContain('claude:claude-cached')

    // the same stamp, different bytes: only a remembered verdict can still be right
    const mtimeMs = statSync(file).mtimeMs
    rewriteKeepingStamp(file, record('claude-cached', false))
    expect([...(await reader.list(sources, NONE)).hidden]).toContain('claude:claude-cached')

    // a real write moves the mtime, and the new answer lands
    utimesSync(file, mtimeMs / 1000, (mtimeMs + 5000) / 1000)
    expect([...(await reader.list(sources, NONE)).hidden]).not.toContain('claude:claude-cached')
  })

  it('forgets a record the store no longer has', async () => {
    const file = writeRecord('d', 'claude-gone', true)
    const reader = new ProviderArchivedReader(store)
    expect([...(await reader.list(sources, NONE)).hidden]).toContain('claude:claude-gone')
    rmSync(file)
    expect([...(await reader.list(sources, NONE)).hidden]).not.toContain('claude:claude-gone')
  })

  it.runIf(hasSqlite3())('does not open an unchanged copilot db', async () => {
    writeDb([{ id: 'cop-cached', archived: true }])
    const reader = new ProviderArchivedReader(null)
    expect([...(await reader.list(sources, NONE)).hidden]).toContain('copilot:cop-cached')

    // unreadable as a database, same stamp: a sweep that opened it would fail and
    // fall back to `prev` (empty here), so the id can only come from memory
    corruptInPlace(db)
    expect([...(await reader.list(sources, NONE)).hidden]).toContain('copilot:cop-cached')
  })

  it.runIf(hasSqlite3())('re-reads when only the WAL sidecar moved', async () => {
    writeDb([{ id: 'cop-wal', archived: true }])
    const reader = new ProviderArchivedReader(null)
    expect([...(await reader.list(sources, NONE)).hidden]).toContain('copilot:cop-wal')

    // sqlite can commit into -wal without touching data.db: the sweep must notice.
    // With the db corrupted, noticing means the read fails and `prev` is what is kept.
    corruptInPlace(db)
    writeFileSync(`${db}-wal`, 'a fresh write-ahead log')
    const { hidden: ids } = await reader.list(sources, knew('copilot:from-prev'))
    expect([...ids]).toContain('copilot:from-prev')
    expect([...ids]).not.toContain('copilot:cop-wal')
    rmSync(`${db}-wal`, { force: true })
  })

  it.runIf(hasSqlite3())('hides a project chat archived or deleted as its workspace', async () => {
    // the app's current layout, trimmed to the columns the read uses
    const home = join(root, 'copilot-app')
    mkdirSync(home, { recursive: true })
    execFileSync('sqlite3', [join(home, 'data.db')], {
      input: `
        CREATE TABLE sessions (id TEXT PRIMARY KEY, session_type TEXT NOT NULL, archived_at TEXT);
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, session_id TEXT, archived_at TEXT);
        CREATE TABLE workspace_session_aliases (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
        CREATE TABLE workspace_side_chats (workspace_id TEXT NOT NULL, session_id TEXT PRIMARY KEY);
        CREATE TABLE session_side_chats (parent_session_id TEXT NOT NULL, session_id TEXT PRIMARY KEY);
        INSERT INTO sessions VALUES
          ('general-archived', 'general_chat', '2026-09-23'), ('general-live', 'general_chat', NULL),
          ('project-archived', 'project', NULL), ('project-earlier', 'project', NULL),
          ('project-live', 'project', NULL), ('project-deleted', 'project', NULL),
          ('side-archived-ws', 'side_chat', NULL), ('side-live-ws', 'side_chat', NULL),
          ('side-archived-chat', 'side_chat', NULL), ('cli', 'cli_session', NULL);
        INSERT INTO workspaces VALUES ('ws-a', 'project-archived', '2026-09-25'), ('ws-l', 'project-live', NULL);
        INSERT INTO workspace_session_aliases VALUES
          ('project-archived', 'ws-a'), ('project-earlier', 'ws-a'), ('project-live', 'ws-l');
        INSERT INTO workspace_side_chats VALUES ('ws-a', 'side-archived-ws'), ('ws-l', 'side-live-ws');
        INSERT INTO session_side_chats VALUES ('general-archived', 'side-archived-chat');
      `
    })
    const { hidden: ids, deleted } = await new ProviderArchivedReader(null).list(
      [{ path: home, provider: 'copilot', label: 'app' }],
      NONE
    )
    // archived is finished work (the profile counts it); deleted was thrown away
    expect([...deleted]).toEqual(['copilot:project-deleted'])
    expect([...ids].sort()).toEqual(
      [
        'general-archived',
        'project-archived',
        // its workspace row is gone: deleting a workspace keeps the session row
        'project-deleted',
        'project-earlier',
        'side-archived-chat',
        'side-archived-ws'
      ].map((id) => `copilot:${id}`)
    )
  })

  it.runIf(hasSqlite3())('reads what a db from an older app can say, and no more', async () => {
    // workspaces but no aliases table: an archived workspace still counts, but a
    // workspace-less project chat can't be told deleted without knowing its aliases
    const home = join(root, 'copilot-older')
    mkdirSync(home, { recursive: true })
    execFileSync('sqlite3', [join(home, 'data.db')], {
      input: `
        CREATE TABLE sessions (id TEXT PRIMARY KEY, session_type TEXT NOT NULL, archived_at TEXT);
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, session_id TEXT, archived_at TEXT);
        INSERT INTO sessions VALUES ('in-archived-ws', 'project', NULL), ('no-ws', 'project', NULL);
        INSERT INTO workspaces VALUES ('ws', 'in-archived-ws', '2026-09-25');
      `
    })
    const { hidden: ids } = await new ProviderArchivedReader(null).list(
      [{ path: home, provider: 'copilot', label: 'older' }],
      knew('copilot:from-prev')
    )
    // a read that worked: the answer is the db's, not the remembered set
    expect([...ids]).toEqual(['copilot:in-archived-ws'])
  })

  it.runIf(hasSqlite3())('tells a session the app deleted from one it archived', async () => {
    // deletion drops the db row and leaves the transcript: a row-less dir inside the era
    // the db covers was deleted; an archived row is finished work the profile still counts
    const home = join(root, 'copilot-deleting')
    const log = (id: string, day: number): void => {
      const dir = join(home, 'session-state', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'events.jsonl'), '{}\n')
      const t = new Date(2026, 8, day).getTime() / 1000
      utimesSync(join(dir, 'events.jsonl'), t, t)
    }
    mkdirSync(home, { recursive: true })
    execFileSync('sqlite3', [join(home, 'data.db')], {
      input: `
        CREATE TABLE sessions (id TEXT PRIMARY KEY, archived_at TEXT);
        INSERT INTO sessions VALUES ('first', NULL), ('shelved', '2026-09-20'), ('last', NULL);
      `
    })
    log('first', 1)
    log('shelved', 10)
    log('last', 20)
    log('dropped', 12) // no row, and inside the db's era: deleted
    log('older', 1) // no row, but the db cannot speak for the day before its first session
    utimesSync(join(home, 'session-state', 'older', 'events.jsonl'), 0, 0)
    const got = await new ProviderArchivedReader(null).list([{ path: home, provider: 'copilot', label: 'd' }], NONE)
    expect([...got.hidden].sort()).toEqual(['copilot:dropped', 'copilot:shelved'])
    expect([...got.deleted]).toEqual(['copilot:dropped'])
  })

  it.runIf(hasSqlite3())('keeps what it knew when the db cannot be read at all', async () => {
    writeDb([{ id: 'cop-x', archived: true }])
    corruptInPlace(db)
    const prev = { hidden: new Set(['copilot:remembered', 'copilot:gone']), deleted: new Set(['copilot:gone']) }
    const { hidden: ids, deleted } = await new ProviderArchivedReader(null).list(sources, prev)
    expect([...ids]).toContain('copilot:remembered')
    // which of them were deletions is kept too, or the profile would count a thrown-away session
    expect([...deleted]).toEqual(['copilot:gone'])
  })
})
