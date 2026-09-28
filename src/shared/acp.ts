import type { AcpAgent, Mutable, NewAcpAgent, SessionProvider } from './types'
import { AGENT_LABEL, isSessionProvider } from './providers'

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
 * native to a CLI we already index belong here: a built-in writes the agent's own
 * session store, so its conversations are indexed and resumable like the CLI's — only
 * those that store holds, though (`acpCanReopen`). Copilot's are live-tracked from their
 * logs too; the agents Cockpit otherwise only reads are kept out of that (liveness.ts), so
 * a turn of theirs shows as running only while Cockpit runs it. Everything else is a
 * user-defined agent.
 *
 * Each applies only once its CLI has answered an `initialize` handshake (`BuiltinReadiness`
 * in main), so a machine without it — or with a release whose ACP mode is spelled
 * differently — just has one agent fewer to drive. The commands are the ones each project
 * documents for editors: Copilot, Gemini and Cline's CLI take a flag, opencode and Cursor's
 * agent a subcommand. Of these five, Copilot's is the only one whose CLI Cockpit also runs
 * headless; for the other four it is the only way Cockpit can start or continue one of
 * their sessions.
 */
export const BUILTIN_ACP_AGENTS: readonly AcpAgent[] = [
  { id: 'builtin-copilot', label: 'Copilot (ACP)', command: 'copilot', args: ['--acp'], provider: 'copilot', builtin: true },
  { id: 'builtin-gemini', label: 'Gemini CLI (ACP)', command: 'gemini', args: ['--acp'], provider: 'gemini', builtin: true, signIn: 'gemini' },
  { id: 'builtin-opencode', label: 'opencode (ACP)', command: 'opencode', args: ['acp'], provider: 'opencode', builtin: true, signIn: 'opencode auth login' },
  // `authenticate` reuses `cursor-agent login`'s credentials, and signed out would start a
  // browser login from inside a chat turn and wait on it — NO_OPEN_BROWSER makes it refuse
  {
    id: 'builtin-cursor',
    label: 'Cursor Agent (ACP)',
    command: 'cursor-agent',
    args: ['acp'],
    env: { NO_OPEN_BROWSER: '1' },
    provider: 'cursor',
    builtin: true,
    authMethod: 'cursor_login',
    signIn: 'cursor-agent login'
  },
  { id: 'builtin-cline', label: 'Cline CLI (ACP)', command: 'cline', args: ['--acp'], provider: 'cline', builtin: true }
]

export function builtinAgentFor(provider: SessionProvider): AcpAgent | undefined {
  return BUILTIN_ACP_AGENTS.find((a) => a.provider === provider)
}

/**
 * Whether the ACP server that drives a session's agent keeps that session, so a turn can
 * reopen it. Its server keeps the agent's own store, but not every store Cockpit reads an
 * agent's sessions from is that one:
 *
 * - Cursor's server keeps each conversation in `acp-sessions/<id>/store.db`, apart from
 *   the editor's chats (`state.vscdb`) and the agent transcripts under `projects/`.
 * - Cline's CLI keeps its tasks in its own home; the extension's, in an editor's
 *   `globalStorage`, stay the editor's.
 *
 * Every other agent's server reads the store its sessions are indexed from, and a session
 * with no path yet — just started here, through that server — is its own. One it can't
 * reopen still opens, read-only, and continues with another agent (`acpStoreRefusal`).
 */
export function acpCanReopen(session: { readonly provider: SessionProvider; readonly sourcePath?: string }): boolean {
  if (!session.sourcePath) return true
  const parts = session.sourcePath.split(/[\\/]/)
  if (session.provider === 'cursor') return parts.at(-1) === 'store.db' && parts.at(-3) === 'acp-sessions'
  if (session.provider === 'cline') return !parts.includes('globalStorage')
  return true
}

/** Why a session its agent's ACP server does not keep (`acpCanReopen`) can't be continued here. */
export function acpStoreRefusal(provider: SessionProvider): string {
  return `${AGENT_LABEL[provider]}'s ACP server keeps its own conversations, and this one isn't among them, so it can't be continued from Cockpit.`
}

/**
 * Env names a definition may never set.
 *
 * The command itself is the user's choice — that is the whole feature, and no
 * validation can second-guess it. What validation *can* stop is a definition that
 * looks harmless and isn't: every name here turns some benign `command` into a loader
 * for code the definition never names. PATH re-points the binary; the interpreter
 * hooks (NODE_OPTIONS, PYTHONSTARTUP, BASH_ENV, RUBYOPT…) run a file before the
 * program's own first line; the linker ones inject a library into it; HOME, ZDOTDIR
 * and XDG_CONFIG_HOME re-point every dotfile a shell or git then reads; EDITOR, PAGER
 * and the askpass helpers are commands git and ssh run; a package index URL decides
 * what an `npx` agent downloads; and ELECTRON_RUN_AS_NODE would turn our own binary
 * into a script host. The app's fuses already refuse the last for Cockpit itself — a
 * child it spawns gets the same rule.
 *
 * Names are compared upper-cased: npm reads `npm_config_*` in any case, and a
 * lower-case spelling of the rest is never what a definition legitimately means.
 */
export const BLOCKED_AGENT_ENV: readonly string[] = [
  'BASH_ENV',
  'COPILOT_PROVIDER_API_KEY_COMMAND',
  'EDITOR',
  'ELECTRON_RUN_AS_NODE',
  'ENV',
  'HOME',
  'IFS',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'PAGER',
  'PATH',
  'SHELL',
  'SSH_ASKPASS',
  'VISUAL',
  'XDG_CONFIG_HOME',
  'ZDOTDIR'
]

/**
 * Whole families, where naming each member would always leave one out: git reads
 * dozens of `GIT_*` (GIT_CONFIG_COUNT/KEY/VALUE alone set any config, hooks and
 * sshCommand included), and each interpreter keeps growing its own.
 */
const BLOCKED_AGENT_ENV_PREFIXES: readonly string[] = [
  'DYLD_',
  'GIT_',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LD_',
  'NODE_',
  'NPM_CONFIG_',
  'PERL5',
  'PIP_',
  'PYTHON',
  'RUBY',
  'UV_',
  '_JAVA_OPTIONS'
]

/** Inside a blocked family, but only ever a mode switch. */
const ALLOWED_AGENT_ENV: ReadonlySet<string> = new Set(['NODE_ENV'])

const BLOCKED = new Set(BLOCKED_AGENT_ENV)

export function isBlockedAgentEnv(name: string): boolean {
  const upper = name.toUpperCase()
  if (ALLOWED_AGENT_ENV.has(upper)) return false
  return BLOCKED.has(upper) || BLOCKED_AGENT_ENV_PREFIXES.some((p) => upper.startsWith(p))
}

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
  const provider = isSessionProvider(o.provider) ? o.provider : undefined
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
      if (!ENV_NAME.test(k) || isBlockedAgentEnv(k)) return null
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
  if (!isSessionProvider(agent.provider)) return 'Pick which agent this CLI drives.'
  const command = agent.command?.trim() ?? ''
  if (!command) return 'Enter the command that starts the agent.'
  if (!isValidAcpCommand(command)) {
    return command.includes('/')
      ? 'Use an absolute path — a relative command would resolve inside whichever repository the agent runs in.'
      : 'That command name is not usable. Use an executable name or an absolute path.'
  }
  for (const k of Object.keys(agent.env ?? {})) {
    if (isBlockedAgentEnv(k)) return `${k} can redirect what actually runs, so it can't be set here.`
    if (!ENV_NAME.test(k)) return `"${k.slice(0, 32)}" is not a valid environment variable name.`
  }
  return null
}
