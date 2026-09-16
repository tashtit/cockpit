import { describe, it, expect } from 'vitest'
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  aadFor,
  planRestore,
  sanitizeBundle,
  seal,
  splitSecrets,
  unseal,
  type Bundle,
  type ScopeRecord,
  type Secrets
} from '../src/main/backup-core'
import type { AppConfig } from '../src/main/config'
import type { LibraryEntry, ModelEndpoint } from '../src/shared/types'

/*
 * The rules a backup follows with no disk in sight: what a file may contain, what
 * a passphrase does to it, and what restoring it would change.
 */

const header = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, createdAt: '2026-09-16T10:00:00.000Z' } as const

function bundle(over: Partial<Bundle> = {}): Bundle {
  return {
    ...header,
    appVersion: '1.2.3',
    home: '/Users/someone',
    settings: { hiddenRepos: [], sources: [] },
    scopes: [],
    endpoints: [],
    sessions: { archived: [], sessionEndpoints: {}, continuedFrom: {}, removedEndpoints: {} },
    ...over
  }
}

function scope(over: Partial<ScopeRecord> = {}): ScopeRecord {
  return { ref: 'global', root: null, library: [], skills: {}, ...over }
}

const ctx = (over: Partial<Parameters<typeof planRestore>[2]> = {}): Parameters<typeof planRestore>[2] => ({
  knownRepos: new Map(),
  knownRoots: new Set(),
  home: '/Users/me',
  hasSkill: () => false,
  dirExists: () => true,
  secrets: null,
  ...over
})

const secrets = (over: Partial<Secrets> = {}): Secrets => ({
  scopes: [],
  endpointHeaders: {},
  endpointKeys: {},
  ...over
})

describe('sealing secrets', () => {
  const payload = secrets({ endpointKeys: { e1: 'sk-live-123' } })

  it('round-trips through a passphrase', () => {
    const sealed = seal(payload, 'correct horse battery', aadFor(header))
    expect(sealed.data).not.toContain('sk-live')
    expect(unseal(sealed, 'correct horse battery', aadFor(header))).toEqual(payload)
  })

  it('refuses a short passphrase', () => {
    expect(() => seal(payload, 'short', aadFor(header))).toThrow(/at least 8/)
  })

  it('fails the same way for a wrong passphrase and for a tampered file', () => {
    const sealed = seal(payload, 'correct horse battery', aadFor(header))
    expect(() => unseal(sealed, 'wrong horse battery', aadFor(header))).toThrow(
      /wrong passphrase or damaged backup/
    )
    const flipped = { ...sealed, data: Buffer.from('not the same bytes').toString('base64') }
    expect(() => unseal(flipped, 'correct horse battery', aadFor(header))).toThrow(
      /wrong passphrase or damaged backup/
    )
  })

  it('will not open against another bundle header', () => {
    const sealed = seal(payload, 'correct horse battery', aadFor(header))
    expect(() =>
      unseal(sealed, 'correct horse battery', aadFor({ ...header, createdAt: '2020-01-01T00:00:00.000Z' }))
    ).toThrow(/wrong passphrase or damaged backup/)
  })
})

describe('splitSecrets', () => {
  const mcp: LibraryEntry = {
    kind: 'mcp',
    name: 'github',
    enabled: { claude: true },
    config: { command: 'npx', args: ['-y', 'server'], env: { GITHUB_TOKEN: 'ghp_secret' } }
  }
  const endpoint: ModelEndpoint = {
    id: 'e1',
    label: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    hasKey: true,
    headers: { 'x-tenant': 'acme' }
  }

  it('drops env values and records what is missing when there is no passphrase', () => {
    const out = splitSecrets([scope({ library: [mcp] })], [endpoint], {
      sealed: false,
      keyFor: () => 'sk-live-123'
    })
    const entry = out.scopes[0].library[0]
    expect(entry.config?.env).toBeUndefined()
    expect(entry.config?.command).toBe('npx')
    expect(entry.withheld).toEqual(['GITHUB_TOKEN'])
    expect(out.endpoints[0].headers).toBeUndefined()
    expect(out.endpoints[0].hasKey).toBeUndefined()
    expect(out.withheld).toEqual([
      'github (GITHUB_TOKEN)',
      'Groq (API key)',
      'Groq (x-tenant)'
    ])
    expect(JSON.stringify(out.scopes)).not.toContain('ghp_secret')
  })

  it('moves everything secret into the sealed half when there is one', () => {
    const out = splitSecrets([scope({ library: [mcp] })], [endpoint], {
      sealed: true,
      keyFor: () => 'sk-live-123'
    })
    expect(out.scopes[0].library[0].config).toEqual({ command: 'npx' })
    expect(out.scopes[0].library[0].withheld).toBeUndefined()
    expect(out.secrets.scopes[0].github).toEqual({
      env: { GITHUB_TOKEN: 'ghp_secret' },
      args: ['-y', 'server'],
      url: undefined
    })
    expect(out.secrets.endpointKeys).toEqual({ e1: 'sk-live-123' })
    expect(out.secrets.endpointHeaders).toEqual({ e1: { 'x-tenant': 'acme' } })
    expect(out.withheld).toEqual([])
  })
})

describe('sanitizeBundle', () => {
  const raw = (over: Record<string, unknown>): unknown => ({ ...bundle(), ...over })

  it('rejects anything that is not this format and version', () => {
    expect(() => sanitizeBundle({ format: 'something-else' })).toThrow(/not a Cockpit backup/)
    expect(() => sanitizeBundle(raw({ version: 99 }))).toThrow(/version 99/)
  })

  it('drops skill files that try to escape their folder', () => {
    const out = sanitizeBundle(
      raw({
        scopes: [
          scope({
            skills: {
              review: {
                'SKILL.md': { data: 'aGk=' },
                '../evil.sh': { data: 'aGk=' },
                '/etc/passwd': { data: 'aGk=' },
                'nested/../../out.txt': { data: 'aGk=' }
              }
            }
          })
        ]
      })
    )
    expect(Object.keys(out.scopes[0].skills.review)).toEqual(['SKILL.md'])
  })

  it('drops entries whose name could be read as a CLI flag', () => {
    const out = sanitizeBundle(
      raw({
        scopes: [
          scope({
            library: [
              { kind: 'plugin', name: '--version', enabled: {} },
              { kind: 'marketplace', name: 'shop', enabled: {}, source: '--upload-pack=evil' },
              { kind: 'skill', name: 'review', enabled: { claude: true, nope: true } }
            ] as unknown as LibraryEntry[]
          })
        ]
      })
    )
    const entries = out.scopes[0].library
    expect(entries.map((e) => e.name)).toEqual(['shop', 'review'])
    expect(entries[0].source).toBeUndefined()
    expect(entries[1].enabled).toEqual({ claude: true })
  })

  it('keeps the instructions entry, whose name is Cockpit’s own', () => {
    const out = sanitizeBundle(
      raw({
        scopes: [scope({ library: [{ kind: 'instructions', name: 'Shared baseline', enabled: {} }] })]
      })
    )
    expect(out.scopes[0].library[0].name).toBe('Shared baseline')
  })

  it('drops plugins and marketplaces from a repo scope, and unknown source providers', () => {
    const out = sanitizeBundle(
      raw({
        scopes: [
          scope({
            ref: 'gh:owner/repo',
            root: '/elsewhere/repo',
            library: [
              { kind: 'plugin', name: 'thing', enabled: {} },
              { kind: 'skill', name: 'review', enabled: {} }
            ]
          })
        ],
        settings: {
          hiddenRepos: [],
          sources: [
            { path: '/x/.claude', provider: 'claude', label: 'a' },
            { path: '/x/.hack', provider: 'hacker', label: 'b' }
          ]
        }
      })
    )
    expect(out.scopes[0].library.map((e) => e.kind)).toEqual(['skill'])
    expect(out.settings.sources).toEqual([{ path: '/x/.claude', provider: 'claude', label: 'a' }])
  })

  it('refuses a secrets block it cannot read', () => {
    expect(() => sanitizeBundle(raw({ secrets: { kdf: 'argon2', data: 'x' } }))).toThrow(
      /secrets block/
    )
  })
})

describe('planRestore', () => {
  const local: AppConfig = { sources: [], archived: [] }

  it('adds library entries that are missing and leaves local ones alone', () => {
    const mine: LibraryEntry = { kind: 'skill', name: 'review', enabled: { claude: true } }
    const theirs: LibraryEntry = { kind: 'skill', name: 'plan', enabled: { codex: true } }
    const plan = planRestore(
      { ...local, library: { global: [mine] } },
      bundle({
        scopes: [
          scope({
            library: [{ ...mine, enabled: {} }, theirs],
            skills: { plan: { 'SKILL.md': { data: 'aGk=' } }, review: { 'SKILL.md': { data: 'aGk=' } } }
          })
        ]
      }),
      ctx()
    )
    expect(plan.config.library?.global).toEqual([mine, theirs])
    expect(plan.skillWrites.map((w) => w.name)).toEqual(['plan'])
    expect(plan.summary.added.entries).toBe(1)
  })

  it('never writes a skill this machine already has', () => {
    const plan = planRestore(
      local,
      bundle({
        scopes: [
          scope({
            library: [{ kind: 'skill', name: 'review', enabled: {} }],
            skills: { review: { 'SKILL.md': { data: 'aGk=' } } }
          })
        ]
      }),
      ctx({ hasSkill: () => true })
    )
    expect(plan.skillWrites).toEqual([])
  })

  it('takes instructions only when there are none here, and reports the ones it kept', () => {
    const empty = planRestore(local, bundle({ scopes: [scope({ instructions: 'theirs' })] }), ctx())
    expect(empty.config.sharedInstructions?.global).toBe('theirs')
    expect(empty.summary.added.instructions).toBe(1)

    const mine = planRestore(
      { ...local, sharedInstructions: { global: 'mine' } },
      bundle({ scopes: [scope({ instructions: 'theirs' })] }),
      ctx()
    )
    expect(mine.config.sharedInstructions?.global).toBe('mine')
    expect(mine.summary.kept).toEqual(["instructions for global — kept yours (the backup's differ)"])
  })

  it('lands a repo scope on the checkout it came from, and skips repos that are not here', () => {
    const b = bundle({
      scopes: [
        scope({ ref: 'gh:owner/repo', root: '/old/repo', library: [{ kind: 'skill', name: 'x', enabled: {} }] }),
        scope({ ref: 'gh:owner/gone', root: '/old/gone', library: [] })
      ]
    })
    const here = planRestore(
      local,
      b,
      ctx({ knownRepos: new Map([['gh:owner/repo', '/here/repo']]), knownRoots: new Set(['/here/repo']) })
    )
    expect(Object.keys(here.config.library?.repos ?? {})).toEqual(['/here/repo'])
    expect(here.summary.skipped).toEqual(['gh:owner/gone — not on this machine'])

    const sameMachine = planRestore(
      local,
      b,
      ctx({
        knownRepos: new Map([['gh:owner/repo', '/here/repo']]),
        knownRoots: new Set(['/here/repo', '/old/repo'])
      })
    )
    expect(Object.keys(sameMachine.config.library?.repos ?? {})).toEqual(['/old/repo'])
  })

  it('carries an mcp entry’s sealed values back into its config', () => {
    const plan = planRestore(
      local,
      bundle({
        scopes: [
          scope({ library: [{ kind: 'mcp', name: 'github', enabled: {}, config: { command: 'npx' } }] })
        ]
      }),
      ctx({ secrets: secrets({ scopes: [{ github: { env: { GITHUB_TOKEN: 'ghp' } } }] }) })
    )
    expect(plan.config.library?.global?.[0].config).toEqual({
      command: 'npx',
      env: { GITHUB_TOKEN: 'ghp' }
    })
  })

  it('reports an mcp restored without its values', () => {
    const plan = planRestore(
      local,
      bundle({
        scopes: [
          scope({
            library: [
              { kind: 'mcp', name: 'github', enabled: {}, config: { command: 'npx' }, withheld: ['GITHUB_TOKEN'] }
            ]
          })
        ]
      }),
      ctx()
    )
    expect(plan.summary.needsValues).toEqual(['github in global — GITHUB_TOKEN'])
  })

  it('keeps an endpoint id, so a same-machine restore keeps its session bindings', () => {
    const ep: ModelEndpoint = { id: 'e1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1' }
    const b = bundle({
      endpoints: [ep],
      sessions: { archived: [], sessionEndpoints: { 'claude:s1': 'e1' }, continuedFrom: {}, removedEndpoints: {} }
    })
    const fresh = planRestore(local, b, ctx())
    expect(fresh.config.modelEndpoints?.[0].id).toBe('e1')
    expect(fresh.config.sessionEndpoints).toEqual({ 'claude:s1': 'e1' })

    // the same id locally is the same provider, renamed — not a second one
    const renamed = planRestore(
      { ...local, modelEndpoints: [{ ...ep, label: 'Groq (work)' }] },
      b,
      ctx()
    )
    expect(renamed.config.modelEndpoints?.map((e) => e.label)).toEqual(['Groq (work)'])
    expect(renamed.summary.added.endpoints).toBe(0)
  })

  it('dedupes an endpoint by label and base url, ignoring a trailing slash', () => {
    const plan = planRestore(
      { ...local, modelEndpoints: [{ id: 'local-1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1/' }] },
      bundle({
        endpoints: [{ id: 'e1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1' }],
        sessions: { archived: [], sessionEndpoints: { 'claude:s1': 'e1' }, continuedFrom: {}, removedEndpoints: {} }
      }),
      ctx()
    )
    expect(plan.config.modelEndpoints).toHaveLength(1)
    expect(plan.config.sessionEndpoints).toEqual({ 'claude:s1': 'local-1' })
    expect(plan.summary.added.endpoints).toBe(0)
  })

  it('clears a tombstone under an id it restores, so nothing can reclaim it', () => {
    const plan = planRestore(
      { ...local, removedEndpoints: { e1: 'Groq' } },
      bundle({ endpoints: [{ id: 'e1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1' }] }),
      ctx()
    )
    expect(plan.config.removedEndpoints).toEqual({})
  })

  it('writes the keys it was given and asks for the ones it was not', () => {
    const b = bundle({ endpoints: [{ id: 'e1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1' }] })
    const sealed = planRestore(local, b, ctx({ secrets: secrets({ endpointKeys: { e1: 'sk-1' } }) }))
    expect(sealed.keyWrites).toEqual([{ id: 'e1', key: 'sk-1' }])
    expect(sealed.config.modelEndpoints?.[0].hasKey).toBe(true)
    expect(sealed.summary.needsValues).toEqual([])

    const bare = planRestore(local, b, ctx())
    expect(bare.keyWrites).toEqual([])
    expect(bare.config.modelEndpoints?.[0].hasKey).toBeUndefined()
    expect(bare.summary.needsValues).toEqual(['Groq — API key'])
  })

  it('unions the session maps with the local value winning', () => {
    const plan = planRestore(
      { ...local, archived: ['a'], continuedFrom: { s1: 'mine' } },
      bundle({
        sessions: {
          archived: ['b'],
          sessionEndpoints: {},
          continuedFrom: { s1: 'theirs', s2: 'theirs' },
          removedEndpoints: {}
        }
      }),
      ctx()
    )
    expect(plan.config.archived?.sort()).toEqual(['a', 'b'])
    expect(plan.config.continuedFrom).toEqual({ s1: 'mine', s2: 'theirs' })
  })

  it('rewrites source paths from the backup’s home, and skips ones that are not here', () => {
    const plan = planRestore(
      local,
      bundle({
        home: '/Users/someone',
        settings: {
          hiddenRepos: ['gh:owner/repo'],
          sources: [
            { path: '/Users/someone/.claude', provider: 'claude', label: 'claude-default' },
            { path: '/Volumes/gone/.codex', provider: 'codex', label: 'codex' }
          ]
        }
      }),
      ctx({ dirExists: (p) => p === '/Users/me/.claude' })
    )
    expect(plan.config.sources).toEqual([
      { path: '/Users/me/.claude', provider: 'claude', label: 'claude-default' }
    ])
    expect(plan.config.hiddenRepos).toEqual(['gh:owner/repo'])
    expect(plan.summary.skipped).toEqual(['source /Volumes/gone/.codex — not on this machine'])
  })

  it('changes nothing the second time the same file is restored', () => {
    const b = bundle({
      scopes: [scope({ instructions: 'theirs', library: [{ kind: 'skill', name: 'plan', enabled: {} }] })],
      endpoints: [{ id: 'e1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1' }]
    })
    const first = planRestore(local, b, ctx())
    const second = planRestore(first.config, b, ctx({ hasSkill: () => true }))
    expect(second.config).toEqual(first.config)
    expect(second.summary.added).toEqual({
      entries: 0,
      skills: 0,
      endpoints: 0,
      sources: 0,
      instructions: 0
    })
  })
})
