import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
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
 * - claude: archive state is not persisted anywhere readable on disk.
 */
export async function listProviderArchivedIds(
  sources: SourceDir[],
  prev: ReadonlySet<string>
): Promise<Set<string>> {
  const out = new Set<string>()
  await Promise.all(
    sources
      .filter((s) => s.provider === 'copilot')
      .map(async (s) => {
        const ids = await copilotArchivedIds(join(s.path, 'data.db'))
        if (ids) for (const id of ids) out.add(`copilot:${id}`)
        // read failed (locked db, missing sqlite3): keep what we knew rather than
        // letting archived sessions flicker back into the tree
        else for (const id of prev) out.add(id)
      })
  )
  return out
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
