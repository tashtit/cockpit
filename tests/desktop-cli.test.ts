import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopCliDirs, desktopCliEnv } from '../src/main/desktop-cli'
import { cliPath } from '../src/main/env'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function world() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-desktop-'))
  roots.push(root)
  const home = join(root, "person's home")
  const applications = [join(home, 'Applications'), join(root, 'Applications')]
  for (const dir of applications) mkdirSync(dir, { recursive: true })

  return { home, applications, platform: 'darwin' }
}

function executable(path: string, script = 'echo desktop', mode = 0o755): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode })

  return path
}

function claudePath(home: string, version: string): string {
  return join(home, 'Library/Application Support/Claude/claude-code', version, 'claude.app/Contents/MacOS/claude')
}

describe('desktop-owned CLI discovery', () => {
  it.each([
    ['Codex.app', 'Contents/Resources/codex', 0],
    ['Codex.app', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', 1],
    ['ChatGPT.app', 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', 1]
  ] as const)('finds the CLI in %s, %s', (app, relative, location) => {
    const w = world()
    const bin = executable(join(w.applications[location], app, relative))
    expect(desktopCliDirs(w)).toEqual([dirname(bin)])
    expect(desktopCliDirs({ ...w, platform: 'linux' })).toEqual([])
  })

  it('chooses the newest executable Claude engine numerically and follows desktop updates', () => {
    const w = world()
    const app = join(w.applications[1], 'Claude.app')
    mkdirSync(app)
    executable(claudePath(w.home, '2.1.9'))
    const current = executable(claudePath(w.home, '2.1.10'))
    executable(claudePath(w.home, '2.1.11'), 'echo incomplete', 0o644)
    executable(claudePath(w.home, 'not-a-version'))
    expect(desktopCliDirs(w)).toEqual([dirname(current)])

    const updated = executable(claudePath(w.home, '2.1.12'))
    rmSync(dirname(current), { recursive: true })
    expect(desktopCliDirs(w)).toEqual([dirname(updated)])
    // Old downloaded engines do not stand in for an app that was uninstalled.
    rmSync(app, { recursive: true })
    expect(desktopCliDirs(w)).toEqual([])
  })

  it('never treats the Claude desktop GUI or an incomplete bundle as a CLI', () => {
    const w = world()
    executable(join(w.applications[0], 'Claude.app/Contents/MacOS/claude'))
    mkdirSync(join(w.applications[0], 'Codex.app/Contents/Resources/codex'), { recursive: true })
    expect(desktopCliDirs(w)).toEqual([])
    expect(desktopCliDirs({ ...w, applications: ['.'] })).toEqual([])
  })

  it('uses the desktop tool only as a fallback, and disables only its own updater', () => {
    const w = world()
    mkdirSync(join(w.applications[0], 'Claude.app'))
    const desktop = executable(claudePath(w.home, '2.1.284'), 'echo "desktop|$DISABLE_UPDATES|$DISABLE_AUTOUPDATER"')
    const standalone = executable(join(w.home, 'bin/claude'), 'echo standalone')
    const fallback = desktopCliDirs(w)
    const ordered = cliPath(`${dirname(standalone)}:/usr/bin:/bin`, null, fallback).split(':')
    expect(ordered.indexOf(dirname(standalone))).toBeLessThan(ordered.indexOf(dirname(desktop)))
    // Keep only fixture tools for execution: a real Homebrew CLI would otherwise
    // replace the removed standalone fixture below and could start a real session.
    const PATH = ordered.filter((dir) => dir === dirname(standalone) || fallback.includes(dir)).join(':')
    expect(execFileSync('claude', [], { env: { PATH, ...desktopCliEnv(PATH) }, encoding: 'utf8' })).toBe('standalone\n')
    expect(desktopCliEnv(PATH)).toEqual({})

    rmSync(standalone)
    expect(execFileSync('claude', [], { env: { PATH, ...desktopCliEnv(PATH) }, encoding: 'utf8' })).toBe('desktop|1|1\n')
    expect(execFileSync('/usr/bin/which', ['claude'], { env: { PATH }, encoding: 'utf8' }).trim()).toBe(desktop)

    symlinkSync(desktop, standalone)
    expect(desktopCliEnv(PATH)).toEqual({ DISABLE_UPDATES: '1', DISABLE_AUTOUPDATER: '1' })
  })
})
