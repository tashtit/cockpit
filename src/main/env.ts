import { spawn, type ChildProcess } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { desktopAppOf } from '../shared/agent-cli'
import { desktopCliDirs, desktopCliEnv } from './desktop-cli'

/** GUI apps get a minimal PATH; add CLI install dirs and desktop-owned CLI fallbacks. */
export function cliEnv(): NodeJS.ProcessEnv {
  const PATH = cliPath(process.env.PATH)

  return { ...process.env, PATH, ...desktopCliEnv(PATH) }
}

/**
 * The PATH the person's own login shell ends up with, once `loadLoginShellPath` has read
 * it. A Finder launch starts from launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, and what a
 * terminal adds — nvm, fnm, asdf, pyenv, Homebrew's shellenv — lives in startup files an
 * app never runs: an agent Cockpit spawned had no `node` or `npm` for its tools at all.
 */
let loginPath: string | null = null
let loginPathLoad: Promise<void> | null = null

/**
 * The PATH every CLI is spawned with, keeping only absolute entries. An empty entry (a
 * leading or trailing `:`, or `::`) or a relative one like `.` is resolved against the
 * spawn's cwd — the repo being worked on — so a clone that ships an executable `gh` or
 * `git` at its root would win every lookup.
 *
 * What this launch put on PATH that the login shell does not have comes first — a test
 * world's stub CLIs, the `nvm use` of the terminal `npm run dev` ran in — then the login
 * shell's PATH in its own order, then the common install dirs. A Finder launch inherits
 * only system dirs the login shell also has, so it gets exactly what a terminal gets.
 * Desktop-owned CLI directories are fallbacks after every standalone install directory.
 */
export function cliPath(
  inherited: string | undefined,
  login: string | null = loginPath,
  desktop: string[] = desktopCliDirs()
): string {
  const own = (inherited ?? '').split(':')
  const shell = (login ?? '').split(':')
  const fromShell = new Set(shell)
  // An inherited desktop path can name an engine its app just replaced. Rediscover
  // it below, after standalone installs, rather than keeping an old version first.
  const standalone = (dir: string): boolean =>
    !desktopAppOf(`${dir}/codex`) && !desktopAppOf(`${dir}/claude`)
  const entries = [
    ...own.filter((p) => !fromShell.has(p) && standalone(p)),
    ...shell.filter(standalone),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${homedir()}/.local/bin`,
    `${homedir()}/bin`,
    ...desktop
  ]
  return [...new Set(entries.filter((p) => p.startsWith('/')))].join(':')
}

/** What brackets the PATH in the login shell's output, apart from whatever its startup files print. */
const LOGIN_PATH_MARK = '__COCKPIT_LOGIN_PATH__'

/**
 * How long the login shell gets. nvm alone takes seconds, and on a loaded machine far
 * longer — a cap of ten seconds was blown at a load average of 260, and that launch ran
 * every agent on the bare PATH until the next restart. What waits on it is capped apart
 * (`LOGIN_PATH_WAIT_MS`), so a slow shell only makes the PATH land later.
 */
const LOGIN_SHELL_TIMEOUT_MS = 60_000

/** How long a launch-time probe waits for the login shell before going ahead without it. */
export const LOGIN_PATH_WAIT_MS = 10_000

/** The PATH between the last two marks of a login shell's output, or null when there is none. */
export function loginPathFrom(stdout: string): string | null {
  const end = stdout.lastIndexOf(LOGIN_PATH_MARK)
  const start = end > 0 ? stdout.lastIndexOf(LOGIN_PATH_MARK, end - 1) : -1
  if (start < 0) return null
  const path = stdout.slice(start + LOGIN_PATH_MARK.length, end).trim()
  return path.split(':').some((p) => p.startsWith('/')) ? path : null
}

/**
 * Read the login shell's PATH once, in the background — never awaited by the window. Until
 * it lands (a few seconds with nvm) spawns get the inherited PATH and the install dirs, as
 * they always have; `loginPathReady` is for the launch-time probes of the agent CLIs, which
 * an npm-installed CLI would otherwise fail.
 */
export function loadLoginShellPath(): Promise<void> {
  loginPathLoad ??= readLoginShellPath().then((path) => {
    loginPath = path
  })
  return loginPathLoad
}

/**
 * Settles once the login shell's PATH is read or given up on, or after `waitMs` —
 * whichever is first; at once when nothing asked for it. A probe past the wait runs on
 * what PATH there is, and the read carries on for the spawns after it.
 */
export function loginPathReady(waitMs: number = LOGIN_PATH_WAIT_MS): Promise<void> {
  if (!loginPathLoad) return Promise.resolve()
  return Promise.race([
    loginPathLoad,
    new Promise<void>((done) => {
      setTimeout(done, waitMs).unref()
    })
  ])
}

async function readLoginShellPath(): Promise<string | null> {
  if (process.platform === 'win32') return null
  const shell = loginShell()
  // interactive as well as login: nvm and most version managers are set up in .zshrc /
  // .bashrc, which a login shell alone never reads. Run from home, so a version manager
  // that follows `.nvmrc` answers with the person's default, not this checkout's
  const r = await execText(shell, ['-i', '-l', '-c', `echo ${LOGIN_PATH_MARK}; /usr/bin/printenv PATH; echo ${LOGIN_PATH_MARK}`], {
    cwd: homedir(),
    timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
    // a startup file can skip its slow parts for this
    env: { COCKPIT_RESOLVING_ENVIRONMENT: '1' },
    // an interactive shell takes over the terminal it can reach for its job control — the
    // one `npm run dev` runs in. In a session of its own it has none to take
    detached: true
  })
  // a startup file that ends in a failing command has still printed the PATH before that
  const path = loginPathFrom(r.stdout)
  if (path === null) {
    console.warn(`[env] no PATH from the login shell (${shell}): ${r.error ?? 'none in its output'}`)
  }
  return path
}

/** The person's login shell: $SHELL, else the account's own, else the platform's default. */
function loginShell(): string {
  const fromEnv = process.env.SHELL
  if (fromEnv?.startsWith('/')) return fromEnv
  try {
    const own = userInfo().shell
    if (own?.startsWith('/')) return own
  } catch {
    /* no passwd entry */
  }
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

export type ExecResult = {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  /** Why it failed (non-zero exit, ENOENT, timeout); null when ok. */
  readonly error: string | null
  /**
   * Stopped before it finished — the timeout, or output past maxBuffer — so stdout
   * holds only part of what it would have said. A caller that reads a non-zero exit's
   * output as an answer (lsof does exit 1 on success) must check this.
   */
  readonly cutShort?: true
}

/** How long a timed-out CLI gets to exit on SIGTERM before it is killed and abandoned */
const KILL_GRACE_MS = 2_000

export type ExecOptions = {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxBuffer?: number
  /** Extra variables layered over cliEnv() (config homes, BYOK endpoints) */
  readonly env?: NodeJS.ProcessEnv
  /**
   * Run in a session of its own, with no controlling terminal — and as a process group
   * of its own, which the timeout signals whole. For an interactive shell, which would
   * otherwise take over the terminal Cockpit was started from.
   */
  readonly detached?: boolean
}

/**
 * Run a CLI and capture its output. Never rejects — each caller decides what a
 * failure means (throw, fall back to empty, log and continue), which is why the
 * result is a value rather than an exception. Always spawns with cliEnv(), since
 * every CLI Cockpit shells out to is user-installed and off the GUI PATH.
 *
 * Nothing is ever written to its stdin, so it reads end-of-file at once. Left an open
 * pipe, a CLI that reads it — a startup file's prompt, a `read` — waited out the whole
 * timeout, and an interactive shell ignores the SIGTERM that ends it.
 *
 * Spawned rather than `execFile`d, which ignores `detached`; otherwise what execFile did:
 * each stream kept up to `maxBuffer`, past which the run is stopped, and the same words
 * for a failure (`Command failed: …`, `spawn … ENOENT`).
 */
export function execText(
  cmd: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024
  return new Promise((resolve) => {
    let settled = false
    let deadline: NodeJS.Timeout | undefined
    let timer: NodeJS.Timeout | undefined
    const settle = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(deadline)
      resolve(result)
    }
    let child: ChildProcess
    try {
      child = spawn(cmd, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env === undefined ? cliEnv() : { ...cliEnv(), ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: options.detached === true
      })
    } catch (err) {
      settle({ ok: false, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) })
      return
    }
    /** Stopped by us — the timeout, or output past maxBuffer — so what it said is partial */
    let stopped = false
    let overflow: string | null = null
    const signal = (sig: NodeJS.Signals): void => {
      try {
        // a detached run leads a process group of its own, and what it started goes with it
        if (options.detached === true && child.pid !== undefined) process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch {
        /* already gone */
      }
    }
    const stop = (): void => {
      stopped = true
      signal('SIGTERM')
    }
    const keep = (stream: NodeJS.ReadableStream, name: string): Buffer[] => {
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        if (overflow !== null) return
        const room = maxBuffer - size
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
        size += Math.min(chunk.length, room)
        if (chunk.length > room) {
          overflow = `${name} maxBuffer length exceeded`
          stop()
        }
      })
      return chunks
    }
    const out = keep(child.stdout!, 'stdout')
    const err = keep(child.stderr!, 'stderr')
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8')
    child.on('error', (e) => {
      settle({ ok: false, stdout: text(out), stderr: text(err), error: e.message })
    })
    child.on('close', (code, sig) => {
      const stdout = text(out)
      const stderr = text(err)
      if (overflow === null && code === 0 && sig === null) {
        settle({ ok: true, stdout, stderr, error: null })
        return
      }
      settle({
        ok: false,
        stdout,
        stderr,
        error: overflow ?? `Command failed: ${[cmd, ...args].join(' ')}\n${stderr}`,
        ...(stopped ? { cutShort: true as const } : {})
      })
    })
    // SIGTERM at the timeout lets git drop its index.lock. Past a grace the answer is a
    // timeout whether or not the child has gone: one that traps the signal — or sits in
    // the kernel on a dead network mount — held its caller, and every await behind it,
    // for as long as it liked.
    timer = setTimeout(stop, timeoutMs)
    deadline = setTimeout(() => {
      signal('SIGKILL')
      settle({
        ok: false,
        stdout: '',
        stderr: '',
        error: `${cmd} did not exit within ${timeoutMs}ms`,
        cutShort: true
      })
    }, timeoutMs + KILL_GRACE_MS)
  })
}

/** What a failed run says for itself: its stderr, else its stdout, else why it failed. */
export function failureText(cmd: string, r: ExecResult): string {
  return r.stderr.trim() || r.stdout.trim() || r.error || `${cmd} failed`
}

export type ExecOrThrowOptions = ExecOptions & {
  /** What a failed run throws, when failureText is not the message the caller wants */
  readonly failure?: (r: ExecResult) => string
}

/** execText for a caller with no fallback: the trimmed stdout, or an Error saying why not. */
export async function execOrThrow(
  cmd: string,
  args: readonly string[],
  options: ExecOrThrowOptions = {}
): Promise<string> {
  const { failure, ...exec } = options
  const r = await execText(cmd, args, exec)
  if (!r.ok) throw new Error(failure ? failure(r) : failureText(cmd, r))
  return r.stdout.trim()
}

/**
 * What makes a git call one that only reads, and says so. Without `--no-optional-locks`,
 * `git status` or `git diff` refreshes a stale index and writes it back under
 * `index.lock` — in worktrees agents are working in, whose own `git commit` then fails
 * on the lock a read holds. fsmonitor is off because a read must not start a watcher
 * daemon in every repository it looks at; it only ever speeds status up, so the answer
 * is the same without it.
 */
export const GIT_READ_ONLY: readonly string[] = ['--no-optional-locks', '-c', 'core.fsmonitor=false']

/** A read-only git call in `dir` (GIT_READ_ONLY): its stdout, or null when git failed. */
export async function gitRead(
  dir: string,
  args: readonly string[],
  options: Pick<ExecOptions, 'timeoutMs' | 'maxBuffer'> = {}
): Promise<string | null> {
  const r = await execText('git', [...GIT_READ_ONLY, '-C', dir, ...args], { timeoutMs: 20_000, ...options })
  return r.ok ? r.stdout : null
}
