import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SourceDir } from '../shared/types'

/**
 * Sessions archived — or deleted — inside the provider's own app must never show up in
 * Cockpit: not as active, not under Cockpit's own Archived toggle.
 *
 * Where each provider keeps that state:
 * - copilot: data.db (sessions table) is the app's source of truth.
 *   - archived: the row gets an `archived_at` timestamp; the transcript under
 *     session-state/ is left untouched, so the flag has to be read from the db.
 *   - deleted: the row is removed outright (the db has a session_deletion_intents
 *     table and no deleted_at column), again leaving session-state/<id>/events.jsonl
 *     behind. A row-less dir is treated as deleted only when its events.jsonl mtime
 *     falls inside the era the db demonstrably covers — see copilotDeletedIds.
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

export async function listProviderArchivedIds(
  sources: SourceDir[],
  prev: ReadonlySet<string>,
  opts?: { claudeStoreDir?: string | null }
): Promise<Set<string>> {
  const out = new Set<string>()
  const jobs = sources
    .filter((s) => s.provider === 'copilot')
    .map(async (s) => {
      const rows = await copilotSessionRows(join(s.path, 'data.db'))
      if (!rows) {
        // read failed (locked db, missing sqlite3): keep what we knew rather than
        // letting hidden sessions flicker back into the tree; the indexer seeds
        // prev from its persisted cache, so this holds across app launches too
        for (const id of prev) if (id.startsWith('copilot:')) out.add(id)
        return
      }
      for (const r of rows) if (r.archived) out.add(`copilot:${r.id}`)
      for (const id of copilotDeletedIds(s.path, rows)) out.add(`copilot:${id}`)
    })
  const claudeStore = opts?.claudeStoreDir === undefined ? defaultClaudeStoreDir() : opts.claudeStoreDir
  if (claudeStore && sources.some((s) => s.provider === 'claude')) {
    jobs.push(claudeArchivedIds(claudeStore, prev, out))
  }
  await Promise.all(jobs)
  return out
}

/** Desktop-app records are small; anything bigger is not a session record. */
const MAX_CLAUDE_RECORD_BYTES = 256 * 1024

async function claudeArchivedIds(
  dir: string,
  prev: ReadonlySet<string>,
  out: Set<string>
): Promise<void> {
  if (!existsSync(dir)) return
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map(async (e) => {
          try {
            const full = join(e.parentPath, e.name)
            if ((await stat(full)).size > MAX_CLAUDE_RECORD_BYTES) return
            const rec = JSON.parse(await readFile(full, 'utf8')) as {
              isArchived?: unknown
              cliSessionId?: unknown
            }
            if (rec.isArchived === true && typeof rec.cliSessionId === 'string' && rec.cliSessionId) {
              out.add(`claude:${rec.cliSessionId}`)
            }
          } catch {
            // record mid-write or a shape we don't know — skip it, formats drift
          }
        })
    )
  } catch (err) {
    console.error(`[indexer] claude archive read failed for ${dir}:`, err)
    // same policy as copilot: a failed sweep keeps what we knew
    for (const id of prev) if (id.startsWith('claude:')) out.add(id)
  }
}

interface CopilotRow {
  id: string
  archived: boolean
}

/** null = the read failed; [] = it worked and the table is empty. */
function copilotSessionRows(db: string): Promise<CopilotRow[] | null> {
  if (!existsSync(db)) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-readonly', db, 'SELECT id, archived_at IS NOT NULL FROM sessions'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          console.error(`[indexer] copilot session read failed for ${db}:`, err.message)
          return resolve(null)
        }
        resolve(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.includes('|'))
            .map((l) => {
              const sep = l.lastIndexOf('|')
              return { id: l.slice(0, sep), archived: l.slice(sep + 1) === '1' }
            })
        )
      }
    )
  })
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
