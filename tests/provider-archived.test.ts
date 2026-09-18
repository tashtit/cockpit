import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProviderArchivedReader } from '../src/main/provider-archived'
import type { SourceDir } from '../src/shared/types'

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
    const ids = await new ProviderArchivedReader(store).list(sources, new Set())
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
    expect([...(await reader.list(sources, new Set()))]).toContain('claude:claude-cached')

    // the same stamp, different bytes: only a remembered verdict can still be right
    const mtimeMs = statSync(file).mtimeMs
    rewriteKeepingStamp(file, record('claude-cached', false))
    expect([...(await reader.list(sources, new Set()))]).toContain('claude:claude-cached')

    // a real write moves the mtime, and the new answer lands
    utimesSync(file, mtimeMs / 1000, (mtimeMs + 5000) / 1000)
    expect([...(await reader.list(sources, new Set()))]).not.toContain('claude:claude-cached')
  })

  it('forgets a record the store no longer has', async () => {
    const file = writeRecord('d', 'claude-gone', true)
    const reader = new ProviderArchivedReader(store)
    expect([...(await reader.list(sources, new Set()))]).toContain('claude:claude-gone')
    rmSync(file)
    expect([...(await reader.list(sources, new Set()))]).not.toContain('claude:claude-gone')
  })

  it.runIf(hasSqlite3())('does not open an unchanged copilot db', async () => {
    writeDb([{ id: 'cop-cached', archived: true }])
    const reader = new ProviderArchivedReader(null)
    expect([...(await reader.list(sources, new Set()))]).toContain('copilot:cop-cached')

    // unreadable as a database, same stamp: a sweep that opened it would fail and
    // fall back to `prev` (empty here), so the id can only come from memory
    corruptInPlace(db)
    expect([...(await reader.list(sources, new Set()))]).toContain('copilot:cop-cached')
  })

  it.runIf(hasSqlite3())('re-reads when only the WAL sidecar moved', async () => {
    writeDb([{ id: 'cop-wal', archived: true }])
    const reader = new ProviderArchivedReader(null)
    expect([...(await reader.list(sources, new Set()))]).toContain('copilot:cop-wal')

    // sqlite can commit into -wal without touching data.db: the sweep must notice.
    // With the db corrupted, noticing means the read fails and `prev` is what is kept.
    corruptInPlace(db)
    writeFileSync(`${db}-wal`, 'a fresh write-ahead log')
    const ids = await reader.list(sources, new Set(['copilot:from-prev']))
    expect([...ids]).toContain('copilot:from-prev')
    expect([...ids]).not.toContain('copilot:cop-wal')
    rmSync(`${db}-wal`, { force: true })
  })

  it.runIf(hasSqlite3())('keeps what it knew when the db cannot be read at all', async () => {
    writeDb([{ id: 'cop-x', archived: true }])
    corruptInPlace(db)
    const ids = await new ProviderArchivedReader(null).list(sources, new Set(['copilot:remembered']))
    expect([...ids]).toContain('copilot:remembered')
  })
})
