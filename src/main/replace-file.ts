import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

let seq = 0

export type ReplaceOptions = {
  /**
   * The mode a file this write creates gets. Owner-only unless the caller says
   * otherwise: most of what passes here is an agent config, and those hold MCP
   * `env` values — tokens — inline. A CLAUDE.md that lives in a repo passes 0o644.
   */
  readonly newFileMode?: number
}

/**
 * Replace a file the user owns — an agent's own config, a CLAUDE.md — all at once:
 * a temp file beside it, then a rename. A plain `writeFileSync` truncates first and
 * writes second, so a full disk or a crash between the two leaves the file empty or
 * cut short, and for these files the old content existed nowhere else.
 *
 * A symlink is written through, never replaced: the rename lands on the file it
 * points at, so a dotfile manager's link stays a link. The file keeps its mode. The
 * temp name is unique per write, so two writers can never rename each other's
 * half-written file into place.
 */
export function replaceFile(path: string, content: string, opts: ReplaceOptions = {}): void {
  let target = path
  try {
    target = realpathSync(path)
  } catch {
    // not there yet: this write creates it
  }
  mkdirSync(dirname(target), { recursive: true })
  let mode: number | null = null
  try {
    mode = statSync(target).mode & 0o7777
  } catch {
    // a new file: `newFileMode` decides
  }
  const tmp = `${target}.${process.pid}.${++seq}.tmp`
  try {
    // created owner-only from the first byte: a mode set after the write would leave
    // the secrets readable for as long as the write took
    writeFileSync(tmp, content, { mode: 0o600 })
    // set after the write, not as a create option: the umask would narrow that one
    chmodSync(tmp, mode ?? opts.newFileMode ?? 0o600)
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
