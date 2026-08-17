import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getExtensions } from '../src/main/extensions'

/**
 * Claude's plugin files drift between releases: `source` used to be a plain
 * string and now arrives as an object. Whatever the shape, the UI must get a
 * string — "[object Object]" in the Marketplace tab was a real regression.
 */
describe('marketplace sources survive Claude config-shape drift', () => {
  const home = mkdtempSync(join(tmpdir(), 'cockpit-ext-'))
  const oldHome = process.env.HOME

  beforeAll(() => {
    // os.homedir() resolves from $HOME on posix — point every agent config read
    // at the fixture world (missing files are fine: reads are failure-tolerant)
    process.env.HOME = home
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        marketplaces: {
          'plain-string': 'acme/plain',
          'github-object': { source: { source: 'github', repo: 'acme/objecty' } },
          'git-url-object': { source: { source: 'git', url: 'https://git.example/x.git' } },
          'directory-object': { source: { source: 'directory', path: '/opt/marketplace' } },
          'unknown-shape': { source: { mystery: true } }
        }
      })
    )
  })

  afterAll(() => {
    process.env.HOME = oldHome
  })

  it('reduces every source shape to a human string, never [object Object]', () => {
    const { marketplaces } = getExtensions()
    const byName = new Map(marketplaces.map((m) => [m.name, m.source]))

    expect(byName.get('plain-string')).toBe('acme/plain')
    expect(byName.get('github-object')).toBe('acme/objecty')
    expect(byName.get('git-url-object')).toBe('https://git.example/x.git')
    expect(byName.get('directory-object')).toBe('/opt/marketplace')
    // an unrecognized object degrades to empty (row renders without a detail line)
    expect(byName.get('unknown-shape')).toBe('')
    for (const m of marketplaces) expect(m.source).not.toContain('[object')
  })
})
