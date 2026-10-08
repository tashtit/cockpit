import { useEffect, useMemo, useState } from 'react'
import type {
  AccountsSnapshot,
  AgentAccount,
  AgentOptions,
  PermissionMode,
  Provider,
  RepoGroup,
  SessionProvider
} from '../../shared/types'
import { isDrivable, isSessionProvider } from '../../shared/providers'
import { api } from './api'
import { canDrive, refreshAcpReadiness, startableAgents, useDrivableAgents } from './acp-readiness'
import { storedValue } from './stored-value'
import { useLoaded } from './use-loaded'

/**
 * Who runs a new session and how far it may go unasked: the agent, the account it runs as
 * and the permission mode. Home's composer, the New session form and the handoff form all
 * choose them, and all remember them in the same keys (`storedValue`) — one memory across
 * every entry point. ChatView reads the mode back, the new-roundtable form the accounts.
 *
 * Storage is anyone's to write (a devtools console, another build, a hand edit) and can
 * refuse outright (a private window, blocked site data), so nothing read here trusts it:
 * a refused read is unset, only a known agent or mode comes out of it, and a choice that
 * could not be saved still holds for this run — never a start refused over it.
 *
 * Besides the three CLIs, a form offers every agent Cockpit otherwise only reads that an
 * ACP agent drives right now (`acp-readiness.ts`). Such an agent has no account, model or
 * thinking to pick — it runs as whoever it is signed in as — and a pick of one whose ACP
 * agent has since gone falls back to Claude rather than a card that is not there.
 */

export type AccountChoice = AgentAccount & {
  /** Human-readable identity, carried onto the session binding for display */
  readonly display?: string
}

/** Just who an agent runs as — no display fields, nothing unset — for asking main about that account. */
export function accountRef(account: AgentAccount | undefined): AgentAccount {
  const { configDir, copilotUser } = account ?? {}
  return { ...(configDir ? { configDir } : {}), ...(copilotUser ? { copilotUser } : {}) }
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
  /** One of the three CLIs, or an agent Cockpit otherwise only reads that an ACP agent drives */
  readonly provider: SessionProvider
  /** Optional branch/worktree name; '' lets the workspace pick one */
  readonly name: string
  readonly prompt: string
  readonly mode: PermissionMode
  readonly options: AgentOptions
  readonly account: AccountChoice
  /** Pasted-image paths (saveChatImage) sent with the first prompt */
  readonly images?: readonly string[]
}

/** The agent last started with — Claude when what is stored is not an agent Cockpit knows. */
const savedProviderPref = storedValue<SessionProvider>('cockpit:provider', {
  parse: (raw) => (isSessionProvider(raw) ? raw : undefined),
  serialize: (p) => p,
  fallback: 'claude'
})

/** The account key (`AccountOption.key`) last picked for one agent, as stored — each reader checks it still resolves. */
const accountPrefs = new Map<SessionProvider, ReturnType<typeof storedValue<string | null>>>()
function accountPref(p: SessionProvider): ReturnType<typeof storedValue<string | null>> {
  let pref = accountPrefs.get(p)
  if (!pref) {
    pref = storedValue<string | null>(`cockpit:account:${p}`, { parse: (raw) => raw, serialize: (k) => k, fallback: null })
    accountPrefs.set(p, pref)
  }
  return pref
}

/** Flatten the accounts snapshot into selectable options per provider (none for an agent driven over ACP). */
export function accountOptions(snap: AccountsSnapshot | null, provider: SessionProvider): AccountOption[] {
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

/** The account a form opens on for `p`: the user's saved choice, else the first configured. */
export function savedAccount(snap: AccountsSnapshot | null, p: SessionProvider): AccountOption | undefined {
  const opts = accountOptions(snap, p)
  const saved = accountPref(p).get()
  return opts.find((o) => o.key === saved) ?? opts[0]
}

/**
 * The account a start runs as: the one picked on the form (`key`, an `AccountOption.key`)
 * while that agent still offers it, else the saved one, else the first. A start form's
 * agent and every roundtable seat resolve theirs by this one rule.
 */
export function chosenAccount(
  snap: AccountsSnapshot | null,
  p: SessionProvider,
  key: string | null | undefined
): AccountOption | undefined {
  return accountOptions(snap, p).find((o) => o.key === key) ?? savedAccount(snap, p)
}

/**
 * The one permission-mode table — every form and ChatView read it, so wording never
 * drifts. One vocabulary for every agent, since a roundtable mixes them and the same
 * setting must not read differently when the agent changes; what each agent calls it
 * is in the hint (`modeHint`).
 */
export const MODES: Array<{ v: PermissionMode; label: string }> = [
  { v: 'safe', label: 'Ask first' },
  { v: 'auto-edit', label: 'Accept edits' },
  { v: 'yolo', label: 'Full access' }
]

/** A mode's label (`MODES`). */
export function modeLabel(mode: PermissionMode): string {
  return MODES.find((m) => m.v === mode)?.label ?? mode
}

/**
 * What a mode lets this agent do unasked, and what the agent itself calls that setting
 * where it has a name for it — so someone who knows Claude Code's "bypass permissions"
 * or Copilot's Autopilot finds it under Full access.
 */
export function modeHint(mode: PermissionMode, provider: SessionProvider): string {
  if (mode === 'safe') {
    if (provider === 'codex') return 'Codex can’t ask while Cockpit runs it, so anything that needs approval is refused instead.'
    if (provider === 'claude') return 'Anything that needs approval asks you first — Claude Code’s default mode.'
    if (provider === 'copilot') return 'Anything that needs approval asks you first — Copilot’s Agent mode.'
    return 'Anything that needs approval asks you first.'
  }
  if (mode === 'auto-edit') {
    if (provider === 'codex')
      return 'Commands run in Codex’s workspace sandbox, and its own reviewer decides what the sandbox refuses.'
    if (provider === 'claude') return 'File edits go ahead; commands ask you first — Claude Code’s accept edits.'
    return 'File edits go ahead; commands ask you first.'
  }
  if (provider === 'claude') return 'Nothing asks — Claude Code’s bypass permissions. Trusted repos only.'
  if (provider === 'codex') return 'Nothing asks, no sandbox — Codex’s full access. Trusted repos only.'
  if (provider === 'copilot') return 'Nothing asks — Copilot runs in Autopilot, its allow-all. Trusted repos only.'
  return 'Nothing asks — Cockpit allows each request it makes. Trusted repos only.'
}

/** The mode picker's options, each with what it means for this agent as its tooltip. */
export function modeOptions(provider: SessionProvider): { value: PermissionMode; label: string; title: string }[] {
  return MODES.map((m) => ({ value: m.v, label: m.label, title: modeHint(m.v, provider) }))
}

/**
 * The permission mode last sent with, or the default when what is stored is not one of
 * the modes — the mode decides what an agent may do unasked.
 */
const savedModePref = storedValue<PermissionMode>('cockpit:mode', {
  parse: (raw) => MODES.find((m) => m.v === raw)?.v,
  serialize: (m) => m,
  fallback: 'auto-edit'
})

/** The permission mode the person last sent with (`savedModePref`). */
export function savedMode(): PermissionMode {
  return savedModePref.get()
}

/** The agent the person last started with, or Claude when what is stored is not one. */
export function savedProvider(): SessionProvider {
  return savedProviderPref.get()
}

/** Remember the permission mode picked, for every form (and the next chat's composer) to open on. */
export function rememberMode(mode: PermissionMode): void {
  savedModePref.set(mode)
}

/** Remember the account picked for `provider`, for every form to open on. */
export function rememberAccount(provider: SessionProvider, key: string): void {
  accountPref(provider).set(key)
}

/** Remember what a session was started with, for the next form to open on. */
export function rememberChoice(choice: {
  readonly provider: SessionProvider
  readonly mode: PermissionMode
  readonly account: AccountOption | undefined
}): void {
  savedProviderPref.set(choice.provider)
  rememberMode(choice.mode)
  if (choice.account) rememberAccount(choice.provider, choice.account.key)
}

export const AGENT_BLURB: Record<Provider, string> = {
  claude: 'Deep multi-step coding, hooks & skills',
  codex: 'Fast sandboxed execution',
  copilot: 'GitHub-native, PR-focused'
}

/** A picker card's line: what the agent is good at, or — for one driven over ACP — how it runs. */
export function agentBlurb(p: SessionProvider): string {
  return isDrivable(p) ? AGENT_BLURB[p] : 'Runs over its ACP server'
}

/** A start form's agent, account and permission mode, as chosen so far. */
export type AgentChoice = {
  readonly provider: SessionProvider
  readonly setProvider: (p: SessionProvider) => void
  /** Every agent the form offers: the three CLIs, then the ones an ACP agent drives now */
  readonly agents: readonly SessionProvider[]
  readonly mode: PermissionMode
  readonly setMode: (m: PermissionMode) => void
  /** Every signed-in account; null while they load, when absence is unknown — not "signed out" */
  readonly accounts: AccountsSnapshot | null
  /** The active agent's accounts to pick from */
  readonly opts: readonly AccountOption[]
  /** The account the session would run as: the one picked here, else the saved one, else the first */
  readonly account: AccountOption | undefined
  readonly setAccount: (key: string) => void
  /** The account an agent's card names — the rule `account` follows for the active agent, so a
   *  card never shows a different account than the one that would actually run */
  readonly accountFor: (p: SessionProvider) => AccountOption | undefined
  /** What the start request carries of the account */
  readonly runAs: AccountChoice
}

/**
 * The agent, account and mode a start form opens on — the saved ones, or `initial`'s agent —
 * and how they change. The accounts are read once; a pick made for one agent is dropped
 * when the agent changes, since accounts differ per agent.
 */
export function useAgentChoice(initial: () => SessionProvider = savedProvider): AgentChoice {
  const drivable = useDrivableAgents()
  const [picked, setProvider] = useState<SessionProvider>(initial)
  // derived, not stored: the picked agent may be one whose ACP agent answers only later
  const provider = canDrive(picked, drivable) ? picked : 'claude'
  const [mode, setMode] = useState<PermissionMode>(savedMode)
  // an agent's CLI installed since launch shows up here, once main's probe answers
  useEffect(() => refreshAcpReadiness(), [])
  const { value: accounts } = useLoaded(() => api.getAccounts(), [])
  const [accountKey, setAccountKey] = useState<string | null>(null)

  const opts = useMemo(() => accountOptions(accounts, provider), [accounts, provider])
  const account = chosenAccount(accounts, provider, accountKey)

  useEffect(() => {
    setAccountKey(null)
  }, [provider])

  return {
    provider,
    setProvider,
    agents: startableAgents(drivable),
    mode,
    setMode,
    accounts,
    opts,
    account,
    setAccount: setAccountKey,
    accountFor: (p) => (p === provider ? account : savedAccount(accounts, p)),
    runAs: {
      configDir: account?.configDir,
      copilotUser: account?.copilotUser,
      display: account?.display
    }
  }
}
