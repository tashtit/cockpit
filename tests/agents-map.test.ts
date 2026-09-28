import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * AGENTS.md is what every agent session reads before it opens a file, and it makes two
 * promises nothing else checks: its maps name every module, and a module's header
 * comment is its spec. Both drifted within a day of being written — a dozen modules
 * went unmapped and eight main modules had no header — because the rule lived only in
 * prose. These pin them the way style-reachability pins the stylesheet.
 */

const ROOT = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts'))
    .map((e) => join(e.parentPath, e.name).slice(ROOT.length + 1))
}

/** What AGENTS.md names in backticks: file stems, directories (`parsers/`) and globs (`Work*Tab`). */
function mapped(): { readonly stems: Set<string>; readonly dirs: Set<string>; readonly globs: RegExp[] } {
  const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
  const stems = new Set<string>()
  const dirs = new Set<string>()
  const globs: RegExp[] = []
  for (const [, token] of text.matchAll(/`([^`\s]+)`/g)) {
    if (token.endsWith('/')) {
      dirs.add(basename(token))
      continue
    }
    const stem = basename(token).replace(/\.(tsx?|mts|mjs)$/, '')
    if (stem.includes('*')) globs.push(new RegExp(`^${stem.replaceAll('*', '.*')}$`))
    else stems.add(stem)
  }
  return { stems, dirs, globs }
}

describe('AGENTS.md', () => {
  it('names every module in its maps', () => {
    const { stems, dirs, globs } = mapped()
    const roots = ['src/main', 'src/shared', 'src/preload', 'src/renderer/src']
    const unmapped = roots
      .flatMap(sources)
      .filter((file) => {
        const stem = basename(file).replace(/\.tsx?$/, '')
        // a -core.ts file is the IO-free half of the module it is named for
        const module = stem.replace(/-core$/, '')
        // a mapped subdirectory (`parsers/`, `ipc/`) covers its files; a root itself does not
        const inMappedDir = !roots.includes(dirname(file)) && dirs.has(basename(dirname(file)))
        return !stems.has(stem) && !stems.has(module) && !inMappedDir && !globs.some((g) => g.test(stem))
      })
    // add a line (or a name to one) in AGENTS.md's main-process or renderer map
    expect(unmapped).toEqual([])
  })

  it('finds a header comment at the top of every main, preload and shared module', () => {
    const bare = ['src/main', 'src/shared', 'src/preload'].flatMap(sources).filter((file) => !hasHeader(file))
    // a module's header comment is its spec: say what it does, before the first declaration
    expect(bare).toEqual([])
  })
})

/** A block comment before the first declaration — imports and re-exports may come first. */
function hasHeader(file: string): boolean {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
  let inStatement = false
  for (const raw of lines) {
    const line = raw.trim()
    if (inStatement) {
      // a multi-line import or re-export ends on its module specifier or closing brace
      if (/from\s+['"][^'"]+['"];?$/.test(line) || /^\}\s*;?$/.test(line)) inStatement = false
      continue
    }
    if (line === '' || line.startsWith('//')) continue
    if (line.startsWith('/*')) return true
    const importish = /^import\b/.test(line) || /^export\s+(type\s+)?(\{|\*)/.test(line)
    if (!importish) return false
    // a one-line statement is whole; otherwise skip to where it ends
    inStatement = !(/from\s+['"][^'"]+['"];?$/.test(line) || /^import\s+['"]/.test(line) || /\}\s*;?$/.test(line))
  }
  return false
}
