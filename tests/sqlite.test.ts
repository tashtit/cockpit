import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { SnapshotPass, dbStamp, inPass, queryAll, queryEach, snapshotCache } from '../src/main/parsers/sqlite'
import { listCursorSessions } from '../src/main/parsers/cursor'
import { writeCursorChats } from '../scripts/ui-tour/store-fixtures.mts'

const root = mkdtempSync(join(tmpdir(), 'cockpit-sqlite-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const at = Date.parse('2026-09-01T09:00:00Z')

function chat(id: string, text: string) {
  return { id, name: text, cwd: '/x', created: at, updated: at, bubbles: [{ type: 1 as const, at, text }] }
}

/** What Cursor does between two of the indexer's asks: another chat, committed. */
function addChat(db: string, id: string): void {
  const w = new DatabaseSync(db)
  try {
    w.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      `composerData:${id}`,
      JSON.stringify({ composerId: id, name: id, createdAt: at, lastUpdatedAt: at, fullConversationHeadersOnly: [{ bubbleId: 'b', type: 1 }] })
    )
  } finally {
    w.close()
  }
}

/** A snapshot of a database's row count, and how many times it was actually read. */
function countingSnapshot(): { readonly rows: (file: string) => number; readonly reads: () => number } {
  let reads = 0
  const rows = snapshotCache((file: string): number | null => {
    reads++
    const n = queryAll(file, 'SELECT count(*) AS n FROM cursorDiskKV')?.[0]?.['n']
    return typeof n === 'number' ? n : null
  }, 0)
  return { rows, reads: () => reads }
}

describe('queryEach', () => {
  it('steps through rows until told to stop, and says when the database cannot be read', () => {
    const db = join(root, 'each', 'state.vscdb')
    writeCursorChats(db, [chat('c1', 'one'), chat('c2', 'two'), chat('c3', 'three')])
    const seen: string[] = []
    const sql = `SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' ORDER BY key`
    expect(queryEach(db, { sql }, (r) => (seen.push(String(r['key'])), seen.length < 2))).toBe(true)
    expect(seen).toEqual(['composerData:c1', 'composerData:c2'])
    const all: unknown[] = []
    expect(queryEach(db, { sql: 'SELECT key FROM cursorDiskKV WHERE key = ?', params: ['composerData:c3'] }, (r) => (all.push(r['key']), true))).toBe(true)
    expect(all).toEqual(['composerData:c3'])
    expect(queryEach(db, { sql: 'SELECT * FROM no_such_table' }, () => true)).toBe(false)
    expect(queryEach(join(root, 'each', 'missing.db'), { sql: 'SELECT 1' }, () => true)).toBe(false)
  })
})

describe('a pass over a database its app keeps writing', () => {
  it('reads it once, however often it is written meanwhile, and says it moved', () => {
    const db = join(root, 'once', 'state.vscdb')
    writeCursorChats(db, [chat('c1', 'one')])
    const snap = countingSnapshot()
    const pass = new SnapshotPass()
    const first = inPass(pass, () => snap.rows(db))
    const stamp = inPass(pass, () => dbStamp(db))
    for (let i = 0; i < 5; i++) {
      addChat(db, `new-${i}`)
      // every ask in the pass is the same answer, from the one read
      expect(inPass(pass, () => snap.rows(db))).toBe(first)
      expect(inPass(pass, () => dbStamp(db))).toBe(stamp)
    }
    expect(snap.reads()).toBe(1)
    expect([...pass.unsettled().moved]).toEqual([db])
    // outside the pass the database is as it stands
    expect(snap.rows(db)).toBe(first + 5)
    expect(snap.reads()).toBe(2)
    expect(dbStamp(db)).not.toBe(stamp)
  })

  it('pins what the parsers read too: a chat committed mid-pass waits for the next one', () => {
    const storage = join(root, 'parser', 'User', 'globalStorage')
    const db = join(storage, 'state.vscdb')
    writeCursorChats(db, [chat('c1', 'one')])
    const pass = new SnapshotPass()
    const ids = (): string[] => listCursorSessions(storage, 'cursor-ide').map((m) => m.nativeId).sort()
    expect(inPass(pass, ids)).toEqual(['c1'])
    addChat(db, 'c2')
    expect(inPass(pass, ids)).toEqual(['c1'])
    expect(pass.unsettled().moved.has(db)).toBe(true)
    expect(ids()).toEqual(['c1', 'c2'])
    // a pass that read it as it stands has nothing to look at again
    const next = new SnapshotPass()
    inPass(next, ids)
    expect(next.unsettled()).toMatchObject({ moved: new Set(), failed: new Set(), settled: new Set([db]) })
  })

  it('tries a read that failed only once in a pass, the last good answer standing in', () => {
    const db = join(root, 'held', 'state.vscdb')
    writeCursorChats(db, [chat('c1', 'one')])
    const snap = countingSnapshot()
    const good = snap.rows(db)
    const writer = new DatabaseSync(db)
    try {
      // a write that keeps the whole file to itself: every other connection is refused
      writer.exec('PRAGMA locking_mode = EXCLUSIVE')
      writer.exec(`INSERT INTO cursorDiskKV (key, value) VALUES ('held', '{}')`)
      const pass = new SnapshotPass()
      for (let i = 0; i < 3; i++) expect(inPass(pass, () => snap.rows(db))).toBe(good)
      expect(snap.reads()).toBe(2)
      expect(pass.unsettled()).toMatchObject({ failed: new Set([db]), moved: new Set() })
    } finally {
      writer.close()
    }
    expect(snap.rows(db)).toBe(good + 1)
  })
})
