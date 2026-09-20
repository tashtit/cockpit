import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isUnder } from '../src/main/paths'

/*
 * "Is this path inside that directory?" is the question main asks before it spawns a
 * CLI, unlinks a log, removes a worktree or writes through a symlink — the boundary
 * the app's whole threat model rests on. It was written eight times in four spellings
 * (some with `sep`, some with a literal `/`, some counting the directory itself and
 * some not), which is one edit away from a check that passes where its twin refuses.
 *
 * `src/main/paths.ts` is now the only definition, and this is what keeps it that way —
 * the same job `shared-purity` and `style-reachability` do for their own rules.
 */

const MAIN = join(__dirname, '..', 'src', 'main')

/** `x.startsWith(root + '/')` and `x.startsWith(root + sep)` — a containment check by hand. */
const HAND_ROLLED = /startsWith\([^)]*\+ *(?:sep|'\/'|"\/")\)/

/**
 * Lines that look like the rule but aren't, each with the reason it stays. A
 * containment check belongs in `isUnder`; only something that is genuinely a
 * different operation belongs here.
 */
const ALLOWED: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'backup-core.ts',
    why: 'rewriteHome swaps one prefix for another, so it depends on the exact string it slices off — and its `from` is untrusted input from the backup file'
  }
]

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : []
  )
}

describe('isUnder', () => {
  it('counts the directory itself as inside it', () => {
    expect(isUnder('/a/b', '/a/b')).toBe(true)
  })

  it('counts anything below it', () => {
    expect(isUnder('/a/b/c', '/a/b')).toBe(true)
    expect(isUnder('/a/b/c/d.json', '/a/b')).toBe(true)
  })

  it('does not count a sibling whose name merely starts the same', () => {
    // the bug a bare startsWith has: /a/bcd is not inside /a/b
    expect(isUnder('/a/bcd', '/a/b')).toBe(false)
    expect(isUnder('/a/b-2', '/a/b')).toBe(false)
  })

  it('reads a parent that already ends in a separator the same way', () => {
    expect(isUnder('/a/b/c', '/a/b/')).toBe(true)
    expect(isUnder('/a/bcd', '/a/b/')).toBe(false)
  })

  it('does not count a parent as inside its child', () => {
    expect(isUnder('/a', '/a/b')).toBe(false)
  })
})

describe('nothing in main rolls its own', () => {
  it('has no hand-written path-containment check outside paths.ts', () => {
    const offenders: string[] = []
    for (const file of tsFiles(MAIN)) {
      const name = file.slice(MAIN.length + 1)
      if (name === 'paths.ts') continue
      if (ALLOWED.some((a) => a.file === name)) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (HAND_ROLLED.test(line)) offenders.push(`${name}:${i + 1} ${line.trim()}`)
        })
    }
    // if this fires: import `isUnder` from './paths' instead — or, if the line really
    // is a different operation, add it to ALLOWED with the reason
    expect(offenders).toEqual([])
  })
})
