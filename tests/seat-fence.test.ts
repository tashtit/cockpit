import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommand } from '../src/main/chat'
import { codexSeatArgs, probeSeatFence, resetSeatFence, SEAT_SECRET_PATHS, seatFence } from '../src/main/seat-fence'

describe('a Codex seat’s secret fence', () => {
  let root = ''
  const saved = { PATH: process.env.PATH, ud: process.env.COCKPIT_USER_DATA }

  /** A `codex` first on PATH that records its argv and exits with `code`. */
  const stubCodex = (code: number): string => {
    const log = join(root, 'argv')
    writeFileSync(join(root, 'bin', 'codex'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit ${code}\n`)
    chmodSync(join(root, 'bin', 'codex'), 0o755)
    return log
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cockpit-seat-fence-'))
    mkdirSync(join(root, 'bin'))
    process.env.PATH = `${join(root, 'bin')}:${saved.PATH}`
    process.env.COCKPIT_USER_DATA = join(root, 'ud')
    resetSeatFence()
  })

  afterEach(() => {
    process.env.PATH = saved.PATH
    if (saved.ud === undefined) delete process.env.COCKPIT_USER_DATA
    else process.env.COCKPIT_USER_DATA = saved.ud
    resetSeatFence()
    rmSync(root, { recursive: true, force: true })
  })

  it('denies where secrets live in the seat’s profile, quoted as TOML', () => {
    const profile = codexSeatArgs(['~/.aws', '/repo/with "quote"/.env'])[1]
    expect(profile).toContain('":root" = "read", "~/.aws" = "deny", "/repo/with \\"quote\\"/.env" = "deny" }')
    expect(profile).toContain('network = { enabled = true }')
    // no fence asked for: the profile the seats had before it
    expect(codexSeatArgs()[1]).toBe(
      'permissions.cockpit-roundtable-seat={ extends = ":read-only", filesystem = { ":root" = "read" }, network = { enabled = true } }'
    )
  })

  it('fences a seat only once this Codex has run a command under the very profile', async () => {
    // before anyone asked: the seat keeps the profile it always had
    expect(seatFence('/repo')).toEqual([])
    const log = stubCodex(0)
    expect(await probeSeatFence()).toBe(true)
    const argv = readFileSync(log, 'utf8').trim().split('\n')
    expect(argv.slice(0, 1)).toEqual(['sandbox'])
    expect(argv.slice(-3)).toEqual(['cockpit-roundtable-seat', '--', 'true'])
    expect(argv.join(' ')).toContain('"~/.ssh" = "deny"')

    const denied = seatFence('/repo')
    expect(denied).toEqual(expect.arrayContaining([...SEAT_SECRET_PATHS, '/repo/.env', '/repo/.env.local', join(root, 'ud')]))
    const args = buildCommand(
      { provider: 'codex', cwd: '/repo', prompt: 'hi', permissionMode: 'safe', research: true, options: { codexSandbox: 'read-only' } },
      { seatDenied: denied }
    ).args
    expect(args.join(' ')).toContain('"~/.aws" = "deny"')
    expect(args.join(' ')).toContain('"/repo/.env" = "deny"')
  })

  it('keeps the old profile on a Codex that refuses it, or none at all', async () => {
    stubCodex(1)
    expect(await probeSeatFence()).toBe(false)
    expect(seatFence('/repo')).toEqual([])
    resetSeatFence()
    process.env.PATH = '/nonexistent-cockpit-bin'
    expect(await probeSeatFence()).toBe(false)
    expect(seatFence('/repo')).toEqual([])
  })
})
