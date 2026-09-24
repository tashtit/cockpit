import { execFile } from 'node:child_process'
import { homedir } from 'node:os'

/** GUI apps on macOS get a minimal PATH; make sure common CLI install dirs are present. */
export function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // empty segments are dropped on purpose: an empty PATH entry means "current
    // directory" to exec, which would let a repo-local file named `git` win
    PATH: [
      process.env.PATH,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      `${homedir()}/.local/bin`,
      `${homedir()}/bin`
    ]
      .filter((p): p is string => !!p)
      .join(':')
  }
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
}

/**
 * Run a CLI and capture its output. Never rejects — each caller decides what a
 * failure means (throw, fall back to empty, log and continue), which is why the
 * result is a value rather than an exception. Always spawns with cliEnv(), since
 * every CLI Cockpit shells out to is user-installed and off the GUI PATH.
 */
export function execText(
  cmd: string,
  args: readonly string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(result)
    }
    const child = execFile(
      cmd,
      [...args],
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env === undefined ? cliEnv() : { ...cliEnv(), ...options.env },
        timeout: timeoutMs,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        settle({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: err ? (err.message ?? String(err)) : null,
          ...(err?.killed ? { cutShort: true as const } : {})
        })
      }
    )
    // execFile's timeout sends SIGTERM and then waits for the child to close: one that
    // traps the signal — or sits in the kernel on a dead network mount — held its
    // caller, and every await behind it, for as long as it liked. SIGTERM first still
    // lets git drop its index.lock; past the grace, the answer is a timeout.
    const deadline = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
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
