import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  catalogUrls,
  githubRepoOf,
  matchesCatalogQuery,
  parseCatalog
} from '../src/shared/marketplace'
import { listCatalogs, localCatalogVersions, lookupCatalog } from '../src/main/marketplace'
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
    // a marketplace only Codex has: Codex keeps its snapshot under .tmp/
    write(
      join(home, '.codex', 'config.toml'),
      '[marketplaces.codex-only]\nsource_type = "git"\nsource = "https://github.com/acme/codex-only.git"\n'
    )
    write(
      join(home, '.codex', '.tmp', 'marketplaces', 'codex-only', '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'codex-only', plugins: [{ name: 'trace', version: '0.3.0' }] })
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

  it('reads the snapshot Codex keeps under .tmp/', () => {
    const codex = listCatalogs().find((c) => c.name === 'codex-only')
    expect(codex?.agents).toEqual(['codex'])
    expect(codex?.plugins.map((p) => p.id)).toEqual(['trace@codex-only'])
  })

  describe('looking one up on GitHub', () => {
    /** Serves `files` by URL; anything else is a 404. Returns the URLs asked for. */
    function serve(files: Record<string, unknown>): string[] {
      const asked: string[] = []
      vi.stubGlobal('fetch', async (url: string) => {
        asked.push(url)
        return url in files
          ? new Response(typeof files[url] === 'string' ? (files[url] as string) : JSON.stringify(files[url]), { status: 200 })
          : new Response('not found', { status: 404 })
      })
      return asked
    }
    afterEach(() => vi.unstubAllGlobals())

    it('refuses anything that is not a GitHub repository, without asking the network', async () => {
      const asked = serve({})
      await expect(lookupCatalog('file:///etc')).rejects.toThrow(/owner\/repo or a github.com URL/)
      await expect(lookupCatalog('https://gitlab.com/acme/plugins')).rejects.toThrow(/owner\/repo/)
      expect(asked).toEqual([])
    })

    // the name the agents already know a marketplace by is the half of every plugin id
    // an install is spelled with, so it wins over the file's own
    it('reads the older spelling when the newer one is missing, under the name agents know it by', async () => {
      const [newer, older] = catalogUrls('acme/agent-plugins')
      const asked = serve({ [older]: { name: 'acme-upstream', plugins: [{ name: 'lint', version: '2.0.0' }] } })
      const found = await lookupCatalog('https://github.com/acme/agent-plugins.git')
      expect(asked).toEqual([newer, older])
      expect(found).toMatchObject({ name: 'acme-market', agents: ['claude'], origin: 'remote' })
      expect(found.plugins.map((p) => p.id)).toEqual(['lint@acme-market'])
    })

    it('keeps what it fetched for the afternoon, and never keeps a failure', async () => {
      const [newer] = catalogUrls('acme/kept')
      serve({})
      await expect(lookupCatalog('acme/kept')).rejects.toThrow(/no catalogue file in that repository/)
      // the failure was not kept: this lookup asks again, and finds it
      serve({ [newer]: { name: 'kept', plugins: [{ name: 'a' }] } })
      expect((await lookupCatalog('acme/kept')).plugins).toHaveLength(1)
      // the find was kept: nothing is asked for the next one
      const asked = serve({})
      expect((await lookupCatalog('acme/kept')).name).toBe('kept')
      expect(asked).toEqual([])
    })

    // a catalogue's own name is a claim anyone can make: a fork calling itself tashtit,
    // or by the name of a marketplace already here, must not take that row
    it('refuses a repository that names itself after a marketplace another repository holds here', async () => {
      const [forkNewer] = catalogUrls('mallory/marketplace')
      const [otherNewer] = catalogUrls('mallory/acme')
      serve({
        [forkNewer]: { name: 'tashtit', plugins: [{ name: 'git-workflow' }] },
        [otherNewer]: { name: 'acme-market', plugins: [{ name: 'review' }] }
      })
      await expect(lookupCatalog('mallory/marketplace')).rejects.toThrow(
        /calls itself “tashtit”, but the tashtit marketplace here comes from https:\/\/github\.com\/tashtit\/marketplace\.git/
      )
      await expect(lookupCatalog('mallory/acme')).rejects.toThrow(/comes from acme\/agent-plugins/)
    })

    it('vouches for the recommended repository, never for a name', async () => {
      // GitHub spells a repository in any case; it is still the one vouched for
      const [recNewer] = catalogUrls('Tashtit/Marketplace')
      const [renamedNewer] = catalogUrls('someone/renamed')
      serve({
        [recNewer]: { name: 'tashtit', plugins: [{ name: 'git-workflow' }] },
        [renamedNewer]: { name: 'renamed', plugins: [] }
      })
      expect(await lookupCatalog('https://github.com/Tashtit/Marketplace')).toMatchObject({
        name: 'tashtit',
        recommended: true
      })
      expect((await lookupCatalog('someone/renamed')).recommended).toBeUndefined()
    })

    it('says so when the file is not a catalogue at all', async () => {
      const [newer, older] = catalogUrls('acme/odd')
      serve({ [newer]: '{"not": "a catalogue"}', [older]: 'plain text' })
      await expect(lookupCatalog('acme/odd')).rejects.toThrow(/not a marketplace catalogue/)
    })
  })

  it('says what each catalogue offers a plugin at, for the update check', () => {
    expect(localCatalogVersions().get('review@acme-market')).toBe('1.4.0')
  })
})

describe('a marketplace that only borrows the recommended name', () => {
  const home = mkdtempSync(join(tmpdir(), 'cockpit-market-fork-'))
  const oldHome = process.env.HOME

  beforeAll(() => {
    process.env.HOME = home
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({ tashtit: { source: { source: 'git', url: 'https://github.com/mallory/marketplace.git' } } })
    )
  })

  afterAll(() => {
    process.env.HOME = oldHome
  })

  it('is listed as the marketplace it is, not as the one Cockpit recommends', () => {
    const row = listCatalogs().find((c) => c.name === 'tashtit')
    expect(row?.source).toBe('https://github.com/mallory/marketplace.git')
    expect(row?.recommended).toBeUndefined()
  })
})
