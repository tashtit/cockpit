import type {
  AccountsSnapshot,
  AgentOptions,
  PermissionMode,
  Provider,
  RepoGroup
} from '../../shared/types'

/**
 * Who runs a new session and how far it may go unasked: the agent, the account it runs as
 * and the permission mode. Home's composer, the New session form and the handoff form all
 * choose them, and all remember them in the same localStorage keys — one memory across
 * every entry point. ChatView reads the mode back, the new-roundtable form the accounts.
 */

export type AccountChoice = {
  readonly configDir?: string
  readonly copilotUser?: string
  /** Human-readable identity, carried onto the session binding for display */
  readonly display?: string
}

export type AccountOption = AccountChoice & {
  readonly key: string
  readonly display: string
  /** Short unique part (email / @login) that must never truncate away */
  readonly identity: string
}

/** Everything needed to start a fresh session (worktree + first prompt). */
export type StartSessionRequest = {
  readonly repo: RepoGroup
  readonly provider: Provider
  /** Optional branch/worktree name; '' lets the workspace pick one */
  readonly name: string
  readonly prompt: string
  readonly mode: PermissionMode
  readonly options: AgentOptions
  readonly account: AccountChoice
  /** Pasted-image paths (saveChatImage) sent with the first prompt */
  readonly images?: readonly string[]
}

/** Flatten the accounts snapshot into selectable options per provider. */
export function accountOptions(snap: AccountsSnapshot | null, provider: Provider): AccountOption[] {
  if (!snap) return []
  const out: AccountOption[] = []
  for (const a of snap.accounts.filter((x) => x.provider === provider)) {
    if (provider === 'copilot' && a.users && a.users.length > 0) {
      for (const login of a.users) {
        out.push({
          key: `${a.path}|${login}`,
          identity: `@${login}`,
          display: `@${login}${a.isDefault ? '' : ` · ${a.label}`}`,
          configDir: a.isDefault ? undefined : a.path,
          copilotUser: login
        })
      }
    } else {
      const identity = a.identity ?? a.label
      out.push({
        key: a.path,
        identity,
        // the label is only appended when it adds information — when the identity is
        // unknown it already falls back to the label, and "label · label" is noise
        display: a.isDefault || identity === a.label ? identity : `${identity} · ${a.label}`,
        configDir: a.isDefault ? undefined : a.path
      })
    }
  }
  return out
}

/** The single account-resolution rule: the user's saved choice, else the first configured. */
export function savedAccount(snap: AccountsSnapshot | null, p: Provider): AccountOption | undefined {
  const opts = accountOptions(snap, p)
  return opts.find((o) => o.key === window.localStorage.getItem(`cockpit:account:${p}`)) ?? opts[0]
}

/** The one permission-mode table — every form and ChatView read it, so wording never drifts. */
export const MODES: Array<{ v: PermissionMode; label: string; hint: string }> = [
  { v: 'safe', label: 'Safe', hint: 'asks you before any tool that needs approval (Codex: blocked headless)' },
  { v: 'auto-edit', label: 'Auto-edit', hint: 'file edits go ahead; commands ask you first (Codex: sandboxed, its reviewer decides the rest)' },
  { v: 'yolo', label: 'YOLO', hint: 'bypass all approvals — trusted repos only' }
]

/**
 * The permission mode the person last sent with, read back from storage — or the default
 * when what is stored is not one of the modes. Storage is anyone's to write (a devtools
 * console, another build, a hand edit), and the mode is what decides what an agent may do
 * unasked, so nothing but a known mode may come out of it.
 */
export function savedMode(): PermissionMode {
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem('cockpit:mode')
  } catch {
    // blocked storage: the default
  }
  return MODES.find((m) => m.v === stored)?.v ?? 'auto-edit'
}

export const AGENT_BLURB: Record<Provider, string> = {
  claude: 'Deep multi-step coding, hooks & skills',
  codex: 'Fast sandboxed execution',
  copilot: 'GitHub-native, PR-focused'
}
