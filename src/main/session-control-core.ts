import { resolve } from 'node:path'
import type { Provider, SessionControl, SessionHold, SessionHolder } from '../shared/types'
import { shQuote, withConfigHome } from './shell-quote'
import { isUnder } from './paths'
import { withRecent } from './recent-map'

/**
 * Who drives a session, IO-free (what the tests target; `ipc/sessions.ts` and `ipc/chat.ts` do the IO).
 *
 * A session lives with its agent — a terminal, the provider's own app — until Cockpit
 * starts it or the person takes it over, and goes back when they release it. The
 * provider logs have no word for any of that, so it is Cockpit's own record, kept in
 * config beside the handoff lineage and applied at query time like archiving.
 */

/** What config keeps per session: only a change of hands is ever written. */
export type ControlEntry = {
  readonly how: Exclude<SessionHold, 'outside'>
  /** Epoch ms of the change */
  readonly at: number
}

const WRITTEN: ReadonlySet<string> = new Set<ControlEntry['how']>(['started', 'taken-over', 'released'])

/** The holder each recorded change leaves the session with. */
export function holderOf(how: SessionHold): SessionHolder {
  return how === 'started' || how === 'taken-over' ? 'cockpit' : 'agent'
}

/**
 * A session's control, from its recorded entry — else from where it runs: a session in
 * one of Cockpit's own worktrees was started by Cockpit, which is how sessions from
 * before this record keep their place (every new session gets such a worktree) — else
 * it came from outside and is with its agent.
 */
export function controlOf(
  entry: ControlEntry | undefined,
  cwd: string | null,
  cockpitWorktrees: string | null
): SessionControl {
  if (entry) return { holder: holderOf(entry.how), how: entry.how, since: entry.at }
  if (cwd !== null && cockpitWorktrees !== null && isUnder(resolve(cwd), resolve(cockpitWorktrees))) {
    return { holder: 'cockpit', how: 'started' }
  }
  return { holder: 'agent', how: 'outside' }
}

/**
 * Config is hand-editable and a backup file is untrusted input: keep only well-formed
 * entries, in their order (key order is recency — the cap drops the oldest).
 */
export function sanitizeControlMap(raw: unknown): Record<string, ControlEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, ControlEntry> = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) continue
    if (!v || typeof v !== 'object') continue
    const { how, at } = v as { how?: unknown; at?: unknown }
    if (typeof how !== 'string' || !WRITTEN.has(how)) continue
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
    out[id] = { how: how as ControlEntry['how'], at }
  }
  return out
}

/**
 * The map with `id` set to `entry`, re-inserted last so key order stays recency, and
 * capped to the newest `cap`. The same map back when nothing changes — claude
 * announces a session twice per turn, and each would otherwise be a config write.
 */
export function withControl(
  map: Readonly<Record<string, ControlEntry>>,
  id: string,
  entry: ControlEntry,
  cap: number
): Readonly<Record<string, ControlEntry>> {
  const current = map[id]
  if (current && current.how === entry.how && current.at === entry.at) return map
  return withRecent(map, { id, value: entry, cap })
}

/**
 * What a change of hands asks of the session as it is now, or why it can't happen.
 * `running` is where its turn runs this moment, if one does: Cockpit's own turn is
 * not the person's to release under, and a turn in a terminal is not Cockpit's to
 * take over — resuming under it would write a second turn into the same log.
 */
export function holdRefusal(to: SessionHolder, running: 'spawned' | 'observed' | null): string | null {
  if (to === 'cockpit' && running === 'observed') {
    return 'Its agent is working on it right now — take it over once that turn ends.'
  }
  if (to === 'agent' && running === 'spawned') {
    return 'Cockpit is running a turn in it — stop it, or let it finish, first.'
  }
  return null
}

/**
 * The line that resumes a session in its agent's own interactive CLI — a released
 * session's way back to where it lives. The id is the caller's validated native id
 * and the config home one it derived; both are single-quoted anyway.
 */
export function resumeLine(provider: Provider, nativeId: string, configDir?: string): string {
  const id = shQuote(nativeId)
  const cmd =
    provider === 'claude'
      ? `claude --resume ${id}`
      : provider === 'codex'
        ? `codex resume ${id}`
        : // an optional-value flag: joined, so the id can never be read as a prompt
          `copilot --resume=${id}`
  return withConfigHome(provider, cmd, configDir)
}

/**
 * The Terminal script around it: into the session's directory, say what is about to
 * run, then hand the window to the agent — interactive, so nothing follows it. zsh as a
 * login shell for the person's own PATH, but the body is plain POSIX sh, so what it does
 * can be run — and tested — by any shell.
 */
export function resumeScript(title: string, cwd: string, line: string): string {
  return [
    '#!/bin/zsh -l',
    `cd ${shQuote(cwd)} || exit 1`,
    `printf '\\033[1m%s\\033[0m\\n' ${shQuote(title)}`,
    `printf '%s\n' ${shQuote(`$ ${line}`)}`,
    'echo',
    line,
    ''
  ].join('\n')
}
