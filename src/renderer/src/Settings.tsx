import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  AppInfo,
  Provider,
  ProviderUsage,
  SourceDir,
  SourceStats,
  TimeFormat,
  UpdatePrefs,
  UpdateState,
  UsageSnapshot,
  UsageTokens,
  UsageWindow
} from '../../shared/types'
import { api } from './api'
import { CHAT_WIDTH_OPTIONS, setChatWidth, useChatWidth, type ChatWidth } from './chat-width'
import { ConfirmRemove, useArmedConfirm } from './ConfirmRemove'
import { ipcErrorText } from './ipc-error'
import { BackupSection } from './BackupSection'
import { fmtCount, fmtResetIn } from './format'
import { ModelProviders } from './ModelProviders'
import { NotificationsSection } from './NotificationsSection'
import { CockpitLogo, OrgIcon, ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'
import { initTimeFormat, setTimeFormat, useTimeFormat } from './time'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

/** History window presets; value is days as a string, '0' = all history. */
const HISTORY_OPTIONS = [
  { value: '0', label: 'All history' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' }
]

const TIME_FORMAT_OPTIONS = [
  { value: '24h', label: '24-hour · 14:30' },
  { value: '12h', label: '12-hour · 2:30 PM' }
]

function fmtAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function tokensTitle(t: UsageTokens): string {
  return `input ${fmtCount(t.input)} · output ${fmtCount(t.output)} · cache write ${fmtCount(
    t.cacheCreate
  )} · cache read ${fmtCount(t.cacheRead)}`
}

const UPDATE_SWITCHES: ReadonlyArray<{
  readonly key: keyof UpdatePrefs
  readonly label: string
  readonly note: string
}> = [
  {
    key: 'download',
    label: 'Download updates automatically',
    note: 'Fetch a new release as soon as a check finds one, in the background. Off leaves the download to you.'
  },
  {
    key: 'install',
    label: 'Install when I quit',
    note: 'Swap the downloaded build in on the way out, so the next launch is the new one. Never under a running session — and “Restart now” installs it sooner.'
  }
]

/** The About row's one-line readout of where the updater stands. */
function updateLine(u: UpdateState | null, prefs: UpdatePrefs | null): string {
  if (!u) return 'loading…'
  switch (u.status) {
    case 'unsupported':
      return u.message ?? 'Updates are not available in this build.'
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return `Up to date${u.checkedAt ? ` — checked ${fmtAgo(u.checkedAt)}` : ''}`
    case 'available':
      return `Version ${u.version} is available.`
    case 'downloading':
      return `Downloading ${u.version} · ${u.percent ?? 0}%`
    case 'ready':
      return prefs?.install
        ? `Version ${u.version} is downloaded — it installs when you quit Cockpit.`
        : `Version ${u.version} is downloaded — restart to install.`
    case 'error':
      return u.version ? `Could not install ${u.version}: ${u.message}` : `Update check failed: ${u.message}`
  }
}

/** What the sr-only status region says on a transition — progress ticks stay silent. */
function updateAnnouncement(u: UpdateState): string | null {
  switch (u.status) {
    case 'available':
      return `Version ${u.version} is available`
    case 'ready':
      return `Version ${u.version} downloaded — it installs when you quit`
    case 'up-to-date':
      return 'Cockpit is up to date'
    case 'error':
      return `Update failed: ${u.message}`
    default:
      return null
  }
}

/** How long ago a measurement was taken — only worth saying once it is stale. */
function measuredAgo(u: ProviderUsage | undefined): string | null {
  if (!u || u.unavailable || u.measuredAt === undefined) return null
  return Date.now() - u.measuredAt > 15 * 60_000 ? fmtAgo(u.measuredAt) : null
}

/** The usage half of an account row: its windows, the reason there are none, or nothing. */
function UsageBody({ u, loading }: { u: ProviderUsage | undefined; loading: boolean }): JSX.Element | null {
  if (!u) return loading ? <div className="source-note">measuring usage…</div> : null
  if (u.unavailable) return <div className="source-note">{u.unavailable}</div>
  return (
    <div className="usage-windows" title={USAGE_SOURCE[u.provider]}>
      {u.windows.map((w) => (
        <UsageWindowRow key={w.label} provider={u.provider} w={w} />
      ))}
    </div>
  )
}

function UsageWindowRow({ provider, w }: { provider: Provider; w: UsageWindow }): JSX.Element {
  const pct = typeof w.usedPercent === 'number' ? Math.round(w.usedPercent) : null
  const idle = w.tokens && w.requests === 0
  return (
    <div className="usage-window">
      <span className="usage-win-label">{w.label}</span>
      {pct !== null && (
        <>
          <span
            className="usage-meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={`${w.label}: ${pct}% used`}
          >
            <span
              className={`usage-fill usage-fill-${provider}${pct >= 90 ? ' hot' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="usage-num">{pct}%</span>
        </>
      )}
      {w.tokens &&
        (idle ? (
          <span>no activity</span>
        ) : (
          <span className="usage-num" title={tokensTitle(w.tokens)}>
            {fmtCount(w.tokens.input + w.tokens.output)} tokens
            {typeof w.requests === 'number' && ` · ${fmtCount(w.requests)} requests`}
          </span>
        ))}
      {!w.tokens && pct === null && typeof w.requests === 'number' && (
        <span className="usage-num">
          {fmtCount(w.requests)} used
          {(w.requestsBilled ?? 0) > 0 && ` · ${fmtCount(w.requestsBilled!)} billed beyond plan`}
        </span>
      )}
      {w.resetsAt && (
        <time dateTime={new Date(w.resetsAt).toISOString()}>{fmtResetIn(w.resetsAt)}</time>
      )}
    </div>
  )
}


/**
 * The card's sections, in order. The jump row under the title lists them, and a deep
 * link (the sidebar's usage meters land on `accounts`) names one to land on.
 */
export const SETTINGS_SECTIONS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'github', label: 'GitHub' },
  { id: 'history', label: 'History' },
  { id: 'display', label: 'Display' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'providers', label: 'Providers' },
  { id: 'backup', label: 'Backup' },
  { id: 'about', label: 'About' }
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']

/** Where a row's usage numbers come from — the tooltip on its usage readout. */
const USAGE_SOURCE: Record<Provider, string> = {
  claude: 'Measured locally from this home’s session logs',
  codex: 'From the rate-limit snapshots the Codex CLI writes',
  copilot: 'Premium requests from the GitHub billing API'
}

export function Settings({
  onClose,
  section
}: {
  onClose: () => void
  /** Land on this section instead of the title — scrolls it into view and focuses it */
  section?: SettingsSection
}): JSX.Element {
  const [stats, setStats] = useState<SourceStats[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [licensesError, setLicensesError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [updatePrefs, setUpdatePrefs] = useState<UpdatePrefs | null>(null)
  const [path, setPath] = useState('')
  /** The add form is a task, not a permanent fixture: Settings opens as a readout */
  const [addOpen, setAddOpen] = useState(false)
  const [provider, setProvider] = useState<Provider>('claude')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** null until loaded — the Select only renders with a real value */
  const [historyDays, setHistoryDays] = useState<number | null>(null)
  const timeFormat = useTimeFormat()
  const chatWidth = useChatWidth()
  const [lastRemoved, setLastRemoved] = useState<SourceDir | null>(null)
  /** Removal failures get their own slot — `error` belongs to the add form below */
  const [removeError, setRemoveError] = useState<string | null>(null)
  /** sr-only announcements (same pattern as ChatView's status region) */
  const [status, setStatus] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  /** one heading per section — the jump row and deep links land on them */
  const headings = useRef(new Map<SettingsSection, HTMLHeadingElement>())
  const heading =
    (id: SettingsSection) =>
    (el: HTMLHeadingElement | null): void => {
      if (el) headings.current.set(id, el)
      else headings.current.delete(id)
    }
  const jump = (id: SettingsSection): void => {
    const h = headings.current.get(id)
    if (!h) return
    h.scrollIntoView({ block: 'start' })
    h.focus()
  }
  const confirm = useArmedConfirm()

  const refresh = (): void => {
    void api.getSourceStats().then(setStats)
    void api.getAccounts().then(setAccounts)
    api.getUsage().then(setUsage, () => {})
  }
  useEffect(() => {
    refresh()
    void api.getHistoryDays().then(setHistoryDays)
    headingRef.current?.focus()
    // counts stay live while the indexer works
    return api.onIndexUpdated(refresh)
  }, [])
  // declared after the mount effect on purpose: both focus something on first
  // render, and the later one wins
  useEffect(() => {
    if (section) jump(section)
  }, [section])
  useEffect(() => {
    void api.getAppInfo().then(setAppInfo)
    void api.getUpdateState().then(setUpdate)
    void api.getUpdatePrefs().then(setUpdatePrefs)
    // main pushes every transition (timer checks included) — announce the ones that matter
    return api.onUpdateState((s) => {
      setUpdate(s)
      const said = updateAnnouncement(s)
      if (said) setStatus(said)
    })
  }, [])

  /** The usage measured for this config home. Copilot reports no path (its quota is
   *  the GitHub account's, not a directory's), so it matches on provider alone. */
  const usageFor = (s: SourceStats): ProviderUsage | undefined =>
    usage?.providers.find(
      (u) => u.provider === s.provider && (u.path === s.path || u.path === '')
    )
  const orphanUsage = (usage?.providers ?? []).filter(
    (u) => !stats.some((s) => usageFor(s) === u)
  )

  const identityOf = (p: string): string | null =>
    accounts?.accounts.find((a) => a.path === p)?.identity ?? null
  const isDefault = (p: string): boolean =>
    accounts?.accounts.find((a) => a.path === p)?.isDefault ?? false

  const add = async (): Promise<void> => {
    const p = path.trim()
    if (!p) return
    setError(null)
    // main quietly keeps a path it already watches (restores lean on that); typed in
    // here it is a slip, so say so instead of announcing an add that changed nothing
    if (stats.some((s) => s.path.replace(/\/+$/, '') === p.replace(/\/+$/, ''))) {
      setError(`Cockpit already watches ${p}.`)
      return
    }
    try {
      await api.addSource(p, provider, label.trim() || `${provider}-extra`)
      setPath('')
      setLabel('')
      setAddOpen(false)
      setStatus(`Added ${label.trim() || p} — indexing started`)
      refresh()
    } catch (err) {
      setError(ipcErrorText(err))
    }
  }

  const browse = async (): Promise<void> => {
    const p = await api.pickDirectory()
    if (p) {
      setPath(p)
      setError(null)
    }
  }

  const remove = async (s: SourceStats): Promise<void> => {
    confirm.disarm()
    setRemoveError(null)
    try {
      await api.removeSource(s.path)
    } catch (err) {
      // its own state, not the add form's: `error` is aria-wired to the Add-source
      // field, so reusing it would announce an untouched input as invalid
      setRemoveError(`Could not remove ${s.label}: ${ipcErrorText(err)}`)
      return
    }
    setLastRemoved({ path: s.path, provider: s.provider, label: s.label })
    setStatus(`Removed ${s.label}`)
    refresh()
  }

  const undoRemove = async (): Promise<void> => {
    if (!lastRemoved) return
    try {
      await api.addSource(lastRemoved.path, lastRemoved.provider, lastRemoved.label)
      setStatus(`Restored ${lastRemoved.label}`)
      setLastRemoved(null)
      refresh()
    } catch (err) {
      setError(ipcErrorText(err))
    }
  }

  const changeHistory = async (days: number): Promise<void> => {
    setHistoryDays(days)
    await api.setHistoryDays(days)
    setStatus(days === 0 ? 'Showing all history' : `Showing the last ${days} days of history`)
  }

  const changeTimeFormat = (f: TimeFormat): void => {
    setTimeFormat(f)
    setStatus(`Session times shown in ${f === '24h' ? '24-hour' : '12-hour'} format`)
  }

  const checkUpdates = async (): Promise<void> => {
    setUpdate({ status: 'checking' })
    setUpdate(await api.checkForUpdates())
  }
  const downloadUpdate = async (): Promise<void> => {
    setUpdate(await api.downloadUpdate())
  }
  const flipUpdatePref = async (key: keyof UpdatePrefs, on: boolean): Promise<void> => {
    if (!updatePrefs) return
    const name = UPDATE_SWITCHES.find((u) => u.key === key)?.label ?? key
    const next = { ...updatePrefs, [key]: on }
    setUpdatePrefs(next)
    try {
      setUpdatePrefs(await api.setUpdatePrefs(next))
      setStatus(`${name} ${on ? 'on' : 'off'}`)
    } catch (err) {
      setUpdatePrefs(updatePrefs)
      setStatus(`Could not change ${name}: ${ipcErrorText(err)}`)
    }
  }

  /** The About row's single action — one control at a time, so heights never mix. */
  const updateAction = (u: UpdateState): JSX.Element | null => {
    switch (u.status) {
      case 'idle':
      case 'up-to-date':
      case 'error':
        return (
          <button className="btn-ghost small" onClick={() => void checkUpdates()}>
            Check for updates
          </button>
        )
      case 'checking':
        return (
          <button className="btn-ghost small" disabled>
            Checking…
          </button>
        )
      case 'available':
        return (
          <button className="btn-ghost small" onClick={() => void downloadUpdate()}>
            Download {u.version}
          </button>
        )
      case 'downloading':
        return (
          <button className="btn-ghost small" disabled>
            Downloading…
          </button>
        )
      case 'ready':
        return (
          <button className="btn-ghost small" onClick={() => void api.installUpdate()}>
            Restart now
          </button>
        )
      case 'unsupported':
        return null
    }
  }

  // a hand-edited config value outside the presets still renders as itself
  const historyOptions =
    historyDays !== null && !HISTORY_OPTIONS.some((o) => o.value === String(historyDays))
      ? [...HISTORY_OPTIONS, { value: String(historyDays), label: `Last ${historyDays} days` }]
      : HISTORY_OPTIONS

  const totalSessions = stats.reduce((n, s) => n + s.count, 0)

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>Settings</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
        {/* the card's map: what Settings holds, readable before any of it is scrolled
            to. A jump row, not tabs — every section stays on the one page */}
        <nav className="pnl-tabs ns-jumps" aria-label="Sections">
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.id} className="pnl-pill" onClick={() => jump(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>

        <h3 className="ns-label" ref={heading('accounts')} tabIndex={-1}>Agent accounts &amp; usage</h3>
        <p className="ns-hint ns-prose">
          One row per config home Cockpit watches: who it&apos;s signed in as, what that
          subscription has spent, and whether it&apos;s healthy. Usage comes from each agent&apos;s
          own logs, or GitHub&apos;s billing API for Copilot; nothing here reads credentials.
          {stats.length > 0 && (
            <> Currently {stats.length} config home{stats.length === 1 ? '' : 's'} · {totalSessions} sessions.</>
          )}
        </p>
        <ul className="source-list">
          {stats.map((s) => (
            <li key={s.path} className={`source-row tint-${s.provider}`}>
              <span className={`plogo plogo-${s.provider}`} aria-hidden="true">
                <ProviderLogo p={s.provider} size={13} />
              </span>
              <div className="source-body">
                <div className="source-label">
                  {s.label}
                  {identityOf(s.path) ? (
                    <span className={`acct-chip acct-${s.provider}`}>{identityOf(s.path)}</span>
                  ) : (
                    <span className="acct-chip missing">not signed in</span>
                  )}
                  {isDefault(s.path) && <span className="source-origin">auto-detected</span>}
                  {usageFor(s)?.plan && (
                    <span className="source-origin">{usageFor(s)?.plan} plan</span>
                  )}
                  {measuredAgo(usageFor(s)) && (
                    <span className="source-origin">as of {measuredAgo(usageFor(s))}</span>
                  )}
                </div>
                <div className="source-path" title={s.path}>{s.path}</div>
                {/* the subscription this home spends — the identity above is whose it is */}
                <UsageBody u={usageFor(s)} loading={usage === null} />
              </div>
              <div className="source-health">
                {s.missing ? (
                  <span className="source-warn">path missing</span>
                ) : s.count === 0 ? (
                  <span className="source-warn">no sessions yet</span>
                ) : (
                  <>
                    <span className="repo-count">{s.count}</span>
                    <span>{s.count === 1 ? 'session' : 'sessions'}</span>
                    {s.lastUpdatedAt && (
                      <time dateTime={new Date(s.lastUpdatedAt).toISOString()}>
                        · active {fmtAgo(s.lastUpdatedAt)}
                      </time>
                    )}
                  </>
                )}
              </div>
              <ConfirmRemove
                id={s.path}
                armed={confirm.armed}
                label={`Remove config home ${s.label} — ${s.path}`}
                confirmLabel={`Confirm removing ${s.label} — it won't be re-detected automatically`}
                confirmTitle="Stops indexing this directory. Defaults are only auto-detected on first run — you'd re-add it by hand. Files on disk are untouched."
                onArm={confirm.arm}
                onDisarm={confirm.disarm}
                onConfirm={() => void remove(s)}
              />
            </li>
          ))}
          {stats.length === 0 && (
            <li className="tree-empty">
              no config homes yet — add one below, and Cockpit indexes the sessions it finds
            </li>
          )}
          {/* usage Cockpit measured for a home it no longer indexes still belongs on screen */}
          {orphanUsage.map((u) => (
            <li key={`${u.provider}:${u.path}`} className={`source-row tint-${u.provider}`}>
              <span className={`plogo plogo-${u.provider}`} aria-hidden="true">
                <ProviderLogo p={u.provider} size={13} />
              </span>
              <div className="source-body">
                <div className="source-label">
                  {u.label}
                  {u.identity && (
                    <span className={`acct-chip acct-${u.provider}`}>{u.identity}</span>
                  )}
                  {u.plan && <span className="source-origin">{u.plan} plan</span>}
                </div>
                <UsageBody u={u} loading={false} />
              </div>
            </li>
          ))}
        </ul>
        {removeError && (
          <div role="alert" className="new-error">{removeError}</div>
        )}
        {lastRemoved && (
          <p className="ns-hint">
            Removed <code>{lastRemoved.label}</code> ({lastRemoved.path}) —{' '}
            <button className="link-btn" onClick={() => void undoRemove()}>Undo</button>
          </p>
        )}

        {/* adding a config home belongs with the list it extends — and stays folded
            until asked for, so the section opens as the status readout it is */}
        {!addOpen && (
          <div className="source-add-open">
            <button className="btn-ghost small" onClick={() => setAddOpen(true)}>
              Add a config home…
            </button>
          </div>
        )}
        {addOpen && (
        <form
          className="source-add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <div className="ns-options">
            <div className="ns-opt">
              <label className="ns-label" htmlFor="src-provider">Agent</label>
              <Select
                id="src-provider"
                ariaLabel="Agent"
                value={provider}
                options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
                onChange={(v) => setProvider(v as Provider)}
              />
            </div>
            <div className="ns-opt source-opt-path">
              <label className="ns-label" htmlFor="src-path">Config home</label>
              <div className="source-browse-row">
                <input
                  id="src-path"
                  autoFocus
                  placeholder="/Users/you/.claude-work"
                  value={path}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'source-add-error' : undefined}
                  onChange={(e) => {
                    setPath(e.target.value)
                    setError(null)
                  }}
                />
                <button type="button" className="btn-ghost" onClick={() => void browse()}>
                  Browse…
                </button>
              </div>
            </div>
            <div className="ns-opt">
              <label className="ns-label" htmlFor="src-label">Label · optional</label>
              <input
                id="src-label"
                placeholder="work-account"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </div>
          <p className="ns-hint">
            Usually a second account&apos;s home — the directory its <code>CLAUDE_CONFIG_DIR</code>{' '}
            points at. The defaults were found on first run.
          </p>
          {error && (
            <div id="source-add-error" role="alert" className="new-error">{error}</div>
          )}
          <div className="ns-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setAddOpen(false)
                setError(null)
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!path.trim()}>
              Add config home
            </button>
          </div>
        </form>
        )}

        {/* GitHub is an account too — it sits with the others, not after the preferences */}
        <h3 className="ns-label" ref={heading('github')} tabIndex={-1}>GitHub</h3>
        <ul className="source-list">
          <li className="source-row">
            <span className="plogo" aria-hidden="true">
              <OrgIcon size={13} />
            </span>
            <div className="source-body">
              <div className="source-label">
                gh CLI
                {accounts?.githubUser ? (
                  <span className="acct-chip">@{accounts.githubUser}</span>
                ) : (
                  <span className="acct-chip missing">not signed in</span>
                )}
              </div>
              <div className="source-note">
                {accounts?.githubUser ? (
                  'Pull requests are created and tracked as this user.'
                ) : (
                  <>Run <code>gh auth login</code> to enable PR creation and status.</>
                )}
              </div>
            </div>
          </li>
        </ul>

        <h3 className="ns-label" ref={heading('history')} tabIndex={-1}>History</h3>
        <p className="ns-hint ns-prose">
          How far back sessions appear in the sidebar, search and counts. Older sessions are only
          hidden from view — nothing on disk is touched, and all history brings them back.
        </p>
        <div className="ns-options">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="history-days">Sessions to show</label>
            {historyDays === null ? (
              <span className="ns-hint">loading…</span>
            ) : (
              <Select
                id="history-days"
                ariaLabel="Sessions to show"
                value={String(historyDays)}
                options={historyOptions}
                onChange={(v) => void changeHistory(Number(v))}
              />
            )}
          </div>
        </div>

        <h3 className="ns-label" ref={heading('display')} tabIndex={-1}>Display</h3>
        <p className="ns-hint ns-prose">
          How session times read in the sidebar and on the home view (a date, once a session is
          older than today), and how wide a conversation runs on a large display.
        </p>
        <div className="ns-options">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="time-format">Time format</label>
            <Select
              id="time-format"
              ariaLabel="Time format"
              value={timeFormat}
              options={TIME_FORMAT_OPTIONS}
              onChange={(v) => changeTimeFormat(v as TimeFormat)}
            />
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="chat-width">Chat width</label>
            <Select
              id="chat-width"
              ariaLabel="Chat width"
              value={chatWidth}
              options={CHAT_WIDTH_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
              onChange={(v) => setChatWidth(v as ChatWidth)}
            />
          </div>
        </div>

        <h3 className="ns-label" ref={heading('notifications')} tabIndex={-1}>Notifications</h3>
        <NotificationsSection packaged={appInfo?.packaged ?? null} onStatus={setStatus} />

        <h3 className="ns-label" ref={heading('providers')} tabIndex={-1}>Model providers</h3>
        <ModelProviders onStatus={setStatus} />

        <h3 className="ns-label" ref={heading('backup')} tabIndex={-1}>Backup</h3>
        <BackupSection
          onStatus={setStatus}
          onRestored={() => {
            // a restore rewrites the very settings this card is showing
            refresh()
            void api.getHistoryDays().then(setHistoryDays)
            void initTimeFormat()
          }}
        />

        <h3 className="ns-label" ref={heading('about')} tabIndex={-1}>About</h3>
        <ul className="source-list">
          <li className="source-row">
            <span className="plogo" aria-hidden="true">
              <CockpitLogo size={13} />
            </span>
            <div className="source-body">
              <div className="source-label">
                Cockpit
                {appInfo && <span className="acct-chip">v{appInfo.version}</span>}
                {appInfo && (
                  <span className="source-origin">
                    {appInfo.packaged ? `installed · ${appInfo.arch}` : 'development run'}
                  </span>
                )}
              </div>
              <div className="source-note">{updateLine(update, updatePrefs)}</div>
            </div>
            <div className="source-health">{update && updateAction(update)}</div>
          </li>
          {update?.status !== 'unsupported' &&
            UPDATE_SWITCHES.map((u) => (
              <li key={u.key}>
                <label className="source-row attn-switch">
                  {/* same recipe as the notification switches: the row is the click
                      target, but the name is the label span alone */}
                  <input
                    type="checkbox"
                    checked={updatePrefs?.[u.key] ?? false}
                    disabled={updatePrefs === null}
                    aria-labelledby={`upd-${u.key}-label`}
                    aria-describedby={`upd-${u.key}-note`}
                    onChange={(e) => void flipUpdatePref(u.key, e.currentTarget.checked)}
                  />
                  <span className="source-body">
                    <span className="source-label" id={`upd-${u.key}-label`}>
                      {u.label}
                    </span>
                    <span className="source-note" id={`upd-${u.key}-note`}>
                      {u.note}
                    </span>
                  </span>
                </label>
              </li>
            ))}
        </ul>
        {update?.installFailure && (
          <div role="alert" className="new-error">
            The last update could not be installed, so the version you had was put back:{' '}
            {update.installFailure} Nothing downloads on its own until you check for updates
            again.
          </div>
        )}
        <p className="ns-hint ns-prose">
          Installed builds check GitHub Releases on launch and every few hours, then keep
          themselves current on their own. Cockpit downloads and installs its own updates rather
          than leaving it to macOS, which is what lets it clear the quarantine flag Gatekeeper
          would otherwise block the new build on.{' '}
          {appInfo && (
            <>
              <button
                className="link-btn"
                onClick={() => void api.openExternal(appInfo.releasesUrl)}
              >
                Release notes
              </button>
              <span className="link-sep" aria-hidden="true">·</span>
            </>
          )}
          <button
            className="link-btn"
            onClick={() => {
              setLicensesError(null)
              void api.openLicenseNotices().then(setLicensesError)
            }}
          >
            Open source licenses
          </button>
        </p>
        {licensesError && (
          <div role="alert" className="new-error">
            {licensesError}
          </div>
        )}
        <div className="sr-only" role="status" aria-live="polite">{status}</div>
      </div>
    </main>
  )
}
