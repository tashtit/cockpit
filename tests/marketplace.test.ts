import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  catalogUrls,
  githubRepoOf,
  matchesCatalogQuery,
  parseCatalog
} from '../src/shared/marketplace'
import { listCatalogs, localCatalogVersions } from '../src/main/marketplace'
import { RECOMMENDED_MARKETPLACE } from '../src/shared/library'

/**
 * A marketplace catalogue is someone else's file, so the parser is tolerant the way
 * the session parsers are: a shape it can't read is left out, never thrown over.
 */
describe('reading a marketplace catalogue', () => {
  it('names the marketplace and its plugins', () => {
    const parsed = parseCatalog(
      {
        name: 'tashtit',
        plugins: [
          {
            name: 'git-workflow',
            description: 'Focused commits and review-ready pull requests',
            version: '1.2.0',
            author: { name: 'Tashtit', email: 'nobody@example.com' },
            category: 'git',
            keywords: ['commit', 'pr'],
            homepage: 'https://example.com/git-workflow'
          }
        ]
      },
      'fallback'
    )
    expect(parsed?.name).toBe('tashtit')
    expect(parsed?.plugins).toEqual([
      {
        name: 'git-workflow',
        id: 'git-workflow@tashtit',
        description: 'Focused commits and review-ready pull requests',
        version: '1.2.0',
        author: 'Tashtit',
        category: 'git',
        keywords: ['commit', 'pr'],
        homepage: 'https://example.com/git-workflow'
      }
    ])
  })

  it('takes the name it was added under when the file names none', () => {
    expect(parseCatalog({ plugins: [] }, 'acme-market')?.name).toBe('acme-market')
  })

  it('reads a plugin listed as a bare path, and drops one with no name', () => {
    const parsed = parseCatalog({ name: 'm', plugins: ['./plugins/review', { version: '1' }] }, 'm')
    expect(parsed?.plugins.map((p) => p.id)).toEqual(['review@m'])
  })

  it('keeps one row per plugin name', () => {
    const parsed = parseCatalog({ name: 'm', plugins: [{ name: 'a' }, { name: 'a' }] }, 'm')
    expect(parsed?.plugins).toHaveLength(1)
  })

  it('refuses anything that is not a catalogue', () => {
    expect(parseCatalog(null, 'm')).toBeNull()
    expect(parseCatalog({ name: 'm' }, 'm')).toBeNull()
    expect(parseCatalog('{}', 'm')).toBeNull()
  })

  it('matches a query on name, description, keywords and category', () => {
    const plugin = {
      name: 'secure-ci',
      id: 'secure-ci@m',
      description: 'Pinned actions and least-privilege tokens',
      category: 'ci',
      keywords: ['actions', 'workflow']
    }
    expect(matchesCatalogQuery(plugin, '')).toBe(true)
    expect(matchesCatalogQuery(plugin, 'TOKENS')).toBe(true)
    expect(matchesCatalogQuery(plugin, 'workflow')).toBe(true)
    expect(matchesCatalogQuery(plugin, 'roundtable')).toBe(false)
  })
})

describe('the repository a source names', () => {
  it('reads GitHub in every spelling an agent records', () => {
    expect(githubRepoOf('https://github.com/tashtit/marketplace.git')).toBe('tashtit/marketplace')
    expect(githubRepoOf('git@github.com:tashtit/marketplace')).toBe('tashtit/marketplace')
    expect(githubRepoOf('tashtit/marketplace')).toBe('tashtit/marketplace')
  })

  it('refuses anything a raw URL cannot be built from', () => {
    expect(githubRepoOf(undefined)).toBeNull()
    expect(githubRepoOf('/opt/marketplace')).toBeNull()
    expect(githubRepoOf('https://git.example.com/acme/x.git')).toBeNull()
    // a deeper path is not a repository, and must never become one
    expect(githubRepoOf('https://github.com/tashtit/marketplace/tree/main')).toBeNull()
  })

  it('reads the catalogue from the repository head, newest spelling first', () => {
    expect(catalogUrls('a/b')).toEqual([
      'https://raw.githubusercontent.com/a/b/HEAD/.claude-plugin/marketplace.json',
      'https://raw.githubusercontent.com/a/b/HEAD/marketplace.json'
    ])
  })
})

describe('what the marketplaces on this machine hold', () => {
  const home = mkdtempSync(join(tmpdir(), 'cockpit-market-'))
  const oldHome = process.env.HOME

  beforeAll(() => {
    process.env.HOME = home
    const write = (file: string, text: string): void => {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, text)
    }
    write(
      join(home, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ 'acme-market': { source: 'acme/agent-plugins' }, 'ships-with': {} })
    )
    write(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'review@acme-market': [{ version: '1.0.0' }] } })
    )
    write(
      join(home, '.claude', 'plugins', 'marketplaces', 'acme-market', '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'acme-market',
        plugins: [
          { name: 'review', description: 'Reviews a diff', version: '1.4.0' },
          { name: 'deploy', description: 'Ships it', version: '0.2.0' }
        ]
      })
    )
  })

  afterAll(() => {
    process.env.HOME = oldHome
  })

  it('reads the clone the agent already made, and never the network', () => {
    const acme = listCatalogs().find((c) => c.name === 'acme-market')
    expect(acme?.origin).toBe('local')
    expect(acme?.agents).toEqual(['claude'])
    expect(acme?.plugins.map((p) => p.id)).toEqual(['review@acme-market', 'deploy@acme-market'])
    expect(acme?.problem).toBeUndefined()
  })

  it('still lists a marketplace whose catalogue is not here, and says why', () => {
    const ships = listCatalogs().find((c) => c.name === 'ships-with')
    expect(ships?.plugins).toEqual([])
    expect(ships?.problem).toContain('no catalogue')
    expect(ships?.origin).toBeUndefined()
  })

  it('always offers the one Cockpit recommends, whether or not an agent has it', () => {
    const rec = listCatalogs().find((c) => c.name === RECOMMENDED_MARKETPLACE.name)
    expect(rec?.recommended).toBe(true)
    expect(rec?.agents).toEqual([])
    expect(rec?.source).toBe(RECOMMENDED_MARKETPLACE.source)
  })

  it('says what each catalogue offers a plugin at, for the update check', () => {
    expect(localCatalogVersions().get('review@acme-market')).toBe('1.4.0')
  })
})
