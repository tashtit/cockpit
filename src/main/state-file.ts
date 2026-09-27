import { readFileSync } from 'node:fs'
import { readJson } from './parsers/util'
import { writeFileAtomic } from './replace-file'

/**
 * Reading back the files Cockpit keeps, and the configs it rewrites, by the two rules
 * they come in: state that is only ever a convenience (a missing or hand-mangled one is
 * a fresh start), and a file that must never be rewritten from nothing because it could
 * not be read.
 */

/** Past this, a state file is not one Cockpit wrote; read as missing like any other bad one. */
const STATE_MAX_BYTES = 256 * 1024 * 1024

/**
 * A state file Cockpit wrote, through `sanitize` — it is hand-editable, and an older or
 * newer build may have written it. `fallback` when it is missing, not a regular file, not
 * JSON, or `sanitize` throws: a first run, or a file worth no more than a fresh start.
 */
export function readJsonState<T>(file: string, sanitize: (raw: unknown) => T, fallback: T): T {
  const raw = readJson(file, STATE_MAX_BYTES)
  if (raw === null) return fallback
  try {
    return sanitize(raw)
  } catch {
    return fallback
  }
}

/**
 * writeFileAtomic for state saved where a throw must not escape — a timer, a turn's
 * done handler. A failure is logged after `what`; the copy in memory stays right, and
 * the next save that works catches the file up.
 */
export function saveJsonQuietly(file: string, json: string, what: string): void {
  try {
    writeFileAtomic(file, json)
  } catch (err) {
    console.error(what, err)
  }
}

/**
 * A file's text, or null when there is none. Any other failure to read it throws: a
 * file that is there and cannot be read (EACCES, EISDIR, a transient EMFILE) is not an
 * empty one, and a caller that rewrote it from nothing would destroy what it holds.
 */
export function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
