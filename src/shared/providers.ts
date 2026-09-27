import type { Provider } from './types'

/**
 * The agent CLIs Cockpit knows, spelled once. Main reads them off untrusted input
 * (config files, persisted state, IPC arguments) and the renderer lists them, and
 * each used to carry its own copy of the three names and the tables keyed by them.
 */

/** Every provider, in the order Cockpit lists them. */
export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']

/** True for one of the three provider names — the check untrusted input goes through. */
export function isProvider(v: unknown): v is Provider {
  return PROVIDERS.includes(v as Provider)
}

/**
 * The agents' own product names, for the sentences that have to name one: prompts,
 * error messages, terminal titles. The renderer's shorter labels are its own.
 */
export const AGENT_NAME: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot'
}

/** The variable that points each CLI at a config home. */
export const CONFIG_HOME_VAR: Record<Provider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME'
}
