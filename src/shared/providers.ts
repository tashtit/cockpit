import type { Provider, ReadOnlyProvider, SessionProvider } from './types'

/**
 * The agents Cockpit knows, spelled once, and split by what it can do with them: the
 * three CLIs it drives (`Provider`) and the ones it only reads (`ReadOnlyProvider`). Main
 * reads them off untrusted input (config files, persisted state, IPC arguments) and the
 * renderer lists them, and each used to carry its own copy of the names and the tables
 * keyed by them. A session's `provider` is any of them (`SessionProvider`); everything that
 * spawns a CLI takes a `Provider` and asks `isDrivable` first.
 *
 * An agent Cockpit only reads is still driven when an ACP agent answers for it (see
 * `acpAgentFor` in main's services.ts, mirrored by the renderer's `acp-readiness.ts`);
 * until then its sessions open read-only, with Continue in… as the way on. Either way its
 * sessions stay out of observed liveness and attention's turn tracking (a turn Cockpit
 * runs over ACP is tracked like any it spawns), the profile, accounts and usage — and
 * cleanup deletes them the way their agent keeps them (`session-disposal.ts`).
 */

/** The CLIs Cockpit drives, in the order Cockpit lists them. */
export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']

/** The agents Cockpit only reads, in the order Cockpit lists them after the three. */
export const READ_ONLY_PROVIDERS: readonly ReadOnlyProvider[] = ['gemini', 'cursor', 'cline', 'roo', 'opencode', 'antigravity']

/** Every agent whose sessions Cockpit indexes: the three it drives first. */
export const SESSION_PROVIDERS: readonly SessionProvider[] = [...PROVIDERS, ...READ_ONLY_PROVIDERS]

/** True for one of the three provider names — the check untrusted input goes through. */
export function isProvider(v: unknown): v is Provider {
  return PROVIDERS.includes(v as Provider)
}

/** A value off the wire or out of a config file that names an agent this build reads. */
export function isSessionProvider(v: unknown): v is SessionProvider {
  return typeof v === 'string' && (SESSION_PROVIDERS as readonly string[]).includes(v)
}

/** A session's agent is one Cockpit runs a CLI for — what a spawn asks before it spawns. */
export function isDrivable(p: SessionProvider): p is Provider {
  return isProvider(p)
}

/**
 * The agents' own product names, for the sentences that have to name one: prompts,
 * error messages, terminal titles. The renderer's shorter labels are `AGENT_LABEL`.
 */
export const AGENT_NAME: Record<SessionProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot',
  gemini: 'Gemini CLI',
  cursor: 'Cursor',
  cline: 'Cline',
  roo: 'Roo Code',
  opencode: 'opencode',
  antigravity: 'Antigravity'
}

/** What every surface calls an agent — one spelling, whichever process draws it. */
export const AGENT_LABEL: Readonly<Record<SessionProvider, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  gemini: 'Gemini',
  cursor: 'Cursor',
  cline: 'Cline',
  roo: 'Roo Code',
  opencode: 'opencode',
  antigravity: 'Antigravity'
}

/** The variable that points each CLI at a config home. */
export const CONFIG_HOME_VAR: Record<Provider, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  copilot: 'COPILOT_HOME'
}
