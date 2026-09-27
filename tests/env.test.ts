import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { cliPath, execText, loginPathFrom } from '../src/main/env'

describe('execText', () => {
  it('answers ok with the output of a CLI that succeeds', async () => {
    const r = await execText('/bin/sh', ['-c', 'printf hello'])
    expect(r).toMatchObject({ ok: true, stdout: 'hello', error: null })
    expect(r.cutShort).toBeUndefined()
  })

  it('says a run the timeout stopped was cut short', async () => {
    const r = await execText('/bin/sh', ['-c', 'printf partial; exec sleep 5'], { timeoutMs: 200 })
    expect(r.ok).toBe(false)
    expect(r.cutShort).toBe(true)
  })

  it('keeps its deadline against a CLI that ignores SIGTERM', async () => {
    // execFile's own timeout only signals and then waits for the child to close — a
    // child that traps TERM (or hangs on a dead network mount) held the caller as long
    // as it liked
    const started = Date.now()
    const r = await execText('/bin/sh', ['-c', "trap '' TERM; sleep 4"], { timeoutMs: 200 })
    expect(r.ok).toBe(false)
    expect(r.cutShort).toBe(true)
    expect(Date.now() - started).toBeLessThan(3_500)
  })
})

describe('cliPath', () => {
  it('drops the entries exec would resolve against the repo a CLI runs in', () => {
    const path = cliPath(':/usr/bin::.:bin:/bin:')
    expect(path.split(':')).toEqual(expect.arrayContaining(['/usr/bin', '/bin', '/opt/homebrew/bin']))
    expect(path.split(':').every((p) => p.startsWith('/'))).toBe(true)
  })

  it('keeps the inherited order first, and names each directory once', () => {
    const path = cliPath('/opt/homebrew/bin:/usr/bin')
    expect(path.startsWith('/opt/homebrew/bin:/usr/bin:')).toBe(true)
    expect(path.split(':').filter((p) => p === '/opt/homebrew/bin')).toHaveLength(1)
  })

  it('still adds the install dirs when nothing is inherited', () => {
    expect(cliPath(undefined).split(':')).toContain('/usr/local/bin')
  })

  const NVM = '/Users/dev/.nvm/versions/node/v24.19.0/bin'
  const LOGIN = `${NVM}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`

  it("a Finder launch gets the login shell's PATH, in the order a terminal has it", () => {
    // launchd's PATH: nothing a terminal adds, and the system dirs ahead of Homebrew
    const path = cliPath('/usr/bin:/bin:/usr/sbin:/sbin', LOGIN).split(':')
    expect(path.slice(0, 7)).toEqual(LOGIN.split(':'))
    expect(path.indexOf(NVM)).toBeLessThan(path.indexOf('/usr/bin'))
  })

  it('what the launch added itself stays first: a stub world, or a terminal on another Node', () => {
    const stubs = '/tmp/ui-tour/bin'
    const node22 = '/Users/dev/.nvm/versions/node/v22.11.0/bin'
    const path = cliPath(`${stubs}:${node22}:${LOGIN}`, LOGIN).split(':')
    expect(path.slice(0, 3)).toEqual([stubs, node22, NVM])
    expect(new Set(path).size).toBe(path.length)
  })

  it('a login shell that could not be read changes nothing', () => {
    expect(cliPath('/usr/bin:/bin', null)).toBe(cliPath('/usr/bin:/bin'))
  })
})

describe('loginPathFrom', () => {
  const mark = '__COCKPIT_LOGIN_PATH__'

  it('reads the PATH between the marks, whatever the startup files printed around them', () => {
    const out = `Now using node v24.19.0\n${mark}\n/opt/homebrew/bin:/usr/bin\n${mark}\nbye\n`
    expect(loginPathFrom(out)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('takes the last pair — a startup file that echoes the mark cannot move it', () => {
    const out = `${mark}\n/evil\n${mark}\n${mark}\n/usr/bin\n${mark}\n`
    expect(loginPathFrom(out)).toBe('/usr/bin')
  })

  it('is null for output with no PATH in it: a timeout, a shell that failed, one mark only', () => {
    expect(loginPathFrom('')).toBeNull()
    expect(loginPathFrom(`${mark}\n/usr/bin\n`)).toBeNull()
    expect(loginPathFrom(`${mark}\n\n${mark}\n`)).toBeNull()
    expect(loginPathFrom(`${mark}\nbin:.\n${mark}\n`)).toBeNull()
  })
})

describe('loadLoginShellPath', () => {
  it("runs the person's shell as an interactive login shell from home, and every spawn gets its PATH after", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-login-shell-'))
    const seen = join(dir, 'seen')
    // a shell whose startup files print noise and set the PATH a terminal would have
    writeFileSync(
      join(dir, 'shell'),
      [
        '#!/bin/sh',
        `printf '%s|%s|%s\\n' "$*" "$(pwd)" "$COCKPIT_RESOLVING_ENVIRONMENT" > '${seen}'`,
        'echo "Now using node v24.19.0"',
        'PATH=/login/nvm/bin:/usr/bin:/bin; export PATH',
        'eval "$4"'
      ].join('\n')
    )
    chmodSync(join(dir, 'shell'), 0o755)
    const shell = process.env.SHELL
    process.env.SHELL = join(dir, 'shell')
    try {
      vi.resetModules()
      const env = await import('../src/main/env')
      await env.loginPathReady()
      expect(env.cliEnv().PATH).not.toContain('/login/nvm/bin')
      await env.loadLoginShellPath()
      expect(env.cliEnv().PATH?.split(':')).toContain('/login/nvm/bin')
      const [args, cwd, flag] = readFileSync(seen, 'utf8').trim().split('|')
      expect(args.startsWith('-i -l -c ')).toBe(true)
      expect(cwd).toBe(homedir())
      expect(flag).toBe('1')
    } finally {
      process.env.SHELL = shell
      vi.resetModules()
    }
  })

  it('a slow shell holds the probes only so long, and its PATH still lands for what comes after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-slow-shell-'))
    writeFileSync(
      join(dir, 'shell'),
      ['#!/bin/sh', 'sleep 1', 'PATH=/login/slow/bin:/usr/bin:/bin; export PATH', 'eval "$4"'].join('\n')
    )
    chmodSync(join(dir, 'shell'), 0o755)
    const shell = process.env.SHELL
    process.env.SHELL = join(dir, 'shell')
    try {
      vi.resetModules()
      const env = await import('../src/main/env')
      const load = env.loadLoginShellPath()
      const started = Date.now()
      await env.loginPathReady(100)
      expect(Date.now() - started).toBeLessThan(900)
      expect(env.cliEnv().PATH).not.toContain('/login/slow/bin')
      await load
      expect(env.cliEnv().PATH?.split(':')).toContain('/login/slow/bin')
    } finally {
      process.env.SHELL = shell
      vi.resetModules()
    }
  })
})
