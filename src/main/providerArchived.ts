import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SourceDir } from '../shared/types'

/**
 * Sessions archived inside the provider's own app must never show up in Cockpit —
 * not as active, not under Cockpit's own Archived toggle.
 *
 * Where each provider keeps that state:
 * - copilot: an `archived_at` column in <home>/data.db (sessions table). The
 *   transcript files under session-state/ are left untouched, so the flag has to
 *   be read from the db.
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
      const ids = await copilotArchivedIds(join(s.path, 'data.db'))
      if (ids) for (const id of ids) out.add(`copilot:${id}`)
      // read failed (locked db, missing sqlite3): keep what we knew rather than
      // letting archived sessions flicker back into the tree
      else for (const id of prev) if (id.startsWith('copilot:')) out.add(id)
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

/** null = the read failed; [] = it worked and nothing is archived. */
function copilotArchivedIds(db: string): Promise<string[] | null> {
  if (!existsSync(db)) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-readonly', db, 'SELECT id FROM sessions WHERE archived_at IS NOT NULL'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          console.error(`[indexer] copilot archive read failed for ${db}:`, err.message)
          return resolve(null)
        }
        resolve(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        )
      }
    )
  })
}
