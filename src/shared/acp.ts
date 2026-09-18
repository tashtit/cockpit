import type { AcpAgent, Mutable, NewAcpAgent, Provider } from './types'

const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']

/**
 * Agent Client Protocol — pure logic shared by main (which spawns agents) and the
 * renderer (which lets the user define them). Deliberately IO-free.
 *
 * ACP is JSON-RPC 2.0 over the agent's stdio: the editor is the client, the agent is
 * the server. Cockpit speaks it for two reasons — it is the only structured stream
 * Copilot offers, and it turns "support another agent" from a parser into a config row.
 */

/** The protocol revision Cockpit implements; `initialize` negotiates against it. */
export const ACP_PROTOCOL_VERSION = 1

/**
 * Agents Cockpit knows how to drive without being told. Only agents whose ACP mode is
 * native to a CLI we already index belong here: a built-in writes the provider's own
 * session store, so its conversations are indexed, resumable and live-tracked exactly
 * like the CLI's. Everything else is a user-defined agent.
 */
export const BUILTIN_ACP_AGENTS: readonly AcpAgent[] = [
  {
    id: 'builtin-copilot',
    label: 'Copilot (ACP)',
    command: 'copilot',
    args: ['--acp'],
    provider: 'copilot',
    builtin: true
  }
]

export function builtinAgentFor(provider: Provider): AcpAgent | undefined {
  return BUILTIN_ACP_AGENTS.find((a) => a.provider === provider)
}

/**
 * Env names a definition may never set.
 *
 * The command itself is the user's choice — that is the whole feature, and no
 * validation can second-guess it. What validation *can* stop is a definition that
 * looks harmless and isn't: every name here turns some benign `command` into a loader
 * for code the definition never names. PATH re-points the binary; the interpreter
 * hooks (NODE_OPTIONS, PYTHONSTARTUP, BASH_ENV, RUBYOPT…) run a file before the
 * program's own first line; the linker ones inject a library into it; and
 * ELECTRON_RUN_AS_NODE would turn our own binary into a script host. The app's fuses
 * already refuse the last two for Cockpit itself — a child it spawns gets the same rule.
 */
export const BLOCKED_AGENT_ENV: readonly string[] = [
  'BASH_ENV',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ELECTRON_RUN_AS_NODE',
  'ENV',
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH_COMMAND',
  'IFS',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PATH',
  'PERL5OPT',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'SHELL'
]

const BLOCKED = new Set(BLOCKED_AGENT_ENV)
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const BARE_COMMAND = /^[A-Za-z0-9._+-]{1,64}$/

/**
 * A command must be a bare executable name (resolved on the minimal PATH `cliEnv()`
 * builds) or an absolute path. Anything in between — `./agent`, `../bin/agent`,
 * `tools/agent` — resolves against the *spawn* cwd, which is the user's repository:
 * a checked-out file would become the agent. Absolute paths may contain spaces; the
 * spawn is `shell: false`, so nothing here is ever word-split or interpreted.
 */
export function isValidAcpCommand(command: string): boolean {
  if (/[\r\n\0]/.test(command) || command.length > 1024) return false
  if (command.startsWith('/')) return !command.includes('\0')
  return BARE_COMMAND.test(command) && !command.startsWith('-')
}

/**
 * Renderer input is untrusted — normalize and validate every field. Returns null when
 * the definition is unusable, so the caller refuses rather than storing half of one.
 */
export function sanitizeAcpAgent(input: unknown, id: string): AcpAgent | null {
  if (typeof input !== 'object' || input === null) return null
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null
  const o = input as Record<string, unknown>
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, 64) : ''
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  const provider = PROVIDERS.find((p) => p === o.provider)
  if (!label || !command || !provider || !isValidAcpCommand(command)) return null

  const agent: Mutable<AcpAgent> = { id, label, command, provider }

  if (o.args !== undefined) {
    if (!Array.isArray(o.args)) return null
    const args: string[] = []
    for (const raw of o.args) {
      // an arg may legitimately start with '-' (that is what --acp is), but a NUL or a
      // newline in argv is never intentional
      if (typeof raw !== 'string' || /[\r\n\0]/.test(raw) || raw.length > 512) return null
      args.push(raw)
    }
    if (args.length > 32) return null
    if (args.length > 0) agent.args = args
  }

  if (o.env !== undefined) {
    if (typeof o.env !== 'object' || o.env === null || Array.isArray(o.env)) return null
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
      if (typeof v !== 'string') return null
      if (!ENV_NAME.test(k) || BLOCKED.has(k)) return null
      if (/[\r\n\0]/.test(v) || v.length > 2048) return null
      env[k] = v
    }
    const names = Object.keys(env)
    if (names.length > 32) return null
    if (names.length > 0) agent.env = env
  }

  return agent
}

/**
 * Why a definition was refused, for a form that would otherwise just say "invalid".
 * Mirrors `sanitizeAcpAgent`'s rules in the order it applies them — when the two
 * drift, the form explains a rule the store does not actually enforce.
 */
export function acpAgentRefusal(agent: NewAcpAgent): string | null {
  if (!agent.label?.trim()) return 'Give the agent a name.'
  if (!PROVIDERS.includes(agent.provider)) return 'Pick which agent this CLI drives.'
  const command = agent.command?.trim() ?? ''
  if (!command) return 'Enter the command that starts the agent.'
  if (!isValidAcpCommand(command)) {
    return command.includes('/')
      ? 'Use an absolute path — a relative command would resolve inside whichever repository the agent runs in.'
      : 'That command name is not usable. Use an executable name or an absolute path.'
  }
  for (const k of Object.keys(agent.env ?? {})) {
    if (BLOCKED.has(k)) return `${k} can redirect what actually runs, so it can't be set here.`
    if (!ENV_NAME.test(k)) return `"${k.slice(0, 32)}" is not a valid environment variable name.`
  }
  return null
}
