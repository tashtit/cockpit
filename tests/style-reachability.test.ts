import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A CSS rule for a class nothing renders is worse than dead weight: MASTER.md cites
// class names as the design system's vocabulary, so a stale one teaches an agent to
// reach for a class that styles nothing. Three of those had accumulated (.ext-tab as
// the tab voice, .inst-scope label as a micro-label, .recent-row as a row type) and
// were only found by hand.
//
// "Reachable" is deliberately generous — this asks "could anything ever emit this?",
// not "is it used on a live screen". A class counts if its name appears anywhere in
// the renderer, the component tests, the e2e specs or the ui-tour, or if it starts
// with a prefix some template literal composes onto (`plogo-${p}`), or ends with a
// suffix one appends. What it therefore cannot catch: a class only ever produced by a
// prefix that is itself dead, and one whose rule survives while its markup is deleted
// in the same commit that leaves the literal somewhere else. It catches the case that
// actually happened — a rule whose markup is gone entirely.
const ROOT = join(__dirname, '..')
const CSS = join(ROOT, 'src', 'renderer', 'src', 'style.css')

/** Emitted by highlight.js at runtime, so no source of ours ever names them. */
const FOREIGN = ['hljs-']

const SOURCE_DIRS = [
  ['src', 'renderer', 'src'],
  ['tests', 'component'],
  ['tests', 'e2e'],
  ['scripts', 'ui-tour']
] as const

/** Every .ts/.tsx/.mts file under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    if (e.isDirectory()) return sources(full)
    return /\.(ts|tsx|mts)$/.test(e.name) ? [readFileSync(full, 'utf8')] : []
  })
}

describe('style.css has no rule for markup that does not exist', () => {
  const css = readFileSync(CSS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // a class named in a comment is not a rule
    .replace(/url\([^)]*\)/g, '') // font paths carry dots that read as selectors
  const declared = [...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ''))]

  const source = SOURCE_DIRS.map((d) => sources(join(ROOT, ...d)).join('\n')).join('\n')
  // `plogo-${p}` / `${scope}-row`: the halves a template literal can build a name from
  const prefixes = [...new Set([...source.matchAll(/([a-zA-Z][\w-]*-)\$\{/g)].map((m) => m[1] ?? ''))]
  const suffixes = [...new Set([...source.matchAll(/\}(-[a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ''))]

  it('reads both sides', () => {
    expect(declared.length).toBeGreaterThan(400)
    expect(prefixes.length).toBeGreaterThan(5)
  })

  it('every class could be emitted by something', () => {
    const unreachable = declared.filter(
      (c) =>
        !FOREIGN.some((f) => c.startsWith(f)) &&
        !source.includes(c) &&
        !prefixes.some((p) => c.startsWith(p)) &&
        !suffixes.some((s) => c.endsWith(s))
    )
    // delete the rule, or — if something really does render it — say so here
    expect(unreachable).toEqual([])
  })
})
