import type { Provider, SignInState } from '../shared/types'

export type { SignInState }

/**
 * Reading an agent CLI's own sign-in status, IO-free (what the tests target). Only a
 * definite "signed out" counts: anything unreadable is `unknown`, and unknown never
 * blocks a table — a status command that drifted must not lock people out.
 */

/** `claude auth status` prints JSON with `loggedIn` (and exits 1 when signed out). */
export function claudeSignIn(stdout: string): SignInState {
  try {
    const j = JSON.parse(stdout) as { loggedIn?: unknown }
    if (j.loggedIn === true) return 'signed-in'
    if (j.loggedIn === false) return 'signed-out'
  } catch {
    /* not JSON — an older or newer CLI */
  }
  return 'unknown'
}

/** `codex login status` says "Logged in using …" (exit 0) or "Not logged in" (exit 1). */
export function codexSignIn(output: string, ok: boolean): SignInState {
  if (/not logged in/i.test(output)) return 'signed-out'
  if (ok && /logged in/i.test(output)) return 'signed-in'
  return 'unknown'
}

/** The spawn failed because the binary isn't there — the CLI isn't installed (or isn't on PATH). */
export function isMissingBinary(error: string | null): boolean {
  return error !== null && /\bENOENT\b/.test(error)
}

/** The status command per CLI; copilot has none, so it is never checked. */
export function signInCommand(provider: Provider): readonly string[] | null {
  if (provider === 'claude') return ['claude', 'auth', 'status']
  if (provider === 'codex') return ['codex', 'login', 'status']
  return null
}
