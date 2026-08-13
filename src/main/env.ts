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
}

export type ExecOptions = {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxBuffer?: number
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
  return new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: cliEnv(),
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error: err ? (err.message ?? String(err)) : null
        })
      }
    )
  })
}
