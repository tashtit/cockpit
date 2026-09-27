import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  controlOf,
  holdRefusal,
  holderOf,
  resumeLine,
  resumeScript,
  sanitizeControlMap,
  withControl,
  type ControlEntry
} from '../src/main/session-control-core'

const worktrees = '/Users/me/Library/Application Support/Cockpit/worktrees'

describe('controlOf', () => {
  it('reads a recorded change of hands first, with when it happened', () => {
    expect(controlOf({ how: 'taken-over', at: 5 }, '/repo', worktrees)).toEqual({
      holder: 'cockpit',
      how: 'taken-over',
      since: 5
    })
    // a session Cockpit started and then released stays released, worktree or not
    expect(controlOf({ how: 'released', at: 9 }, join(worktrees, 'repo', 'task'), worktrees)).toEqual({
      holder: 'agent',
      how: 'released',
      since: 9
    })
  })

  it("counts a session in one of Cockpit's own worktrees as started by it", () => {
    expect(controlOf(undefined, join(worktrees, 'repo', 'task', 'src'), worktrees)).toEqual({
      holder: 'cockpit',
      how: 'started'
    })
  })

  it('leaves everything else with its agent — a sibling path is not inside', () => {
    expect(controlOf(undefined, '/repo', worktrees)).toEqual({ holder: 'agent', how: 'outside' })
    expect(controlOf(undefined, `${worktrees}-old/repo`, worktrees)).toEqual({ holder: 'agent', how: 'outside' })
    expect(controlOf(undefined, null, worktrees)).toEqual({ holder: 'agent', how: 'outside' })
    expect(controlOf(undefined, join(worktrees, 'x'), null)).toEqual({ holder: 'agent', how: 'outside' })
  })

  it('names the holder each change leaves the session with', () => {
    expect(['started', 'taken-over', 'released', 'outside'].map((h) => holderOf(h as never))).toEqual([
      'cockpit',
      'cockpit',
      'agent',
      'agent'
    ])
  })
})

describe('sanitizeControlMap', () => {
  it('keeps well-formed entries in order and drops the rest', () => {
    const raw = {
      'claude:a': { how: 'started', at: 1 },
      'claude:b': { how: 'outside', at: 2 }, // never written — not a change of hands
      'claude:c': { how: 'taken-over', at: -1 },
      'claude:d': { how: 'released' },
      'claude:e': 'released',
      'claude:f': { how: 'released', at: 3, extra: true }
    }
    expect(sanitizeControlMap(raw)).toEqual({
      'claude:a': { how: 'started', at: 1 },
      'claude:f': { how: 'released', at: 3 }
    })
    expect(Object.keys(sanitizeControlMap(raw))).toEqual(['claude:a', 'claude:f'])
  })

  it('reads anything that is not a map as empty', () => {
    expect(sanitizeControlMap(null)).toEqual({})
    expect(sanitizeControlMap([{ how: 'started', at: 1 }])).toEqual({})
    expect(sanitizeControlMap('x')).toEqual({})
  })
})

describe('withControl', () => {
  const map: Record<string, ControlEntry> = {
    'claude:a': { how: 'started', at: 1 },
    'claude:b': { how: 'taken-over', at: 2 }
  }

  it('hands back the same map when nothing changes — claude announces a session twice a turn', () => {
    expect(withControl(map, 'claude:a', { how: 'started', at: 1 }, 10)).toBe(map)
  })

  it('moves a changed entry to the end, so key order stays recency', () => {
    const next = withControl(map, 'claude:a', { how: 'released', at: 3 }, 10)
    expect(Object.keys(next)).toEqual(['claude:b', 'claude:a'])
    expect(next['claude:a']).toEqual({ how: 'released', at: 3 })
  })

  it('drops the oldest past the cap', () => {
    const next = withControl(map, 'claude:c', { how: 'started', at: 4 }, 2)
    expect(Object.keys(next)).toEqual(['claude:b', 'claude:c'])
  })
})

describe('holdRefusal', () => {
  it('refuses to take over under a turn its agent is running', () => {
    expect(holdRefusal('cockpit', 'observed')).toMatch(/take it over once that turn ends/)
    expect(holdRefusal('cockpit', 'spawned')).toBeNull()
    expect(holdRefusal('cockpit', null)).toBeNull()
  })

  it("refuses to release under a turn Cockpit is running", () => {
    expect(holdRefusal('agent', 'spawned')).toMatch(/Cockpit is running a turn/)
    expect(holdRefusal('agent', 'observed')).toBeNull()
    expect(holdRefusal('agent', null)).toBeNull()
  })
})

describe('resumeLine', () => {
  it("resumes each agent's own way", () => {
    expect(resumeLine('claude', 'abc-123')).toBe("claude --resume 'abc-123'")
    expect(resumeLine('codex', 'abc-123')).toBe("codex resume 'abc-123'")
    // copilot's --resume takes an optional value: joined, it can never be read as a prompt
    expect(resumeLine('copilot', 'abc-123')).toBe("copilot --resume='abc-123'")
  })

  it('points the CLI at the config home the session was recorded under, quoted', () => {
    expect(resumeLine('claude', 'abc', "/Users/me/claude work's")).toBe(
      "CLAUDE_CONFIG_DIR='/Users/me/claude work'\\''s' claude --resume 'abc'"
    )
    expect(resumeLine('codex', 'abc', '/h/codex')).toBe("CODEX_HOME='/h/codex' codex resume 'abc'")
    expect(resumeLine('copilot', 'abc', '/h/copilot')).toBe("COPILOT_HOME='/h/copilot' copilot --resume='abc'")
  })
})

describe('resumeScript', () => {
  it('runs the line in the session directory — a real shell, a directory with a quote in it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-resume-'))
    const cwd = join(dir, "it's here")
    mkdirSync(cwd)
    const out = join(dir, 'where')
    // a stand-in for the agent: records where it was started from and what it was asked
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\npwd > '${out}'\necho "$@" >> '${out}'\n`)
    chmodSync(join(bin, 'claude'), 0o755)
    const script = join(dir, 'resume.command')
    writeFileSync(script, resumeScript('Cockpit — resuming', cwd, resumeLine('claude', 'abc')))
    // run by /bin/sh, not its zsh shebang: the body is POSIX, a Linux runner has no zsh,
    // and a login shell would load the machine's own profile — the line is what is under test
    const run = spawnSync('/bin/sh', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    expect(run.status).toBe(0)
    expect(String(run.stdout)).toContain("$ claude --resume 'abc'")
    expect(readFileSync(out, 'utf8').split('\n').slice(0, 2)).toEqual([cwd, '--resume abc'])
  })

  it('stops rather than run the agent anywhere else when the directory is gone', () => {
    const script = resumeScript('t', '/nowhere/at/all', 'echo ran')
    const run = spawnSync('/bin/sh', ['-c', script])
    expect(run.status).toBe(1)
    expect(String(run.stdout)).not.toContain('ran')
  })
})
