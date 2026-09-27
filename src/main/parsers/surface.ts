import type { SessionSurface } from '../../shared/types'

/**
 * Where a session was opened, from what each agent's log writes about its own client —
 * the one thing that tells "in the Claude app" from "in a terminal". Read off the first
 * record that says (the place it was opened, not every place it was resumed since),
 * and only ever mapped from a value seen in real logs: anything unknown says nothing,
 * so a new client is shown as the agent alone rather than as the wrong place.
 */

/** Claude Code stamps `entrypoint` on every line. */
const CLAUDE: Readonly<Record<string, SessionSurface>> = {
  'claude-desktop': 'app',
  cli: 'terminal',
  'claude-vscode': 'ide',
  'claude-jetbrains': 'ide',
  'sdk-cli': 'headless',
  'sdk-ts': 'headless',
  'sdk-py': 'headless'
}

/** Codex names its client in `session_meta.originator`. */
const CODEX: Readonly<Record<string, SessionSurface>> = {
  'Codex Desktop': 'app',
  codex_work_desktop: 'app',
  'codex-tui': 'terminal',
  codex_cli_rs: 'terminal',
  codex_exec: 'headless',
  codex_vscode: 'ide',
  'codex-chrome-extension-sidepanel': 'browser'
}

export function claudeSurface(entrypoint: unknown): SessionSurface | undefined {
  return typeof entrypoint === 'string' ? CLAUDE[entrypoint] : undefined
}

export function codexSurface(originator: unknown): SessionSurface | undefined {
  return typeof originator === 'string' ? CODEX[originator] : undefined
}

/**
 * Copilot's `session.start` names no client, but its desktop app runs an unversioned
 * agent build (`copilotVersion: "0.0.0"`) and opens its sessions with a
 * `<copilot_tauri_workspace>` block; a released CLI writes its own version.
 */
export function copilotSurface(version: unknown, appWorkspace: boolean): SessionSurface | undefined {
  if (appWorkspace || version === '0.0.0') return 'app'
  return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? 'cli' : undefined
}
