import type { Provider } from './types'

/** The command that signs each agent CLI back in — what a person runs in a terminal. */
export const SIGN_IN_COMMAND: Record<Provider, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
  copilot: 'copilot login'
}

/**
 * A failed turn whose message is a sign-in failure (an expired OAuth session, a
 * missing login, a rejected key). Those are fixed at a terminal, not by retrying,
 * so the failure row names the command. The wording is each CLI's own and drifts
 * between releases, so this errs towards missing one rather than mislabelling a crash.
 */
export function looksSignedOut(text: string): boolean {
  return /failed to authenticate|oauth (session|token)|not (logged|signed) in|please (log|sign) ?in|run .{0,20}login|invalid api key|authentication (failed|required|error)|\b401\b/i.test(
    text
  )
}

/** The line a failed sign-in gets: what to run, and where. */
export function signInHint(provider: Provider, configHome?: string): string {
  const env =
    configHome === undefined
      ? ''
      : `${provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : provider === 'codex' ? 'CODEX_HOME' : 'COPILOT_HOME'}=${configHome} `
  return `Run \`${env}${SIGN_IN_COMMAND[provider]}\` in a terminal to sign in again.`
}
