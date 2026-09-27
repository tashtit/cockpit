import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionProvider, SourceDir } from '../shared/types'
import { isDrivable } from '../shared/providers'

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
  for (const p of ['claude', 'codex', 'copilot'] as const) {
    const path = join(home, `.${p}`)
    if (existsSync(path)) out.push({ path, provider: p, label: `${p}-default` })
  }
  add('gemini', join(home, '.gemini'), 'gemini-default', 'tmp')
  add('cursor', join(home, '.cursor'), 'cursor-default', 'projects')
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
 * Fold what detection found into the configured sources. A home is added the first time
 * it is ever seen and never again, so one the person removed stays removed; `seen` is
 * that memory (`AppConfig.detectedSources`). A config written before detection kept any
 * memory has none — its three CLI homes were offered on its first run, so they count as
 * seen, and only agents this build newly reads are added.
 */
export function reconcileDetected(
  sources: readonly SourceDir[],
  seen: readonly string[] | undefined,
  found: readonly SourceDir[]
): { readonly sources: SourceDir[]; readonly seen: string[]; readonly changed: boolean } {
  const known = new Set(sources.map((s) => resolve(s.path)))
  const remembered = new Set(
    seen ?? found.filter((s) => isDrivable(s.provider)).map((s) => resolve(s.path))
  )
  const added = found.filter((s) => !known.has(resolve(s.path)) && !remembered.has(resolve(s.path)))
  const nextSeen = new Set(remembered)
  for (const s of found) nextSeen.add(resolve(s.path))
  const changed = added.length > 0 || seen === undefined || nextSeen.size !== remembered.size
  return { sources: [...sources, ...added], seen: [...nextSeen], changed }
}
