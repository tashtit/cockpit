import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

let seq = 0

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
export function replaceFile(path: string, content: string): void {
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
    // a new file takes the default mode
  }
  const tmp = `${target}.${process.pid}.${++seq}.tmp`
  try {
    writeFileSync(tmp, content)
    // set after the write, not as a create option: the umask would narrow that one
    if (mode !== null) chmodSync(tmp, mode)
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
