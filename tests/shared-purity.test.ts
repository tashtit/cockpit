import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `src/shared/` is what main and the renderer agree on, and it holds two rules that
// nothing else can check.
//
// It is pure: the renderer is sandboxed (contextIsolation, sandbox: true, no Node), so
// one `node:fs` import here does not fail a typecheck or a unit test — it fails at
// runtime, in the built app, as a blank view.
//
// And it is acyclic, in one direction: types.ts is the domain vocabulary and imports
// nothing from src/, library.ts imports types.ts, contract.ts imports both. TypeScript
// is happy to compile a type-only cycle, which is how the one #140 removed survived as
// long as it did.
const SHARED = join(__dirname, '..', 'src', 'shared')

/** Every module specifier a file imports or re-exports from. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1] ?? ''
  )
}

/** What a shared module may import from its own directory. Anything absent may import any sibling. */
const LAYERS: Record<string, readonly string[]> = {
  'types.ts': [],
  'library.ts': ['./types'],
  'contract.ts': ['./types', './library']
}

describe('src/shared is pure', () => {
  const files = readdirSync(SHARED).filter((f) => f.endsWith('.ts'))

  it('has modules to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  for (const file of files) {
    it(`${file} imports only its siblings`, () => {
      // a package, `node:*`, `electron`, or a reach up into src/main or src/renderer —
      // each of them either breaks the sandbox or points the shared layer at one process
      expect(specifiers(readFileSync(join(SHARED, file), 'utf8')).filter((s) => !s.startsWith('./'))).toEqual([])
    })
  }

  for (const [file, allowed] of Object.entries(LAYERS)) {
    it(`${file} stays under ${allowed.length === 0 ? 'nothing' : allowed.join(' + ')}`, () => {
      expect(files).toContain(file)
      const siblings = specifiers(readFileSync(join(SHARED, file), 'utf8')).filter((s) => s.startsWith('./'))
      expect(siblings.filter((s) => !allowed.includes(s))).toEqual([])
    })
  }
})
