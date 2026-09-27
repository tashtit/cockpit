import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionProvider, SourceDir } from '../shared/types'
import { isDrivable, PROVIDERS } from '../shared/providers'

/**
 * Where each agent on this machine keeps its sessions — found on disk, never assumed.
 *
 * The CLIs keep one home each (`~/.claude`, `~/.gemini`, …). The Cline family lives
 * inside an editor's extension storage instead, and the same extension can be installed
 * in any VS Code-family editor (VS Code, its Insiders build, Cursor, Windsurf, …), so
 * every editor's storage is listed rather than a known set: an editor released next
 * month is found the same way, with nothing to add here.
 */

/** Extension ids, as editors name their storage folders. */
const EXTENSION_IDS: Readonly<Record<'cline' | 'roo', string>> = {
  cline: 'saoudrizwan.claude-dev',
  roo: 'rooveterinaryinc.roo-cline'
}

/** Where VS Code-family editors keep per-user state: macOS, then Linux (XDG). */
function editorDataRoots(home: string): string[] {
  return [join(home, 'Library', 'Application Support'), join(home, '.config')]
}

/** A short, stable name for an editor's data folder: `Code` → `vscode`, `Cursor` → `cursor`. */
export function editorLabel(folder: string): string {
  if (folder === 'Code') return 'vscode'
  if (folder === 'Code - Insiders') return 'vscode-insiders'
  return folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'editor'
}

function hasFile(dir: string, suffix: string): boolean {
  try {
    return readdirSync(dir).some((n) => n.endsWith(suffix))
  } catch {
    return false
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Every agent home present under `home`, with the label Settings shows for it. A home
 * counts only once the agent has written sessions there (its session root exists):
 * `~/.gemini` alone is also where other Google tools keep settings.
 */
export function detectAgentHomes(home: string = homedir()): SourceDir[] {
  const out: SourceDir[] = []
  const add = (provider: SessionProvider, path: string, label: string, root: string): void => {
    if (existsSync(join(path, root))) out.push({ path, provider, label })
  }
  // the three CLIs Cockpit drives count from their home alone — a fresh install with
  // no session yet is still one to index, and to start sessions in
  for (const p of PROVIDERS) {
    const path = join(home, `.${p}`)
    if (existsSync(path)) out.push({ path, provider: p, label: `${p}-default` })
  }
  add('gemini', join(home, '.gemini'), 'gemini-default', 'tmp')
  // Cursor: its CLI's transcripts, or only the conversations its ACP server keeps — the
  // ones Cockpit started
  const cursor = join(home, '.cursor')
  if (['projects', 'acp-sessions'].some((root) => existsSync(join(cursor, root)))) {
    out.push({ path: cursor, provider: 'cursor', label: 'cursor-default' })
  }
  add('cline', join(home, '.cline', 'data'), 'cline-cli', 'tasks')
  // opencode's data home: its database, or the file store it kept before one
  const opencode = join(home, '.local', 'share', 'opencode')
  if (existsSync(join(opencode, 'opencode.db'))) out.push({ path: opencode, provider: 'opencode', label: 'opencode-default' })
  else add('opencode', opencode, 'opencode-default', join('storage', 'session'))
  // Antigravity: the IDE, the CLI, and the first releases' home — counted once it holds a
  // conversation database; the first releases' encrypted `.pb` conversations cannot be read
  for (const dir of ['antigravity-ide', 'antigravity-cli', 'antigravity']) {
    const path = join(home, '.gemini', dir)
    if (hasFile(join(path, 'conversations'), '.db')) out.push({ path, provider: 'antigravity', label: dir })
  }
  for (const root of editorDataRoots(home)) {
    for (const editor of subdirs(root)) {
      const storage = join(root, editor, 'User', 'globalStorage')
      // Cursor's own chats: one database in its editor storage
      if (editor === 'Cursor') add('cursor', storage, 'cursor-ide', 'state.vscdb')
      for (const provider of ['cline', 'roo'] as const) {
        add(provider, join(storage, EXTENSION_IDS[provider]), `${provider}-${editorLabel(editor)}`, 'tasks')
      }
    }
  }
  return out
}

/**
 * Fold what detection found into the configured sources: a home found that is not a
 * source is added, unless the person removed it — `dismissed`, which only Settings'
 * Remove writes (`AppConfig.dismissedSources`). Removal is recorded, never inferred from a
 * home's absence: an older build that cannot read an agent drops that agent's sources
 * when it rewrites the shared config, and that must not read as the person removing them.
 * A config from before the record has none. Its first run offered the three CLI homes
 * then, so one of those found now and not configured was removed, and counts as dismissed.
 */
export function reconcileDetected(
  sources: readonly SourceDir[],
  dismissed: readonly string[] | undefined,
  found: readonly SourceDir[]
): { readonly sources: SourceDir[]; readonly dismissed: string[]; readonly changed: boolean } {
  const known = new Set(sources.map((s) => resolve(s.path)))
  const removed = new Set(
    dismissed ?? found.filter((s) => isDrivable(s.provider) && !known.has(resolve(s.path))).map((s) => resolve(s.path))
  )
  const added = found.filter((s) => !known.has(resolve(s.path)) && !removed.has(resolve(s.path)))
  return { sources: [...sources, ...added], dismissed: [...removed], changed: added.length > 0 || dismissed === undefined }
}
