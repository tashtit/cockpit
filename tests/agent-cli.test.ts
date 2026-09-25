import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  installMethodOf,
  parseVersion,
  runsHomebrew,
  updateCommandFor
} from '../src/shared/agent-cli'
import { brewVersion, loginLine, shQuote, terminalScript } from '../src/main/agent-cli-core'
import { writeTerminalScript } from '../src/main/agent-cli'

/** The scripts are zsh, and wait on macOS's `lockf` — the platform they run on. CI's
 *  unit tier is Linux, so running them for real skips there. */
const onMac = process.platform === 'darwin'

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

  it('knows which of those commands run Homebrew', () => {
    expect(runsHomebrew(updateCommandFor('claude', 'brew-cask'))).toBe(true)
    expect(runsHomebrew(updateCommandFor('codex', 'brew-formula'))).toBe(true)
    expect(runsHomebrew('brew update')).toBe(true)
    expect(runsHomebrew(updateCommandFor('codex', 'npm'))).toBe(false)
    expect(runsHomebrew(updateCommandFor('copilot', 'brew-cask'))).toBe(false)
    expect(runsHomebrew('claude auth login')).toBe(false)
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

  it('writes a login-shell script that says what it runs and runs it, queued only for Homebrew', () => {
    const script = terminalScript('Cockpit — sign in to Claude Code', 'claude auth login')
    expect(script.startsWith('#!/bin/zsh -l\n')).toBe(true)
    expect(script).toContain("print -r -- '$ claude auth login'")
    expect(script.split('\n')).toContain('claude auth login')
    expect(script).not.toContain('lockf')
    const brew = terminalScript('Cockpit — update Codex', 'brew update', { homebrewQueue: "/it's/homebrew.lock" })
    expect(brew).toContain(`exec {queue}>>'/it'\\''s/homebrew.lock'`)
  })

  // the script is only ever run by macOS Terminal; CI's Linux runners have no zsh
  it.skipIf(!existsSync('/bin/zsh'))('runs to the end under zsh and prints a path in the title as it is', () => {
    const d = mkdtempSync(join(tmpdir(), 'cockpit-term-'))
    dirs.push(d)
    // a config home is a directory name the person chose; nothing in it is markup
    const script = terminalScript("Cockpit — sign in (/tmp/%B$(echo hacked)'s home)", 'true')
    const file = join(d, 'run.zsh')
    writeFileSync(file, script.replace('#!/bin/zsh -l', '#!/bin/zsh -f\nsetopt PROMPT_SUBST'))
    const out = execFileSync('/bin/zsh', ['-f', file], { encoding: 'utf8' })
    expect(out).toContain("(/tmp/%B$(echo hacked)'s home)")
    expect(out).toContain('Done — return to Cockpit')
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

/**
 * The scripts run for real, under zsh with none of the person's shell (no rc files, a
 * scratch HOME) and a stub `brew` first on PATH that takes Homebrew's update lock the
 * way Homebrew does — `exec 200>locks/update; lockf -t 0 200` — and fails the same way.
 */
describe.skipIf(!onMac)('the Terminal hand-off, run', () => {
  function world(): { root: string; queue: string; log: string; brewLock: string; env: NodeJS.ProcessEnv } {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-brew-'))
    dirs.push(root)
    const bin = join(root, 'bin')
    const prefix = join(root, 'prefix')
    const log = join(root, 'brew.log')
    mkdirSync(bin)
    mkdirSync(join(prefix, 'var/homebrew/locks'), { recursive: true })
    writeFileSync(
      join(bin, 'brew'),
      [
        '#!/bin/bash',
        `prefix=${shQuote(prefix)}`,
        `log=${shQuote(log)}`,
        'case "$1" in',
        '  --prefix) echo "$prefix" ;;',
        '  update)',
        '    exec 200>"$prefix/var/homebrew/locks/update"',
        '    /usr/bin/lockf -t 0 200 || { echo "Error: Another brew update process is already running."; exit 1; }',
        '    echo "update start" >> "$log"; sleep 0.4; echo "update end" >> "$log" ;;',
        '  upgrade)',
        '    echo "upgrade ${!#} start" >> "$log"; sleep 0.4; echo "upgrade ${!#} end" >> "$log" ;;',
        'esac',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    return {
      root,
      queue: join(root, 'terminal', 'homebrew.lock'),
      log,
      brewLock: join(prefix, 'var/homebrew/locks/update'),
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ZDOTDIR: root }
    }
  }

  async function run(file: string, env: NodeJS.ProcessEnv): Promise<string> {
    const child = spawn('/bin/zsh', ['-f', file], { env })
    let out = ''
    child.stdout.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr.on('data', (b: Buffer) => (out += b.toString()))
    await once(child, 'close')
    return out
  }

  function script(w: ReturnType<typeof world>, name: string, line: string): string {
    const opts = runsHomebrew(line) ? { homebrewQueue: w.queue } : {}
    return writeTerminalScript(join(w.root, 'terminal'), name, terminalScript(`Cockpit — ${name}`, line, opts))
  }

  it('reports how the command went — zsh reserves `status`, so the script must not assign it', async () => {
    const w = world()
    const ok = await run(script(w, 'ok', 'true'), w.env)
    expect(ok).toContain('Done — return to Cockpit')
    expect(ok).not.toContain('read-only')
    const failed = await run(script(w, 'failed', '(exit 3)'), w.env)
    expect(failed).toContain('That didn’t finish (exit 3)')
    expect(failed).not.toContain('read-only')
  })

  it('two Homebrew updates opened together take turns instead of the second failing', async () => {
    const w = world()
    const claude = script(w, 'update-claude', updateCommandFor('claude', 'brew-cask'))
    const codex = script(w, 'update-codex', updateCommandFor('codex', 'brew-cask'))
    const outs = await Promise.all([run(claude, w.env), run(codex, w.env)])
    for (const out of outs) {
      expect(out).not.toContain('already running')
      expect(out).toContain('Done — return to Cockpit')
    }
    expect(outs.filter((o) => o.includes('Waiting for the other Homebrew window Cockpit opened'))).toHaveLength(1)
    // one run whole, then the other: nothing of the second lands between the first's
    // `brew update` and its `brew upgrade`
    const steps = readFileSync(w.log, 'utf8').trim().split('\n')
    expect(steps).toHaveLength(8)
    for (let i = 0; i < steps.length; i += 2) expect(steps[i + 1]).toBe(steps[i].replace(/start$/, 'end'))
    expect(steps.filter((s) => s.endsWith('start')).map((s) => s.split(' ')[0])).toEqual([
      'update',
      'upgrade',
      'update',
      'upgrade'
    ])
  }, 20_000)

  it('waits out a Homebrew run it did not open, rather than fail on its lock', async () => {
    const w = world()
    // someone else's `brew update`: holds Homebrew's lock for a moment, the way brew does
    const other = spawn('/bin/bash', ['-c', `exec 200>${shQuote(w.brewLock)}; /usr/bin/lockf -t 0 200; echo held; sleep 1.2`])
    const gone = once(other, 'close')
    await once(other.stdout, 'data')
    const out = await run(script(w, 'refresh-claude', 'brew update'), w.env)
    expect(out).toContain('Waiting for another Homebrew run on this Mac to finish')
    expect(out).not.toContain('already running')
    expect(out).toContain('Done — return to Cockpit')
    expect(readFileSync(w.log, 'utf8')).toBe('update start\nupdate end\n')
    await gone
  }, 20_000)
})
