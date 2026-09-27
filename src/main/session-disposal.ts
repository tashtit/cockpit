import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionMeta } from '../shared/types'
import { execText } from './env'
import { CURSOR_IDE_DB } from './parsers/cursor'
import { OPENCODE_DB } from './parsers/opencode'
import { queryAll, splitSessionRef } from './parsers/sqlite'
import { readJson, sessionLogFiles } from './parsers/util'
import { replaceFile } from './replace-file'

/**
 * What deleting one session removes, as the agent that wrote it keeps it — cleanup's
 * one source for what a session occupies and how it goes, so what is measured and what
 * is removed can never drift apart.
 *
 * Most agents keep a session as files: one log (Claude, Codex), a folder (Copilot's
 * session state, a Cline or Roo Code task, a Cursor transcript beside its subagents),
 * or a database of its own (Antigravity). Two keep many sessions in one database —
 * Cursor's editor chats and opencode — and there only the session's rows go. An agent
 * that lists its sessions in an index file (Cline, Roo Code) has the entry taken out,
 * so its list does not name a session that is gone.
 *
 * Writing another app's store is the one risky part: a database another process holds
 * open is not written (`databases`, `openBy`) — that app would keep the rows in memory,
 * write them back, or read a session half gone. Cursor has to be quit to delete one of
 * its chats.
 */
export type Disposal = {
  /** Files and folders that are the session's own — removed whole */
  readonly paths: readonly string[]
  /** A database the session is rows in: the rows go, never the file */
  readonly rows?: { readonly db: string; readonly kind: 'cursor-chat' | 'opencode-session'; readonly id: string }
  /** The agent's own list of its sessions, which would otherwise still name this one */
  readonly index?: { readonly file: string; readonly id: string }
  /** Databases no other process may hold open while the session goes */
  readonly databases: readonly string[]
}

/**
 * Copilot keeps each session as a directory (`session-state/<id>/events.jsonl` plus
 * siblings); the same judgement serves measuring and removing.
 */
export function copilotSessionDir(sourcePath: string): string | null {
  const dir = dirname(sourcePath)
  return basename(sourcePath) === 'events.jsonl' && basename(dirname(dir)) === 'session-state' ? dir : null
}

const none = (paths: readonly string[]): Disposal => ({ paths: paths.map((p) => resolve(p)), databases: [] })

function fileNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}

/** opencode's older file store: a session's record, its turns, each turn's parts, its diff and to-dos. */
function opencodeFiles(file: string, id: string): string[] {
  const storage = dirname(dirname(dirname(file)))
  const turns = join(storage, 'message', id)
  const parts = fileNames(turns)
    .filter((n) => n.endsWith('.json'))
    .map((n) => join(storage, 'part', basename(n, '.json')))
  return [file, turns, ...parts, join(storage, 'session_diff', `${id}.json`), join(storage, 'todo', `${id}.json`)].filter(
    (p) => existsSync(p)
  )
}

export function disposalOf(meta: Pick<SessionMeta, 'provider' | 'nativeId' | 'sourcePath' | 'segments'>): Disposal {
  const file = meta.sourcePath
  switch (meta.provider) {
    case 'claude':
    case 'codex':
    case 'copilot':
      // every page of a thread kept across several files
      return none(sessionLogFiles(meta).map((f) => copilotSessionDir(f) ?? f))
    case 'gemini': {
      // a subagent's logs sit in a folder named for the session, beside its log
      const sub = join(dirname(file), meta.nativeId)
      return none(existsSync(sub) ? [file, sub] : [file])
    }
    case 'cursor': {
      const ref = splitSessionRef(file)
      if (ref && basename(ref.file) === CURSOR_IDE_DB) {
        const db = resolve(ref.file)
        return { paths: [], rows: { db, kind: 'cursor-chat', id: ref.id }, databases: [db] }
      }
      // `<id>/<id>.jsonl` with its subagents beside it: the folder is the transcript
      const dir = dirname(file)
      return none([basename(dir) === basename(file, '.jsonl') ? dir : file])
    }
    case 'cline':
      return {
        ...none([dirname(file)]),
        index: { file: resolve(dirname(dirname(dirname(file))), 'state', 'taskHistory.json'), id: meta.nativeId }
      }
    case 'roo':
      return { ...none([dirname(file)]), index: { file: resolve(dirname(dirname(file)), '_index.json'), id: meta.nativeId } }
    case 'opencode': {
      const ref = splitSessionRef(file)
      if (ref && basename(ref.file) === OPENCODE_DB) {
        const db = resolve(ref.file)
        return { paths: [], rows: { db, kind: 'opencode-session', id: ref.id }, databases: [db] }
      }
      return none(opencodeFiles(file, meta.nativeId))
    }
    case 'antigravity': {
      // the conversation's own database, its write-ahead files, and the markdown it
      // wrote for the person beside it
      const brain = join(dirname(dirname(file)), 'brain', meta.nativeId)
      const paths = [file, `${file}-wal`, `${file}-shm`, brain].filter((p) => p === file || existsSync(p))
      return { paths: paths.map((p) => resolve(p)), databases: [resolve(file)] }
    }
  }
}

/** A folder's walk is bounded — sizing runs for every stale session. */
const DIR_MAX_DEPTH = 8
const DIR_MAX_ENTRIES = 10_000

/**
 * What removing `dir` would free. Links are counted as themselves and never followed:
 * `rmSync` removes the link, not what it points at, and a link back up the tree would
 * otherwise be walked until the path grew too long. Past the bounds the walk stops,
 * and the answer is what it counted by then.
 */
function dirBytes(dir: string): number {
  let total = 0
  let entries = 0
  const walk = (at: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(at)
    } catch {
      return
    }
    for (const n of names) {
      if (++entries > DIR_MAX_ENTRIES) return
      try {
        const st = lstatSync(join(at, n))
        if (!st.isDirectory()) total += st.size
        else if (depth < DIR_MAX_DEPTH) walk(join(at, n), depth + 1)
      } catch {
        /* a file that vanished mid-scan simply doesn't count */
      }
    }
  }
  walk(dir, 0)
  return total
}

function pathBytes(p: string): number {
  try {
    const st = lstatSync(p)
    return st.isDirectory() ? dirBytes(p) : st.size
  } catch {
    return 0
  }
}

const CURSOR_CHAT_ROWS = 'FROM cursorDiskKV WHERE key = ? OR instr(key, ?) > 0'
const cursorChatParams = (id: string): string[] => [`composerData:${id}`, `:${id}:`]

/** What the session occupies: its files, or its rows' share of a database. */
export function disposalBytes(d: Disposal): number {
  let n = d.paths.reduce((sum, p) => sum + pathBytes(p), 0)
  if (d.rows?.kind === 'cursor-chat') {
    n += Number(queryAll(d.rows.db, `SELECT coalesce(sum(length(value)), 0) AS n ${CURSOR_CHAT_ROWS}`, ...cursorChatParams(d.rows.id))?.[0]?.['n'] ?? 0)
  } else if (d.rows?.kind === 'opencode-session') {
    const sum = (table: string): number =>
      Number(queryAll(d.rows!.db, `SELECT coalesce(sum(length(data)), 0) AS n FROM ${table} WHERE session_id = ?`, d.rows!.id)?.[0]?.['n'] ?? 0)
    n += sum('message') + sum('part')
  }
  return n
}

/** Every file a disposal touches — what cleanup checks lies inside a configured source. */
export function disposalFiles(d: Disposal): string[] {
  return [...d.paths, ...(d.rows ? [d.rows.db] : []), ...(d.index ? [d.index.file] : [])]
}

/** The databases among these another process holds open right now (`lsof`). */
export async function openBy(databases: readonly string[]): Promise<Set<string>> {
  const held = new Set<string>()
  for (const db of new Set(databases)) {
    const r = await execText('lsof', ['-t', '--', db], { timeoutMs: 5_000 })
    const pids = r.stdout.split('\n').map((l) => Number(l.trim())).filter((p) => p > 0 && p !== process.pid)
    if (pids.length > 0) held.add(db)
  }
  return held
}

function deleteRows(rows: NonNullable<Disposal['rows']>): void {
  const db = new DatabaseSync(rows.db)
  try {
    // another writer between our check and this write waits for us, or we for it
    db.exec('PRAGMA busy_timeout = 3000')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (rows.kind === 'cursor-chat') {
        db.prepare(`DELETE ${CURSOR_CHAT_ROWS}`).run(...cursorChatParams(rows.id))
      } else {
        // every table this version keeps per session, whatever it has added since
        const tables = db
          .prepare(
            "SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = 'session_id'"
          )
          .all() as Array<{ name: string }>
        for (const { name } of tables) {
          if (/^\w+$/.test(name)) db.prepare(`DELETE FROM "${name}" WHERE session_id = ?`).run(rows.id)
        }
        db.prepare('DELETE FROM session WHERE id = ?').run(rows.id)
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } finally {
    db.close()
  }
}

/** Take the session out of its agent's own list — best effort: the list is the agent's to repair. */
function dropFromIndex(index: NonNullable<Disposal['index']>): void {
  const doc = readJson(index.file, 32 * 1024 * 1024)
  const keep = (list: unknown[]): unknown[] => list.filter((e) => String((e as { id?: unknown })?.id) !== index.id)
  let next: unknown
  if (Array.isArray(doc)) next = keep(doc)
  else if (doc && typeof doc === 'object' && Array.isArray((doc as { entries?: unknown }).entries)) {
    next = { ...(doc as object), entries: keep((doc as { entries: unknown[] }).entries), updatedAt: Date.now() }
  } else return
  try {
    replaceFile(index.file, JSON.stringify(next))
  } catch (err) {
    console.error(`[cleanup] could not update ${index.file}:`, err)
  }
}

/**
 * Remove the session. The rows go first, in one transaction, so a database that
 * refuses the write leaves every file where it was; then the files; then the index.
 */
export function dispose(d: Disposal): void {
  if (d.rows) deleteRows(d.rows)
  for (const p of d.paths) {
    if (!existsSync(p) && /-(wal|shm)$/.test(p)) continue
    rmSync(p, { recursive: true, force: false })
  }
  if (d.index && existsSync(d.index.file)) dropFromIndex(d.index)
}

