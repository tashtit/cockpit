import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SourceDir } from '../shared/types'
import { execText } from './env'

/**
 * Sessions archived — or deleted — inside the provider's own app must never show up in
 * Cockpit: not as active, not under Cockpit's own Archived toggle. The two are told
 * apart all the same (`ProviderHidden`): the tree hides both, but an archived session
 * is finished work the profile still counts, while a deleted one was thrown away.
 *
 * Where each provider keeps that state:
 * - copilot: data.db is the app's source of truth, and the transcript under
 *   session-state/ is left untouched either way, so the state has to be read from the db.
 *   - archived: a general chat's own `sessions` row gets an `archived_at` timestamp; a
 *     project chat is archived as its *workspace* — the `workspaces` row gets the
 *     timestamp and the session row keeps none. See COPILOT_HIDDEN_WHEN.
 *   - deleted: a session row is removed outright (the db has a session_deletion_intents
 *     table and no deleted_at column), leaving session-state/<id>/events.jsonl behind.
 *     A row-less dir is treated as deleted only when its events.jsonl mtime falls
 *     inside the era the db demonstrably covers — see copilotDeletedIds. Deleting a
 *     project chat's workspace removes the workspace row and keeps the session's.
 * - codex: archiving physically moves the rollout file to <home>/archived_sessions/,
 *   which the indexer never walks — nothing extra to read.
 * - claude: the CLI persists nothing, but the Claude desktop app keeps one JSON
 *   record per session under ~/Library/Application Support/Claude/
 *   claude-code-sessions/<install>/<workspace>/<id>.json with an `isArchived`
 *   flag and the `cliSessionId` the indexer derives session ids from.
 */
export function defaultClaudeStoreDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
}

/** Desktop-app records are small; anything bigger is not a session record. */
const MAX_CLAUDE_RECORD_BYTES = 256 * 1024
/** Keep this many record reads in flight, never all of them: a store holds thousands. */
const RECORD_READERS = 32

/**
 * What the providers' own apps have hidden, by session id. `hidden` is everything the
 * tree must not show; `deleted` is the part of it that was thrown away rather than
 * archived — always a subset of `hidden`.
 */
export type ProviderHidden = {
  readonly hidden: ReadonlySet<string>
  readonly deleted: ReadonlySet<string>
}

type CopilotRow = {
  readonly id: string
  /** Archived or deleted in the app, by any of COPILOT_HIDDEN_WHEN. */
  readonly hidden: boolean
  /** Deleted, by a `deleted` clause — the rest of `hidden` is archived */
  readonly deleted: boolean
}

/**
 * Every way data.db says a session `s` is gone from the Copilot app, each with the
 * `table.column`s it reads and whether it means archived or deleted. The app has grown
 * these in stages (workspaces and side chats are newer than `sessions.archived_at`), so
 * a clause the db has no columns for is left out rather than failing the read: that db
 * simply can't say that thing yet.
 */
const COPILOT_HIDDEN_WHEN: readonly {
  readonly kind: 'archived' | 'deleted'
  readonly reads: readonly string[]
  readonly sql: string
}[] = [
  // a general chat, archived on its own row
  { kind: 'archived', reads: ['sessions.archived_at'], sql: 's.archived_at IS NOT NULL' },
  // a project chat is archived as its workspace — the session row keeps no timestamp
  {
    kind: 'archived',
    reads: ['workspaces.session_id', 'workspaces.archived_at'],
    sql: 'EXISTS (SELECT 1 FROM workspaces w WHERE w.session_id = s.id AND w.archived_at IS NOT NULL)'
  },
  // ...and so is a session the workspace ran before its current one
  {
    kind: 'archived',
    reads: [
      'workspace_session_aliases.session_id',
      'workspace_session_aliases.workspace_id',
      'workspaces.id',
      'workspaces.archived_at'
    ],
    sql:
      'EXISTS (SELECT 1 FROM workspace_session_aliases a JOIN workspaces w ON w.id = a.workspace_id' +
      ' WHERE a.session_id = s.id AND w.archived_at IS NOT NULL)'
  },
  // a side chat goes with what it was opened from
  {
    kind: 'archived',
    reads: [
      'workspace_side_chats.session_id',
      'workspace_side_chats.workspace_id',
      'workspaces.id',
      'workspaces.archived_at'
    ],
    sql:
      'EXISTS (SELECT 1 FROM workspace_side_chats c JOIN workspaces w ON w.id = c.workspace_id' +
      ' WHERE c.session_id = s.id AND w.archived_at IS NOT NULL)'
  },
  {
    kind: 'archived',
    reads: ['session_side_chats.session_id', 'session_side_chats.parent_session_id', 'sessions.archived_at'],
    sql:
      'EXISTS (SELECT 1 FROM session_side_chats c JOIN sessions p ON p.id = c.parent_session_id' +
      ' WHERE c.session_id = s.id AND p.archived_at IS NOT NULL)'
  },
  // A project chat always lives in a workspace, and deleting the workspace drops its
  // row (and its aliases) but keeps the session's: one with neither was deleted.
  {
    kind: 'deleted',
    reads: ['sessions.session_type', 'workspaces.session_id', 'workspace_session_aliases.session_id'],
    sql:
      "s.session_type = 'project'" +
      ' AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.session_id = s.id)' +
      ' AND NOT EXISTS (SELECT 1 FROM workspace_session_aliases a WHERE a.session_id = s.id)'
  }
]

const COPILOT_TABLES = [...new Set(COPILOT_HIDDEN_WHEN.flatMap((c) => c.reads.map((r) => r.split('.')[0])))]

/** The one statement that reads every session: `id|hidden|deleted`, flags 0 or 1. */
function copilotSessionsSql(columns: ReadonlySet<string>): string {
  const clauses = COPILOT_HIDDEN_WHEN.filter((c) => c.reads.every((r) => columns.has(r)))
  const any = (cs: typeof clauses): string => (cs.length ? cs.map((c) => `(${c.sql})`).join(' OR ') : '0')
  return `SELECT s.id, ${any(clauses)}, ${any(clauses.filter((c) => c.kind === 'deleted'))} FROM sessions s`
}

/** What the last read of one desktop record said, and the stamp it said it about. */
type RecordVerdict = {
  readonly mtimeMs: number
  readonly size: number
  /** The archived session's cli id, or null for "not archived / not readable". */
  readonly archivedId: string | null
}

/**
 * Reads each provider's own archived state, remembering what it read.
 *
 * The indexer sweeps before every rescan — which fires on every new session file —
 * and a sweep with nothing remembered costs two `sqlite3` spawns plus a full re-read and
 * re-parse of every desktop record (~100ms at a few thousand of them). Neither input
 * changes often, and both say when they changed: records carry an mtime and a size,
 * and the copilot db carries them too, across its WAL sidecars. So a sweep re-reads
 * only what moved, and an unchanged db is not opened at all.
 */
export class ProviderArchivedReader {
  private records = new Map<string, RecordVerdict>()
  private dbs = new Map<string, { readonly stamp: string; readonly rows: CopilotRow[] }>()
  private readonly claudeStoreDir: string | null

  /** undefined → the real desktop-app store; null → disabled (tests). */
  constructor(claudeStoreDir?: string | null) {
    this.claudeStoreDir = claudeStoreDir === undefined ? defaultClaudeStoreDir() : claudeStoreDir
  }

  async list(sources: SourceDir[], prev: ProviderHidden): Promise<ProviderHidden> {
    const out = new Set<string>()
    const deleted = new Set<string>()
    const jobs = sources
      .filter((s) => s.provider === 'copilot')
      .map(async (s) => {
        const rows = await this.copilotRows(join(s.path, 'data.db'))
        if (!rows) {
          // read failed (locked db, missing sqlite3): keep what we knew rather than
          // letting hidden sessions flicker back into the tree; the indexer seeds
          // prev from its persisted cache, so this holds across app launches too
          for (const id of prev.hidden) if (id.startsWith('copilot:')) out.add(id)
          for (const id of prev.deleted) if (id.startsWith('copilot:')) deleted.add(id)
          return
        }
        for (const r of rows) {
          if (r.hidden) out.add(`copilot:${r.id}`)
          if (r.deleted) deleted.add(`copilot:${r.id}`)
        }
        for (const id of copilotDeletedIds(s.path, rows)) {
          out.add(`copilot:${id}`)
          deleted.add(`copilot:${id}`)
        }
      })
    // the desktop store records archiving alone: a Claude session is never "deleted" here
    if (this.claudeStoreDir && sources.some((s) => s.provider === 'claude')) {
      jobs.push(this.claudeArchivedIds(this.claudeStoreDir, prev.hidden, out))
    }
    await Promise.all(jobs)
    return { hidden: out, deleted }
  }

  private async claudeArchivedIds(
    dir: string,
    prev: ReadonlySet<string>,
    out: Set<string>
  ): Promise<void> {
    if (!existsSync(dir)) return
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true })
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => join(e.parentPath, e.name))
      await pooled(files, RECORD_READERS, async (full) => {
        const id = await this.recordVerdict(full)
        if (id) out.add(`claude:${id}`)
      })
      // records the store no longer has: their verdicts are nobody's answer now
      const live = new Set(files)
      for (const path of this.records.keys()) if (!live.has(path)) this.records.delete(path)
    } catch (err) {
      console.error(`[indexer] claude archive read failed for ${dir}:`, err)
      // same policy as copilot: a failed sweep keeps what we knew
      for (const id of prev) if (id.startsWith('claude:')) out.add(id)
    }
  }

  /** The archived id this record holds, read only if the file moved since last time. */
  private async recordVerdict(full: string): Promise<string | null> {
    let st
    try {
      st = await stat(full)
    } catch {
      this.records.delete(full)
      return null
    }
    const hit = this.records.get(full)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.archivedId
    let archivedId: string | null = null
    if (st.size <= MAX_CLAUDE_RECORD_BYTES) {
      try {
        const rec = JSON.parse(await readFile(full, 'utf8')) as {
          isArchived?: unknown
          cliSessionId?: unknown
        }
        if (rec.isArchived === true && typeof rec.cliSessionId === 'string' && rec.cliSessionId) {
          archivedId = rec.cliSessionId
        }
      } catch {
        // record mid-write or a shape we don't know — skip it, formats drift.
        // Cached as "not archived" against this stamp; the next write changes it.
      }
    }
    this.records.set(full, { mtimeMs: st.mtimeMs, size: st.size, archivedId })
    return archivedId
  }

  /** null = the read failed; [] = it worked and the table is empty. */
  private async copilotRows(db: string): Promise<CopilotRow[] | null> {
    if (!existsSync(db)) return []
    const stamp = dbStamp(db)
    const hit = this.dbs.get(db)
    if (hit && stamp !== null && hit.stamp === stamp) return hit.rows
    // what this db's schema can answer, asked first: SQL can't name a table conditionally
    const probe = await sqlite(
      db,
      "SELECT m.name || '.' || p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p" +
        ` WHERE m.type = 'table' AND m.name IN (${COPILOT_TABLES.map((t) => `'${t}'`).join(', ')})`
    )
    if (probe === null) return null
    const columns = new Set(probe)
    if (!columns.has('sessions.id')) {
      console.error(`[indexer] copilot session read failed for ${db}: no sessions table`)
      return null
    }
    const lines = await sqlite(db, copilotSessionsSql(columns))
    if (lines === null) return null
    // the flags are the last two fields; an id is everything before them
    const rows = lines.flatMap((l) => {
      const m = /^(.+)\|([01])\|([01])$/.exec(l)
      return m ? [{ id: m[1], hidden: m[2] === '1', deleted: m[3] === '1' }] : []
    })
    if (stamp !== null) this.dbs.set(db, { stamp, rows })
    return rows
  }
}

/** One read-only query's output lines, or null (logged) when sqlite3 could not answer. */
async function sqlite(db: string, sql: string): Promise<string[] | null> {
  const r = await execText('sqlite3', ['-readonly', db, sql], { timeoutMs: 5000 })
  if (!r.ok) {
    console.error(`[indexer] copilot session read failed for ${db}:`, r.stderr.trim() || r.error)
    return null
  }
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * Run `fn` over everything with a fixed number in flight. A plain `Promise.all` over
 * a few thousand records queues every open at once; slicing into batches makes each
 * one wait for its slowest member. This keeps the width filled instead.
 */
async function pooled<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      if (item !== undefined) await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
}

/**
 * The db's identity for caching: its own mtime and size *and* its WAL sidecars'.
 * SQLite in WAL mode commits into `-wal` and can leave `data.db` untouched for a
 * long time, so the db file alone would say "unchanged" through a whole session of
 * archiving. Null when nothing could be stat'd — then nothing is cached.
 */
function dbStamp(db: string): string | null {
  const parts: string[] = []
  let any = false
  for (const p of [db, `${db}-wal`, `${db}-shm`]) {
    try {
      const st = statSync(p)
      parts.push(`${st.mtimeMs}:${st.size}`)
      any = true
    } catch {
      parts.push('-')
    }
  }
  return any ? parts.join('|') : null
}

/**
 * Deletion leaves no tombstone, so absence from the sessions table is the only signal —
 * but absence alone also matches pre-db CLI history the app never knew about. Bound the
 * inference by time: the mtime span of the events.jsonl files the db DOES know is the
 * era the db covers, and only row-less dirs inside that span were demonstrably known
 * and dropped. Older dirs (pre-db history) and newer ones (a session the db hasn't
 * recorded yet) stay visible. Deliberately derived from mtimes, not the db's
 * created_at/updated_at columns: it needs no schema beyond the id column the archive
 * read already requires, and it compares mtime against mtime rather than mixing clocks.
 */
function copilotDeletedIds(sourceDir: string, rows: CopilotRow[]): string[] {
  if (rows.length === 0) return []
  const known = new Set(rows.map((r) => r.id))
  const stateRoot = join(sourceDir, 'session-state')
  let dirs: string[]
  try {
    dirs = readdirSync(stateRoot)
  } catch {
    return []
  }
  let min = Infinity
  let max = -Infinity
  const candidates: { id: string; mtime: number }[] = []
  for (const d of dirs) {
    let mtime: number
    try {
      mtime = statSync(join(stateRoot, d, 'events.jsonl')).mtimeMs
    } catch {
      continue
    }
    if (known.has(d)) {
      if (mtime < min) min = mtime
      if (mtime > max) max = mtime
    } else {
      candidates.push({ id: d, mtime })
    }
  }
  return candidates.filter((c) => c.mtime >= min && c.mtime <= max).map((c) => c.id)
}
