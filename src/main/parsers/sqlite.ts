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

/** How a database stands on disk, looked at once (see SnapshotPass). */
type DbLook = {
  /** its own file's mtime and size and its write-ahead log's; null when it is not there */
  readonly stamp: string | null
  /** the newest write to either */
  readonly mtimeMs: number
}

/**
 * A database written through a write-ahead log changes the `-wal` file, not itself,
 * until a checkpoint — so "has it changed" is both files' stamps.
 */
function lookAt(file: string): DbLook {
  const stat = (f: string): { readonly mtimeMs: number; readonly size: number } | null => {
    try {
      return statSync(f)
    } catch {
      return null
    }
  }
  const main = stat(file)
  const wal = stat(`${file}-wal`)
  return {
    stamp: main ? `${main.mtimeMs}:${main.size}|${wal ? `${wal.mtimeMs}:${wal.size}` : '-'}` : null,
    mtimeMs: Math.max(main?.mtimeMs ?? 0, wal?.mtimeMs ?? 0)
  }
}

/**
 * One indexer pass over the databases it reads — a rescan, or a batch of changed
 * sessions re-judged. Cursor keeps every chat in one database it writes many times a
 * second, and a pass that re-judges its three hundred chats asks about that database
 * three hundred times: checked afresh each time, every ask saw a new stamp and re-read
 * the whole table (seconds of the main thread, for one pass). Inside a pass each
 * database is looked at once — its stamp pinned at the first look, before anything of
 * it is read — so a snapshot is read at most once per pass, and whatever the pass
 * records it records against a stamp no newer than what it read: a write the pass did
 * not see leaves the stamp moved, and the next look reads again.
 *
 * A pass that spans awaits (the rescan) is installed only for its synchronous stretches
 * (`inPass`), so work that runs between them — the watcher's own re-judging — is never
 * served another pass's pins. What the pass could not vouch for once it ends — a
 * database written while it read, or a read that failed — is `unsettled()`, for the
 * indexer to look at again.
 */
export class SnapshotPass {
  private readonly looks = new Map<string, DbLook>()
  /** databases a snapshot answered for in this pass */
  private readonly served = new Set<string>()
  /** databases a read of which failed in this pass — not tried again in it */
  private readonly failures = new Set<string>()

  look(file: string): DbLook {
    let look = this.looks.get(file)
    if (!look) {
      look = lookAt(file)
      this.looks.set(file, look)
    }
    return look
  }

  serve(file: string, failed: boolean): void {
    this.served.add(file)
    if (failed) this.failures.add(file)
  }

  failed(file: string): boolean {
    return this.failures.has(file)
  }

  /**
   * The databases whose snapshots this pass served and cannot vouch for now: `failed`,
   * a read failed and the last good answer stood in; `moved`, written since the pass
   * first looked. `settled` are the rest — read, and still as read.
   */
  unsettled(): { readonly failed: ReadonlySet<string>; readonly moved: ReadonlySet<string>; readonly settled: ReadonlySet<string> } {
    const moved = new Set<string>()
    const settled = new Set<string>()
    for (const file of this.served) {
      if (this.failures.has(file)) continue
      if (lookAt(file).stamp !== this.looks.get(file)?.stamp) moved.add(file)
      else settled.add(file)
    }
    return { failed: new Set(this.failures), moved, settled }
  }
}

/** The pass the code running right now belongs to, if any — set only by inPass. */
let current: SnapshotPass | null = null

/** Run `fn` as part of `pass`. Synchronous only: a pass never outlives the stretch it is installed for. */
export function inPass<T>(pass: SnapshotPass, fn: () => T): T {
  const outer = current
  current = pass
  try {
    return fn()
  } finally {
    current = outer
  }
}

function look(file: string): DbLook {
  return current ? current.look(file) : lookAt(file)
}

/** A database's stamp — itself and its write-ahead log — or null when it is not there. Pinned within a pass. */
export function dbStamp(file: string): string | null {
  return look(file).stamp
}

/** The newest write to a database, counting its write-ahead log. Pinned within a pass. */
export function dbMtime(file: string): number {
  return look(file).mtimeMs
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
 * of the hundred is then re-judged — from this, not from a hundred queries. Within a
 * pass the stamp is the pass's (see SnapshotPass), so the query runs at most once in it
 * however often the database is written meanwhile.
 *
 * A read that fails is not an answer. The app that owns the database is writing to it,
 * or a read-only open finds its write-ahead index wanting a recovery only a writer may
 * run; `read` returns null, the last good answer stands, and the next call reads again
 * (the next pass, inside one). Taken as "no sessions", it dropped every session in the
 * database from the index until the next good read put them back — a session flickering
 * in and out of the sidebar, and out of search, every few seconds while its agent was at
 * work. A database that is not there at all is an answer: nothing in it (`empty`).
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
    if (hit && hit.stamp === stamp) {
      current?.serve(file, false)
      return hit.value
    }
    const value = current?.failed(file) ? null : read(file)
    current?.serve(file, value === null)
    if (value === null) return hit?.value ?? empty
    cache.set(file, { stamp, value })
    return value
  }
}
