import type { Provider } from '../shared/types'
import { SIGN_IN_COMMAND } from '../shared/agent-auth'

/**
 * Terminal hand-offs, IO-free (what the tests target). Signing in and updating both
 * need the person — a browser to approve, sometimes a password — so Cockpit writes a
 * one-off script and opens it in Terminal rather than driving the CLI blind. Every
 * word in it comes from fixed tables; the only variable part is a config home the
 * caller has already validated, and it is single-quoted.
 */

/** POSIX single-quoting: safe for any path, including spaces and quotes. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The variable that points each CLI at a config home. */
export const CONFIG_HOME_VAR: Record<Provider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME'
}

/** The sign-in command line for one agent and home, as the script runs it. */
export function loginLine(provider: Provider, configDir?: string): string {
  const cmd = SIGN_IN_COMMAND[provider]
  return configDir === undefined ? cmd : `${CONFIG_HOME_VAR[provider]}=${shQuote(configDir)} ${cmd}`
}

/** `lockf`'s exit status when the lock is held by someone else (sysexits EX_TEMPFAIL). */
const LOCK_HELD = 75

/**
 * Waiting for Homebrew, which does one thing at a time and refuses a second `brew update`
 * outright ("Another `brew update` process is already running"). Two waits, both on
 * flock(2), the lock Homebrew itself takes:
 *  - `queue`, Cockpit's own, held for the whole run, so two Update clicks run one after
 *    the other: a run is `brew update` then `brew upgrade`, and another run's update must
 *    not land between them.
 *  - Homebrew's own update lock, only polled, never held (the `brew update` about to run
 *    takes it), for a run Cockpit didn't open — a terminal, a scheduled `brew autoupdate`.
 * Neither ever goes stale: a flock dies with its process, so closing a window frees it.
 */
function homebrewTurn(queue: string): string[] {
  return [
    `exec {queue}>>${shQuote(queue)}`,
    'if ! /usr/bin/lockf -s -t 0 $queue 2>/dev/null; then',
    '  echo "Waiting for the other Homebrew window Cockpit opened — Homebrew runs one at a time. This carries on by itself once that one finishes…"',
    '  /usr/bin/lockf -s $queue 2>/dev/null',
    'fi',
    'brew_lock="$(brew --prefix)/var/homebrew/locks/update"',
    'waited=',
    `while /usr/bin/lockf -k -s -t 0 "$brew_lock" /usr/bin/true 2>/dev/null; (( $? == ${LOCK_HELD} )); do`,
    '  [[ -n $waited ]] || echo "Waiting for another Homebrew run on this Mac to finish — this carries on by itself…"',
    '  waited=1',
    '  sleep 1',
    'done'
  ]
}

/**
 * The `.command` script Terminal runs: a login shell (so Homebrew and npm are on PATH
 * as the person has them), what it is about to do, the command, and how it went.
 * `title` is Cockpit's own wording, but it can carry a config-home path, so it is
 * printed as data: `print -P` would expand `%` escapes in it, and `$(…)` too
 * wherever the person's zsh sets PROMPT_SUBST. A line that runs Homebrew is given
 * `homebrewQueue`, the lock file every such script waits its turn on.
 */
export function terminalScript(
  title: string,
  line: string,
  opts: { readonly homebrewQueue?: string } = {}
): string {
  return [
    '#!/bin/zsh -l',
    'cd ~',
    `printf '\\033[1m%s\\033[0m\\n' ${shQuote(title)}`,
    `print -r -- ${shQuote(`$ ${line}`)}`,
    'echo',
    ...(opts.homebrewQueue === undefined ? [] : homebrewTurn(opts.homebrewQueue)),
    line,
    // not `status`: zsh reserves it as a read-only alias of `$?`
    'exit_code=$?',
    ...(opts.homebrewQueue === undefined ? [] : ['exec {queue}>&-']),
    'echo',
    'if [ $exit_code -eq 0 ]; then',
    '  echo "Done — return to Cockpit; it picks this up by itself. You can close this window."',
    'else',
    '  echo "That didn’t finish (exit $exit_code). Cockpit is unchanged — try again from Cockpit."',
    'fi',
    ''
  ].join('\n')
}

/**
 * The version Homebrew has packaged, from `brew info --json=v2`. A cask states its
 * `version`; a formula its stable one. Anything unreadable is null — "couldn't check",
 * never "up to date".
 */
export function brewVersion(json: string): string | null {
  try {
    const d = JSON.parse(json) as {
      casks?: Array<{ version?: unknown }>
      formulae?: Array<{ versions?: { stable?: unknown } }>
    }
    const cask = d.casks?.[0]?.version
    if (typeof cask === 'string') return cask
    const formula = d.formulae?.[0]?.versions?.stable
    return typeof formula === 'string' ? formula : null
  } catch {
    return null
  }
}
