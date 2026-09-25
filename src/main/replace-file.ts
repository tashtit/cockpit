import { chmodSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

let seq = 0

/**
 * A temp name beside `path` that no other write is using. A fixed `${path}.tmp` let
 * two writers share one: the first rename carried the other's half-written file into
 * place and the second failed with ENOENT. The pid keeps two instances on one userData
 * apart (a dev run beside the installed app), the counter one process's overlapping
 * saves.
 */
function tempPathFor(path: string): string {
  return `${path}.${process.pid}.${++seq}.tmp`
}

/** Whether directory entry `name` is one of the temp files a write to `path` names. */
export function isTempFileOf(path: string, name: string): boolean {
  const base = basename(path)
  return name.startsWith(`${base}.`) && /^\d+\.\d+\.tmp$/.test(name.slice(base.length + 1))
}

export type AtomicWriteOptions = {
  /**
   * The mode the file ends with, whatever the umask or the mode of the file it
   * replaces. The temp file is then owner-only from its first byte, so a secret is
   * never readable mid-write. Unset, the file gets a new file's default.
   */
  readonly mode?: number
}

/**
 * Write a whole file at once: a temp file beside it, then a rename. A plain
 * `writeFileSync` truncates first and writes second, so a full disk or a crash between
 * the two leaves the file empty or cut short. A write that fails removes its temp file
 * and throws — whether that is fatal is the caller's to decide.
 */
export function writeFileAtomic(path: string, data: string, opts: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tempPathFor(path)
  try {
    if (opts.mode === undefined) writeFileSync(tmp, data)
    else {
      writeFileSync(tmp, data, { mode: 0o600 })
      // set after the write, not as a create option: the umask would narrow that one
      chmodSync(tmp, opts.mode)
    }
    renameSync(tmp, path)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // the write's own error is the one worth reporting
    }
    throw err
  }
}

/** writeFileAtomic off the event loop, for a file big enough to stall it (the index's caches). */
export async function writeFileAtomicAsync(path: string, data: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tempPathFor(path)
  try {
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export type ReplaceOptions = {
  /**
   * The mode a file this write creates gets. Owner-only unless the caller says
   * otherwise: most of what passes here is an agent config, and those hold MCP
   * `env` values — tokens — inline. A CLAUDE.md that lives in a repo passes 0o644.
   */
  readonly newFileMode?: number
}

/**
 * Replace a file the user owns — an agent's own config, a CLAUDE.md — all at once
 * (writeFileAtomic): for these files the old content existed nowhere else.
 *
 * A symlink is written through, never replaced: the rename lands on the file it
 * points at, so a dotfile manager's link stays a link. The file keeps its mode.
 */
export function replaceFile(path: string, content: string, opts: ReplaceOptions = {}): void {
  let target = path
  try {
    target = realpathSync(path)
  } catch {
    // not there yet: this write creates it
  }
  let mode: number | null = null
  try {
    mode = statSync(target).mode & 0o7777
  } catch {
    // a new file: `newFileMode` decides
  }
  writeFileAtomic(target, content, { mode: mode ?? opts.newFileMode ?? 0o600 })
}
