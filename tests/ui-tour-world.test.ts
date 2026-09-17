import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { listClaudeSessions } from '../src/main/parsers/claude'
import { listCodexSessions } from '../src/main/parsers/codex'
import { listCopilotSessions } from '../src/main/parsers/copilot'
import { sanitizeRoundtable } from '../src/main/roundtable-core'
import { buildWorld, type World } from '../scripts/ui-tour/world.mts'

/**
 * The ui-tour renders whatever the app makes of this world. If a provider's log format
 * drifts, the tour would quietly screenshot empty views — so the world is parsed here
 * with the real parsers, and the states the tour depends on are asserted to exist.
 */
let scratch: string
let world: World

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'cockpit-tour-world-'))
  world = buildWorld(join(scratch, 'world'))
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('ui-tour fixture world', () => {
  it('gives every agent sessions the real parsers can read', () => {
    const claude = listClaudeSessions(join(world.home, '.claude'), 'claude-default')
    const work = listClaudeSessions(join(world.home, '.claude-work'), 'claude-work')
    const codex = listCodexSessions(join(world.home, '.codex'), 'codex-default')
    const copilot = listCopilotSessions(join(world.home, '.copilot'), 'copilot-default')
    expect(claude.length).toBeGreaterThanOrEqual(10)
    expect(work).toHaveLength(1)
    expect(codex.length).toBeGreaterThanOrEqual(4)
    expect(copilot.length).toBeGreaterThanOrEqual(3)
    // the tour opens these by title — a parser that stops reading titles breaks it
    expect(claude.map((s) => s.title)).toContain('Fix the login flake in CI')
    expect(copilot.map((s) => s.title)).toContain('Tidy the usage panel spacing')
  })

  it('has stale work for Cleanup and recent work for the board', () => {
    const all = [
      ...listClaudeSessions(join(world.home, '.claude'), 'claude-default'),
      ...listCodexSessions(join(world.home, '.codex'), 'codex-default'),
      ...listCopilotSessions(join(world.home, '.copilot'), 'copilot-default')
    ]
    const day = 24 * 60 * 60 * 1000
    expect(all.some((s) => Date.now() - s.updatedAt > 30 * day)).toBe(true)
    expect(all.filter((s) => Date.now() - s.updatedAt < day).length).toBeGreaterThanOrEqual(8)
  })

  it('builds real repositories with cockpit worktrees', () => {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: join(world.home, 'code', 'rocket') }).toString()
    expect(list).toContain('branch refs/heads/cockpit/login-retry-flake')
    expect(list).toContain(join(world.userData, 'worktrees', 'rocket'))
  })

  it('seeds roundtables the app will load, and archives one of them in config', () => {
    const dir = join(world.userData, 'roundtables')
    const tables = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => sanitizeRoundtable(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
    expect(tables.every(Boolean)).toBe(true)
    expect(tables.map((t) => t?.mode).sort()).toEqual(['consensus', 'open', 'open'])
    // one is archived in cockpit's own config, so the tree's Archived list has something
    const cfg = JSON.parse(readFileSync(join(world.userData, 'cockpit-config.json'), 'utf8'))
    expect(cfg.archivedRoundtables).toEqual(['rt-archived'])
    expect(tables.some((t) => t?.id === 'rt-archived')).toBe(true)
  })

  it('puts a runnable stub first on PATH for every CLI the app spawns', () => {
    for (const tool of ['claude', 'codex', 'copilot', 'gh']) {
      const path = join(world.bin, tool)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).mode & 0o111).not.toBe(0)
    }
    const login = execFileSync(join(world.bin, 'gh'), ['api', 'user', '-q', '.login'], {
      env: { ...process.env, HOME: world.home }
    })
    expect(login.toString().trim()).toBe('octo-dev')
  })

  it('builds an empty home for the first-run tour', () => {
    const empty = buildWorld(join(scratch, 'empty'), { populated: false })
    expect(readdirSync(empty.home)).toEqual(['.gitconfig'])
    expect(existsSync(join(empty.userData, 'cockpit-config.json'))).toBe(false)
  })
})
