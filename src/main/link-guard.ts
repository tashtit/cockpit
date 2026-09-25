import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isUnder } from './paths'

/*
 * Writing into a directory someone else filled.
 *
 * A clone decides what its files are, symlinks included: a repo can commit
 * `AGENTS.md` as a link to `../../.codex/AGENTS.md`, or a skill folder whose
 * `.agents` is a link to `~/.codex`. Writing "into the repo" through such a link
 * writes wherever it points, and a recursive copy that follows one copies whatever
 * it names. Every write Cockpit makes into a repo's own files asks this first.
 */

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** `path` with its links followed as far as they lead — itself when nothing is there. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Where a write to `path` lands, once every link on the way is followed — thrown
 * on when that is outside `root` (`what` names it in the message), or when `path`
 * is a link to nothing: writing one creates whatever it names, wherever that is.
 * A path not there yet is judged by its nearest ancestor that is, so a link higher
 * up (`<repo>/.agents` → `~/.codex`) is caught before the directories below it are
 * made.
 */
export function resolveWithin(path: string, root: string, what: string): string {
  // the root is resolved too: a macOS temp dir lives under /var, a link to /private/var,
  // and a resolved file compared with an unresolved root reads as somewhere else
  if (!existsSync(path) && isSymlink(path)) {
    throw new Error(`${path} is a link to nothing — refusing to write through it`)
  }
  const base = realOrSelf(root)
  let existing = path
  while (!existsSync(existing) && relative(root, existing) !== '') {
    const up = join(existing, '..')
    if (up === existing) break
    existing = up
  }
  const real = join(realOrSelf(existing), relative(existing, path))
  if (real === base || !isUnder(real, base)) {
    throw new Error(`${path} points outside ${what} — refusing to write through it`)
  }
  return real
}

/**
 * Throws when anything inside `dir` is a link that leads out of `root` — what a
 * copy that follows links would otherwise pull in. A link to nothing is left
 * alone: there is nothing to copy through it.
 */
export function assertLinksWithin(dir: string, root: string, what: string): void {
  const base = realOrSelf(root)
  const walk = (p: string, depth: number): void => {
    if (depth > 32) throw new Error(`${p} nests too deep to copy`)
    let st
    try {
      st = lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) {
      let real: string
      try {
        real = realpathSync(p)
      } catch {
        return
      }
      if (!isUnder(real, base)) throw new Error(`${p} links outside ${what} — refusing to copy it`)
      // a link to a folder inside the root is copied as that folder, so what is in it counts too
      if (lstatSync(real).isDirectory()) walkDir(real, depth + 1)
      return
    }
    if (st.isDirectory()) walkDir(p, depth + 1)
  }
  const walkDir = (d: string, depth: number): void => {
    let names: string[] = []
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) walk(join(d, n), depth)
  }
  walk(dir, 0)
}
