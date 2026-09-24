import { describe, it, expect, afterEach } from 'vitest'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adoptSkillInto,
  getExtensions,
  parseCodexSections,
  readExtensions,
  removeMcp,
  shareMcp,
  shareSkill
} from '../src/main/extensions'
import { parseCodexMcpToml } from '../src/main/extensions-core'

/*
 * Real fixtures on disk, like the indexer tests: each agent's own layout is written
 * into a throwaway HOME and read back through getExtensions(). Node's homedir()
 * follows $HOME on POSIX, which is what lets the whole inventory be exercised.
 */

const homes: string[] = []
const realHome = process.env.HOME

afterEach(() => {
  process.env.HOME = realHome
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

function write(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

function skill(home: string, agentDir: string, name: string, description: string): void {
  write(join(home, agentDir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`)
}

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'cockpit-ext-'))
  homes.push(home)
  process.env.HOME = home
  return home
}

describe('parseCodexSections', () => {
  it('reads quoted plugin ids and bare marketplace names with their fields', () => {
    const toml = [
      '[marketplaces.tashtit]',
      'source_type = "git"',
      'source = "https://github.com/tashtit/marketplace.git"',
      '',
      '[plugins."git-workflow@tashtit"]',
      'enabled = true',
      '',
      '[mcp_servers.other]',
      'command = "x"'
    ].join('\n')
    expect([...parseCodexSections(toml, 'marketplaces').keys()]).toEqual(['tashtit'])
    expect(parseCodexSections(toml, 'marketplaces').get('tashtit')).toMatchObject({
      source: 'https://github.com/tashtit/marketplace.git'
    })
    expect([...parseCodexSections(toml, 'plugins').keys()]).toEqual(['git-workflow@tashtit'])
    expect(parseCodexSections(toml, 'plugins').get('git-workflow@tashtit')).toMatchObject({
      enabled: 'true'
    })
  })

  // [marketplaces.a.b] is a subtable of one marketplace, never a second marketplace
  it('ignores nested subtables and unrelated sections', () => {
    const toml = '[marketplaces.a]\nsource = "x"\n\n[marketplaces.a.auth]\ntoken = "t"\n\n[features]\njs = false\n'
    expect([...parseCodexSections(toml, 'marketplaces').keys()]).toEqual(['a'])
  })

  it('tolerates empty and non-TOML input', () => {
    expect(parseCodexSections('', 'plugins').size).toBe(0)
    expect(parseCodexSections('nonsense', 'plugins').size).toBe(0)
  })
})

describe('getExtensions — skills', () => {
  it('reads personal skills from all three agent homes', () => {
    const home = fakeHome()
    skill(home, '.claude', 'review', 'review a diff')
    skill(home, '.codex', 'review', 'review a diff')
    skill(home, '.copilot', 'deploy', 'ship it')
    const skills = getExtensions().skills
    expect(skills.map((s) => `${s.agent}:${s.name}`).sort()).toEqual([
      'claude:review',
      'codex:review',
      'copilot:deploy'
    ])
    expect(skills.find((s) => s.agent === 'claude')?.description).toBe('review a diff')
  })

  it('fingerprints identical SKILL.md files the same and edited ones differently', () => {
    const home = fakeHome()
    skill(home, '.claude', 'review', 'review a diff')
    skill(home, '.codex', 'review', 'review a diff')
    skill(home, '.copilot', 'review', 'review a diff, but differently')
    const byAgent = new Map(getExtensions().skills.map((s) => [s.agent, s.fingerprint]))
    expect(byAgent.get('claude')).toBe(byAgent.get('codex'))
    expect(byAgent.get('claude')).not.toBe(byAgent.get('copilot'))
  })

  it('skips a directory with no SKILL.md', () => {
    const home = fakeHome()
    mkdirSync(join(home, '.claude', 'skills', 'not-a-skill'), { recursive: true })
    expect(getExtensions().skills).toEqual([])
  })
})

describe('getExtensions — plugins and marketplaces', () => {
  function threeAgentHome(): string {
    const home = fakeHome()
    write(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: { 'git-workflow@tashtit': [{ scope: 'user', version: '0.1.0' }] }
      })
    )
    write(
      join(home, '.claude', 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        marketplaces: {
          tashtit: { source: { source: 'git', url: 'https://github.com/tashtit/marketplace.git' } }
        }
      })
    )
    write(
      join(home, '.codex', 'config.toml'),
      '[marketplaces.tashtit]\nsource = "https://github.com/tashtit/marketplace.git"\n\n[plugins."git-workflow@tashtit"]\nenabled = true\n'
    )
    write(
      join(home, '.copilot', 'installed-plugins', 'tashtit', 'git-workflow', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'git-workflow', version: '0.1.0' })
    )
    return home
  }

  it('reads the same plugin id out of all three agents', () => {
    threeAgentHome()
    const plugins = getExtensions().plugins
    expect(plugins.map((p) => p.agent).sort()).toEqual(['claude', 'codex', 'copilot'])
    expect(plugins.every((p) => p.name === 'git-workflow@tashtit')).toBe(true)
    expect(plugins.find((p) => p.agent === 'copilot')?.version).toBe('0.1.0')
    // codex records no version at all — that absence must not read as "0"
    expect(plugins.find((p) => p.agent === 'codex')?.version).toBeUndefined()
  })

  // copilot's installed-plugins/<marketplace>/<plugin> layout used to be read one
  // level too shallow, listing every marketplace as if it were a plugin
  it('does not mistake a copilot marketplace directory for a plugin', () => {
    threeAgentHome()
    const inv = getExtensions()
    expect(inv.plugins.some((p) => p.name === 'tashtit')).toBe(false)
    expect(inv.marketplaces.filter((m) => m.name === 'tashtit').map((m) => m.agent).sort()).toEqual([
      'claude',
      'codex',
      'copilot'
    ])
  })

  it('reduces claude object-shaped marketplace sources to a URL', () => {
    threeAgentHome()
    const claude = getExtensions().marketplaces.find((m) => m.agent === 'claude')
    expect(claude?.source).toBe('https://github.com/tashtit/marketplace.git')
  })

  it('drops a codex plugin the user switched off', () => {
    const home = fakeHome()
    write(join(home, '.codex', 'config.toml'), '[plugins."off@mp"]\nenabled = false\n')
    expect(getExtensions().plugins).toEqual([])
  })
})

describe('shareSkill', () => {
  it('copies a skill into another agent and refuses to clobber by default', () => {
    const home = fakeHome()
    skill(home, '.claude', 'review', 'review a diff')
    shareSkill('review', 'codex')
    expect(getExtensions().skills.filter((s) => s.name === 'review')).toHaveLength(2)
    expect(() => shareSkill('review', 'codex')).toThrow(/already has/)
  })

  it('replaces the target copy when asked to overwrite', () => {
    const home = fakeHome()
    skill(home, '.claude', 'review', 'the good one')
    skill(home, '.codex', 'review', 'the stale one')
    shareSkill('review', 'codex', { from: 'claude', overwrite: true })
    const codex = getExtensions().skills.find((s) => s.agent === 'codex')
    expect(codex?.description).toBe('the good one')
  })

  it('rejects a name that would escape the skills directory', () => {
    fakeHome()
    expect(() => shareSkill('../../.ssh', 'codex', { from: 'claude' })).toThrow(/invalid skill name/)
  })
})

describe('writing into an agent’s own config', () => {
  it('refuses a config that does not parse, instead of replacing it with one server', () => {
    // one trailing comma: read as empty, ~/.claude.json used to be rewritten as
    // `{ mcpServers: { <new> } }` — the sign-in and every project gone with it
    const home = fakeHome()
    const broken = '{\n  "oauthAccount": { "emailAddress": "me@example.test" },\n  "projects": {},\n}\n'
    write(join(home, '.claude.json'), broken)
    write(join(home, '.copilot', 'mcp-config.json'), '{ "mcpServers": { "keep": { "command": "x" } }, }')
    const cfg = { command: 'npx', args: ['-y', 'some-server'] }
    expect(() => shareMcp('fresh', 'claude', { config: cfg })).toThrow(/isn't valid JSON/)
    expect(() => shareMcp('fresh', 'copilot', { config: cfg })).toThrow(/isn't valid JSON/)
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(broken)
  })

  it('writes through a symlinked config and keeps its mode', () => {
    const home = fakeHome()
    const real = join(home, 'dotfiles', 'claude.json')
    write(real, JSON.stringify({ oauthAccount: { emailAddress: 'me@example.test' } }))
    chmodSync(real, 0o600)
    symlinkSync(real, join(home, '.claude.json'))
    shareMcp('fresh', 'claude', { config: { command: 'npx', args: ['-y', 'x'] } })
    expect(lstatSync(join(home, '.claude.json')).isSymbolicLink()).toBe(true)
    expect(statSync(real).mode & 0o777).toBe(0o600)
    const j = JSON.parse(readFileSync(real, 'utf8'))
    expect(j.oauthAccount.emailAddress).toBe('me@example.test')
    expect(j.mcpServers.fresh).toMatchObject({ command: 'npx' })
  })

  it('writes a Codex env value with a newline as TOML Codex can load, and reads it back whole', () => {
    // a raw newline inside a basic string makes the whole config.toml invalid, and
    // Codex refuses to start until it is fixed by hand
    const home = fakeHome()
    const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----'
    shareMcp('signer', 'codex', { config: { command: 'signer', args: ['a "quoted" \\ arg'], env: { KEY: pem } } })
    const raw = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(raw).not.toContain('abc\n-----END')
    const read = parseCodexMcpToml(raw).get('signer')
    expect(read?.env?.KEY).toBe(pem)
    expect(read?.args).toEqual(['a "quoted" \\ arg'])
  })

  it('reads a server whose fields have the wrong type without breaking the inventory', () => {
    const home = fakeHome()
    write(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { odd: { command: ['npx', 'x'], args: 'nope', env: 'A=1' }, ok: { command: 'npx' } } })
    )
    const inv = getExtensions()
    const odd = inv.mcp.find((s) => s.name === 'odd')?.presences[0]?.config
    expect(odd).toMatchObject({ command: undefined, args: undefined, env: undefined })
    expect(inv.mcp.find((s) => s.name === 'ok')?.presences[0]?.config.command).toBe('npx')
  })

  it('backs a symlinked skill up as a real folder, not as another link', () => {
    // removing a skill everywhere keeps this copy as the only one left — a copied
    // link pointed at the folder the removal was about to delete
    const home = fakeHome()
    skill(home, '.codex', 'shared', 'one folder, two agents')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync(join(home, '.codex', 'skills', 'shared'), join(home, '.claude', 'skills', 'shared'))
    const backup = join(home, 'backup', 'shared')
    adoptSkillInto(join(home, '.claude', 'skills', 'shared'), backup)
    rmSync(join(home, '.codex', 'skills', 'shared'), { recursive: true })
    expect(lstatSync(backup).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(backup, 'SKILL.md'), 'utf8')).toContain('one folder, two agents')
  })
})

describe('writing back what an agent already holds', () => {
  // Cockpit compares command, args, env, url and transport; everything else in a
  // definition is the agent's own, and used to be dropped by every write-back
  const claudeApi = {
    type: 'http',
    url: 'https://mcp.example.dev/v1',
    headers: { Authorization: 'Bearer tok-123' }
  }
  const codexConfig = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.search]',
    'command = "npx"',
    'args = ["-y", "search-mcp@1.2.0"]',
    'env = { "API_KEY" = "sk-live-1" }',
    'startup_timeout_sec = 30',
    'enabled_tools = ["query", "fetch"]',
    '',
    '[profiles.work]',
    'model = "o3"',
    ''
  ].join('\n')
  const copilotSearch = {
    type: 'local',
    command: 'npx',
    args: ['-y', 'search-mcp@1.2.0'],
    env: { API_KEY: 'sk-live-1' },
    tools: ['query']
  }
  const bumped = { command: 'npx', args: ['-y', 'search-mcp@1.3.0'], env: { API_KEY: 'sk-live-1' } }

  function seed(home: string): void {
    write(join(home, '.claude.json'), JSON.stringify({ oauthAccount: {}, mcpServers: { api: claudeApi } }))
    write(join(home, '.codex', 'config.toml'), codexConfig)
    write(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { search: copilotSearch } }))
  }

  const claudeJson = (home: string): any => JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
  const copilotJson = (home: string): any =>
    JSON.parse(readFileSync(join(home, '.copilot', 'mcp-config.json'), 'utf8'))

  it('gives a Claude http server its headers back after it was taken out', () => {
    const home = fakeHome()
    seed(home)
    const read = readExtensions()
    const config = read.mcp.find((s) => s.name === 'api')!.presences[0].config
    const raw = read.mcpRaw.get('api')
    removeMcp('api', 'claude')
    expect(claudeJson(home).mcpServers.api).toBeUndefined()
    shareMcp('api', 'claude', { config, raw, overwrite: true })
    expect(claudeJson(home).mcpServers.api).toEqual(claudeApi)
    expect(claudeJson(home).oauthAccount).toEqual({})
  })

  it('moves only the version in Codex’s inline env server, in place', () => {
    const home = fakeHome()
    seed(home)
    shareMcp('search', 'codex', { config: bumped, overwrite: true })
    const after = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(after).toBe(codexConfig.replace('search-mcp@1.2.0', 'search-mcp@1.3.0'))
    expect(parseCodexMcpToml(after).get('search')?.env).toEqual({ API_KEY: 'sk-live-1' })
  })

  it('gives Codex its own table back after it was taken out, extra keys and all', () => {
    const home = fakeHome()
    seed(home)
    const read = readExtensions()
    const config = read.mcp.find((s) => s.name === 'search')!.presences.find((p) => p.agent === 'codex')!.config
    const raw = read.mcpRaw.get('search')
    removeMcp('search', 'codex')
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).not.toContain('search')
    shareMcp('search', 'codex', { config, raw })
    const after = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(after).toContain('env = { "API_KEY" = "sk-live-1" }\nstartup_timeout_sec = 30\nenabled_tools = ["query", "fetch"]')
    expect(after).toContain('[profiles.work]\nmodel = "o3"')
  })

  it('keeps Copilot’s env and its narrowed tools allowlist', () => {
    const home = fakeHome()
    seed(home)
    shareMcp('search', 'copilot', { config: bumped, overwrite: true })
    expect(copilotJson(home).mcpServers.search).toEqual({ ...copilotSearch, args: ['-y', 'search-mcp@1.3.0'] })
  })

  it('reads each agent’s own definition, but never sends it to the renderer', () => {
    const home = fakeHome()
    seed(home)
    const raw = readExtensions().mcpRaw
    expect(raw.get('api')?.claude).toEqual(claudeApi)
    expect(raw.get('search')?.copilot).toEqual(copilotSearch)
    expect(raw.get('search')?.codex).toContain('startup_timeout_sec = 30')
    const sent = JSON.stringify(getExtensions())
    expect(sent).not.toContain('tok-123')
    expect(sent).not.toContain('startup_timeout_sec')
  })
})
