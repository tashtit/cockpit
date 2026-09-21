import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, installMethodOf, parseVersion, updateCommandFor } from '../src/shared/agent-cli'
import { brewVersion, loginLine, shQuote, terminalScript } from '../src/main/agent-cli-core'
import { writeTerminalScript } from '../src/main/agent-cli'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('reading a CLI’s version and how it was installed', () => {
  it('finds the version in each CLI’s own --version line', () => {
    expect(parseVersion('2.1.236 (Claude Code)')).toBe('2.1.236')
    expect(parseVersion('codex-cli 0.154.0')).toBe('0.154.0')
    expect(parseVersion('GitHub Copilot CLI 1.0.87-0.')).toBe('1.0.87')
    expect(parseVersion('command not found')).toBeNull()
  })

  it('orders versions numerically, not as text', () => {
    expect(compareVersions('2.1.278', '2.1.236')).toBeGreaterThan(0)
    expect(compareVersions('0.155.1', '0.154.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.87', '1.0.87-0')).toBe(0)
  })

  it('reads the install method off where the binary really lives', () => {
    expect(installMethodOf('/opt/homebrew/Caskroom/claude-code/2.1.236/claude')).toBe('brew-cask')
    expect(installMethodOf('/opt/homebrew/Cellar/codex/0.154.0/bin/codex')).toBe('brew-formula')
    expect(installMethodOf('/Users/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js')).toBe('npm')
    expect(installMethodOf('/Users/me/.local/share/claude/versions/2.1.278')).toBe('native')
  })

  it('updates each the way it was installed; copilot always updates itself', () => {
    expect(updateCommandFor('claude', 'brew-cask')).toBe('brew update && brew upgrade --cask claude-code')
    expect(updateCommandFor('codex', 'npm')).toBe('npm install -g @openai/codex@latest')
    expect(updateCommandFor('claude', 'native')).toBe('claude update')
    // its cask auto-updates; `brew upgrade` could roll a self-updated copilot back
    expect(updateCommandFor('copilot', 'brew-cask')).toBe('copilot update')
  })
})

describe('what Homebrew has packaged', () => {
  it('reads a cask’s version and a formula’s stable one', () => {
    expect(brewVersion('{"casks":[{"version":"2.1.267"}]}')).toBe('2.1.267')
    expect(brewVersion('{"formulae":[{"versions":{"stable":"2.101.0"}}]}')).toBe('2.101.0')
  })

  it('an unreadable answer is "couldn’t check", never "up to date"', () => {
    expect(brewVersion('Error: No available cask')).toBeNull()
    expect(brewVersion('{"casks":[]}')).toBeNull()
  })
})

describe('the Terminal hand-off', () => {
  it('single-quotes a config home, whatever it contains', () => {
    expect(shQuote("/Users/me/it's here")).toBe(`'/Users/me/it'\\''s here'`)
    expect(loginLine('claude')).toBe('claude auth login')
    expect(loginLine('codex', '/Users/me/.codex work')).toBe(`CODEX_HOME='/Users/me/.codex work' codex login`)
  })

  it('writes a login-shell script that says what it runs, runs it, and reports how it went', () => {
    const script = terminalScript('Cockpit — sign in to Claude Code', 'claude auth login')
    expect(script.startsWith('#!/bin/zsh -l\n')).toBe(true)
    expect(script).toContain("print -r -- '$ claude auth login'")
    expect(script.split('\n')).toContain('claude auth login')
    expect(script).toContain('status=$?')
  })

  it('keeps the script owner-only, and rewrites it each time', () => {
    const d = mkdtempSync(join(tmpdir(), 'cockpit-term-'))
    dirs.push(d)
    const file = writeTerminalScript(join(d, 'terminal'), 'sign-in-claude', 'echo one\n')
    writeTerminalScript(join(d, 'terminal'), 'sign-in-claude', 'echo two\n')
    expect(file.endsWith('sign-in-claude.command')).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('echo two\n')
    expect(statSync(file).mode & 0o777).toBe(0o700)
  })
})
