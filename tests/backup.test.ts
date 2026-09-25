import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  previewOf,
  readBackup,
  restoreBackup,
  undoRestore,
  writeBackup,
  type KeyStore,
  type RestoreDeps
} from '../src/main/backup'
import { loadConfig, saveConfig, type AppConfig } from '../src/main/config'
import { getPanel } from '../src/main/library'
import { saveBaseline } from '../src/main/instructions'

/*
 * The whole round trip on real disk: a throwaway HOME for the agents' own skill
 * folders and a throwaway userData per machine, so "export here, restore there"
 * is two directories rather than a mock.
 */

let root = ''
let home = ''
let fileDir = ''
const realHome = process.env.HOME
const realUserData = process.env.COCKPIT_USER_DATA
const roots: string[] = []

/** A keychain that lives in a Map — safeStorage has no runtime under vitest. */
function memoryKeys(initial: Record<string, string> = {}): KeyStore & { all: Map<string, string> } {
  const all = new Map(Object.entries(initial))
  return {
    all,
    get: (id) => all.get(id),
    set: (id, key) => {
      all.set(id, key)
    },
    remove: (id) => {
      all.delete(id)
    }
  }
}

function useMachine(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  process.env.COCKPIT_USER_DATA = dir
  return dir
}

const exportDeps = (keys: KeyStore) => ({
  keys,
  refFor: (repoRoot: string) => (repoRoot === '/work/cockpit' ? 'gh:tashtit/cockpit' : repoRoot),
  appVersion: '1.2.3'
})

function restoreDeps(keys: KeyStore, repos: ReadonlyMap<string, string> = new Map()): RestoreDeps {
  return {
    keys,
    knownRepos: () => repos,
    syncSources: async () => {}
  }
}

function seedSkill(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body}\n---\n`)
}

function config(over: Partial<AppConfig> = {}): AppConfig {
  return { sources: [], archived: [], ...over }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-backup-'))
  roots.push(root)
  home = join(root, 'home')
  fileDir = join(root, 'files')
  mkdirSync(home, { recursive: true })
  mkdirSync(fileDir, { recursive: true })
  process.env.HOME = home
  useMachine('machine-a')
})

afterEach(() => {
  process.env.HOME = realHome
  if (realUserData === undefined) delete process.env.COCKPIT_USER_DATA
  else process.env.COCKPIT_USER_DATA = realUserData
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('export', () => {
  it('writes a readable file the owner alone can read', () => {
    saveConfig(config({ timeFormat: '12h' }))
    const path = join(fileDir, 'backup.json')
    const res = writeBackup(path, exportDeps(memoryKeys()))

    expect(res.path).toBe(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readBackup(path).settings.timeFormat).toBe('12h')
    expect(readdirSync(fileDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('carries a skill’s files, executable bits and all', () => {
    const skills = join(home, '.claude', 'skills')
    seedSkill(skills, 'review', 'review a diff')
    writeFileSync(join(skills, 'review', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
    saveConfig(config({ library: { global: [{ kind: 'skill', name: 'review', enabled: { claude: true } }] } }))

    const bundle = readBackup(writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys())).path)
    const files = bundle.scopes[0].skills.review
    expect(Object.keys(files).sort()).toEqual(['SKILL.md', 'run.sh'])
    expect(files['run.sh'].exec).toBe(true)
    expect(Buffer.from(files['SKILL.md'].data, 'base64').toString()).toContain('review a diff')
  })

  it('counts a key it cannot read rather than dropping it in silence', () => {
    saveConfig(
      config({
        modelEndpoints: [
          { id: 'e1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1', hasKey: true }
        ]
      })
    )
    const res = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys()))
    expect(res.unreadableKeys).toBe(1)
    expect(res.withheld).toEqual(['Groq (API key)'])
  })

  it('refuses a passphrase too short to be worth having', () => {
    saveConfig(config())
    expect(() => writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys()), 'short')).toThrow(
      /at least 8/
    )
  })
})

describe('restore', () => {
  it('rebuilds another machine: settings, entries, skills and the keys', async () => {
    seedSkill(join(home, '.claude', 'skills'), 'review', 'review a diff')
    saveConfig(
      config({
        timeFormat: '12h',
        historyDays: 30,
        sharedInstructions: { global: '# be brief' },
        library: {
          global: [
            { kind: 'skill', name: 'review', enabled: { claude: true } },
            { kind: 'mcp', name: 'github', enabled: { claude: true }, config: { command: 'npx', env: { TOKEN: 'ghp' } } }
          ]
        },
        modelEndpoints: [
          { id: 'e1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1', hasKey: true }
        ]
      })
    )
    const keysA = memoryKeys({ e1: 'sk-live' })
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(keysA), 'correct horse battery').path

    // second machine: nothing of its own, and no agent holding that skill
    useMachine('machine-b')
    rmSync(join(home, '.claude'), { recursive: true, force: true })
    saveConfig(config())
    const keysB = memoryKeys()
    const summary = await restoreBackup(readBackup(path), restoreDeps(keysB), 'correct horse battery')

    const after = loadConfig()
    expect(after.timeFormat).toBe('12h')
    expect(after.historyDays).toBe(30)
    expect(after.sharedInstructions?.global).toBe('# be brief')
    expect(after.library?.global?.map((e) => e.name).sort()).toEqual(['github', 'review'])
    expect(after.library?.global?.find((e) => e.name === 'github')?.config?.env).toEqual({ TOKEN: 'ghp' })
    expect(keysB.all.get('e1')).toBe('sk-live')
    expect(after.modelEndpoints?.[0].hasKey).toBe(true)
    expect(summary.added.skills).toBe(1)
    expect(summary.needsValues).toEqual([])

    // the skill is Cockpit's to write now: the panel shows it as pending, not gone
    const row = getPanel(null).rows.find((r) => r.name === 'review')
    expect(row?.cells.claude.state).toBe('pending')
    expect(row?.saved.detail).toBe('review a diff')
  })

  it('marks an mcp restored from a passphrase-less backup as needing its values', async () => {
    saveConfig(
      config({
        library: {
          global: [
            { kind: 'mcp', name: 'github', enabled: { claude: true }, config: { command: 'npx', env: { TOKEN: 'ghp' } } }
          ]
        }
      })
    )
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys())).path
    expect(readFileSync(path, 'utf8')).not.toContain('ghp')

    useMachine('machine-b')
    saveConfig(config())
    const summary = await restoreBackup(readBackup(path), restoreDeps(memoryKeys()))
    expect(summary.needsValues).toEqual(['github in global — TOKEN'])
    expect(loadConfig().library?.global?.[0].withheld).toEqual(['TOKEN'])
  })

  it('refuses a sealed backup without its passphrase, and keeps the config untouched', async () => {
    saveConfig(config({ timeFormat: '12h' }))
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys()), 'correct horse battery').path

    useMachine('machine-b')
    saveConfig(config())
    const bundle = readBackup(path)
    await expect(restoreBackup(bundle, restoreDeps(memoryKeys()))).rejects.toThrow(/sealed/)
    await expect(restoreBackup(bundle, restoreDeps(memoryKeys()), 'wrong one entirely')).rejects.toThrow(
      /wrong passphrase/
    )
    expect(loadConfig().timeFormat).toBeUndefined()
  })

  it('refuses to build on a config it cannot read', async () => {
    saveConfig(config())
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys())).path
    const userData = useMachine('machine-b')
    writeFileSync(join(userData, 'cockpit-config.json'), '{ this is not json')
    await expect(restoreBackup(readBackup(path), restoreDeps(memoryKeys()))).rejects.toThrow(
      /unreadable/
    )
  })

  it('is a no-op the second time the same file is restored', async () => {
    seedSkill(join(home, '.claude', 'skills'), 'review', 'review a diff')
    saveConfig(config({ library: { global: [{ kind: 'skill', name: 'review', enabled: { claude: true } }] } }))
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys())).path

    useMachine('machine-b')
    rmSync(join(home, '.claude'), { recursive: true, force: true })
    saveConfig(config())
    await restoreBackup(readBackup(path), restoreDeps(memoryKeys()))
    const afterFirst = loadConfig()
    const second = await restoreBackup(readBackup(path), restoreDeps(memoryKeys()))
    expect(loadConfig()).toEqual(afterFirst)
    expect(second.added).toEqual({ entries: 0, skills: 0, endpoints: 0, sources: 0, instructions: 0 })
  })

  it('keeps local instructions and reports them, rather than replacing them', async () => {
    saveConfig(config())
    saveBaseline(null, '# theirs')
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys())).path

    useMachine('machine-b')
    saveConfig(config())
    saveBaseline(null, '# mine')
    const summary = await restoreBackup(readBackup(path), restoreDeps(memoryKeys()))
    expect(loadConfig().sharedInstructions?.global).toBe('# mine')
    expect(summary.kept).toEqual(["instructions for global — kept yours (the backup's differ)"])
  })

  it('lands a repo scope on the matching checkout here, and skips the rest', async () => {
    saveConfig(
      config({
        sharedInstructions: { repos: { '/work/cockpit': '# repo rules' } },
        library: { repos: { '/work/cockpit': [{ kind: 'skill', name: 'plan', enabled: {} }] } }
      })
    )
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys())).path

    useMachine('machine-b')
    saveConfig(config())
    const here = join(root, 'checkouts', 'cockpit')
    mkdirSync(here, { recursive: true })
    const summary = await restoreBackup(
      readBackup(path),
      restoreDeps(memoryKeys(), new Map([['gh:tashtit/cockpit', here]]))
    )
    expect(loadConfig().sharedInstructions?.repos).toEqual({ [here]: '# repo rules' })
    expect(summary.skipped).toEqual([])

    useMachine('machine-c')
    saveConfig(config())
    const none = await restoreBackup(readBackup(path), restoreDeps(memoryKeys()))
    expect(none.skipped).toEqual(['gh:tashtit/cockpit — not on this machine'])
  })
})

describe('undo', () => {
  it('puts the config, the keys and the skill copies back', async () => {
    seedSkill(join(home, '.claude', 'skills'), 'review', 'review a diff')
    saveConfig(
      config({
        library: { global: [{ kind: 'skill', name: 'review', enabled: { claude: true } }] },
        modelEndpoints: [{ id: 'e1', label: 'Groq', type: 'openai', baseUrl: 'https://groq/v1', hasKey: true }]
      })
    )
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys({ e1: 'sk-live' })), 'correct horse battery').path

    useMachine('machine-b')
    rmSync(join(home, '.claude'), { recursive: true, force: true })
    saveConfig(config({ timeFormat: '12h' }))
    const keys = memoryKeys()
    const summary = await restoreBackup(readBackup(path), restoreDeps(keys), 'correct horse battery')
    expect(summary.undoId).not.toBeNull()
    const written = summary.added.skills

    undoRestore(summary.undoId as string, keys)

    const after = loadConfig()
    expect(after.library).toBeUndefined()
    expect(after.modelEndpoints).toBeUndefined()
    expect(after.timeFormat).toBe('12h')
    expect(keys.all.size).toBe(0)
    expect(written).toBe(1)
    // nothing restored is left — only the marketplace every library is offered, on nowhere
    const rows = getPanel(null).rows
    expect(rows.map((r) => r.id)).toEqual(['marketplace:tashtit'])
    expect(rows[0].holders).toEqual([])
  })

  it('refuses once something else has written to the config', async () => {
    saveConfig(config())
    const path = writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys())).path
    useMachine('machine-b')
    saveConfig(config())
    const keys = memoryKeys()
    const summary = await restoreBackup(readBackup(path), restoreDeps(keys), undefined)
    saveConfig({ ...loadConfig(), historyDays: 7 })
    expect(() => undoRestore(summary.undoId as string, keys)).toThrow(/have changed since/)
    expect(loadConfig().historyDays).toBe(7)
  })
})

describe('preview', () => {
  it('says what the file holds, what it cannot place, and what it would run', () => {
    saveConfig(
      config({
        library: {
          global: [{ kind: 'mcp', name: 'github', enabled: {}, config: { command: 'npx' } }],
          repos: { '/work/cockpit': [{ kind: 'skill', name: 'plan', enabled: {} }] }
        }
      })
    )
    const bundle = readBackup(writeBackup(join(fileDir, 'b.json'), exportDeps(memoryKeys()), 'correct horse battery').path)

    const preview = previewOf(bundle, 'tok', new Map())
    expect(preview.sealed).toBe(true)
    expect(preview.commands).toEqual(['npx'])
    expect(preview.unmatched).toEqual(['gh:tashtit/cockpit'])
    expect(preview.counts.entries).toBe(2)
  })

  it('rejects a file that is not a backup at all', () => {
    const path = join(fileDir, 'notes.json')
    writeFileSync(path, '{"hello":"world"}')
    expect(() => readBackup(path)).toThrow(/not a Cockpit backup/)
    writeFileSync(path, 'nope')
    expect(() => readBackup(path)).toThrow(/not valid JSON/)
  })
})
