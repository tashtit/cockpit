import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getExtensions, parseCodexSections, shareSkill } from '../src/main/extensions'

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
