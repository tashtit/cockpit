import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isRegularFile } from './util'

/**
 * Reading the SQLite stores some agents keep instead of log files — Cursor's editor
 * state, opencode's database, Antigravity's one database per conversation. Another app
 * owns each of them and is often writing to it: every open is read-only, every query is
 * failure-tolerant (a table this code expects may not exist in the version installed),
 * and nothing is held open between reads.
 */

/** Rows of one query, or null when the database or the table cannot be read. */
export function queryAll(file: string, sql: string, ...params: Array<string | number>): Record<string, unknown>[] | null {
  if (!isRegularFile(file)) return null
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    return db.prepare(sql).all(...params) as Record<string, unknown>[]
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * A database written through a write-ahead log changes the `-wal` file, not itself,
 * until a checkpoint — so "has it changed" is both files' stamps.
 */
export function dbStamp(file: string): string | null {
  const stamp = (f: string): string => {
    try {
      const st = statSync(f)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return '-'
    }
  }
  const main = stamp(file)
  return main === '-' ? null : `${main}|${stamp(`${file}-wal`)}`
}

/** The newest write to a database, counting its write-ahead log. */
export function dbMtime(file: string): number {
  let t = 0
  for (const f of [file, `${file}-wal`]) {
    try {
      t = Math.max(t, statSync(f).mtimeMs)
    } catch {
      /* no log beside it */
    }
  }
  return t
}

/**
 * One session among many in a shared database is named `<database>#<session id>`: the
 * indexer keys everything by path, and this keeps the path pointing at the file that
 * holds the session. The id never contains `#` for the stores this is used for.
 */
export function sessionRef(file: string, id: string): string {
  return `${file}#${id}`
}

export function splitSessionRef(ref: string): { readonly file: string; readonly id: string } | null {
  const at = ref.lastIndexOf('#')
  if (at <= 0 || at === ref.length - 1) return null
  return { file: ref.slice(0, at), id: ref.slice(at + 1) }
}

/**
 * What one query over a shared database said, kept until the database changes: a
 * database holding a hundred sessions changes on every write to any of them, and each
 * of the hundred is then re-judged — from this, not from a hundred queries.
 *
 * A read that fails is not an answer. The app that owns the database is writing to it,
 * or a read-only open finds its write-ahead index wanting a recovery only a writer may
 * run; `read` returns null, the last good answer stands, and the next call reads again.
 * Taken as "no sessions", it dropped every session in the database from the index until
 * the next good read put them back — a session flickering in and out of the sidebar, and
 * out of search, every few seconds while its agent was at work. A database that is not
 * there at all is an answer: nothing in it (`empty`).
 */
export function snapshotCache<T>(read: (file: string) => T | null, empty: T): (file: string) => T {
  const cache = new Map<string, { readonly stamp: string; readonly value: T }>()
  return (file) => {
    const stamp = dbStamp(file)
    if (stamp === null) {
      cache.delete(file)
      return empty
    }
    const hit = cache.get(file)
    if (hit && hit.stamp === stamp) return hit.value
    const value = read(file)
    if (value === null) return hit?.value ?? empty
    cache.set(file, { stamp, value })
    return value
  }
}
