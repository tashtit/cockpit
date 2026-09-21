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

/**
 * The `.command` script Terminal runs: a login shell (so Homebrew and npm are on PATH
 * as the person has them), what it is about to do, the command, and how it went.
 * `title` is Cockpit's own fixed wording, never renderer text.
 */
export function terminalScript(title: string, line: string): string {
  return [
    '#!/bin/zsh -l',
    'cd ~',
    `print -P ${shQuote(`%B${title}%b`)}`,
    `print -r -- ${shQuote(`$ ${line}`)}`,
    'echo',
    line,
    'status=$?',
    'echo',
    'if [ $status -eq 0 ]; then',
    '  echo "Done — return to Cockpit; it picks this up by itself. You can close this window."',
    'else',
    '  echo "That didn’t finish (exit $status). Cockpit is unchanged — try again from Cockpit."',
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
