import { useEffect, useRef, useState, type JSX } from 'react'
import type { AppInfo, TimeFormat, UpdateState } from '../../shared/types'
import { AboutSection } from './AboutSection'
import { AccountsSection } from './AccountsSection'
import { AcpAgents } from './AcpAgents'
import { api } from './api'
import { BackupSection } from './BackupSection'
import { CHAT_WIDTH_OPTIONS, setChatWidth, useChatWidth, type ChatWidth } from './chat-width'
import { ModelProviders } from './ModelProviders'
import { NotificationsSection } from './NotificationsSection'
import { Select } from './Select'
import { TabList, TabPanel } from './Tabs'
import { initTimeFormat, setTimeFormat, useTimeFormat } from './time'

/** History window presets; value is days as a string, '0' = all history. */
const HISTORY_OPTIONS = [
  { value: '0', label: 'All history' },
  { value: '1', label: 'Last day' },
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

/** What the sr-only status region says on a transition — progress ticks stay silent. */
function updateAnnouncement(u: UpdateState): string | null {
  switch (u.status) {
    case 'available':
      return `Version ${u.version} is available`
    case 'ready':
      return u.message
        ? `Version ${u.version} downloaded; could not check for a newer one: ${u.message}`
        : `Version ${u.version} downloaded — it installs when you quit`
    case 'up-to-date':
      return 'Cockpit is up to date'
    case 'error':
      return `Update failed: ${u.message}`
    default:
      return null
  }
}

/**
 * The card's tabs, in order — accounts first, then what the app shows, then the
 * occasional tasks. One tab is one panel: only the open one is mounted, so it reads
 * its own data when it is opened and Settings never renders as one long scroll.
 * A deep link (the sidebar's usage meters land on `accounts`) names the tab to open on.
 *
 * The pill row must hold in two rows at the 560px window floor — it wrapped to three
 * when every old section got its own tab, which is why History and Display share the
 * one tab they were always two halves of. Check the floor before adding another.
 */
export const SETTINGS_SECTIONS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'view', label: 'View' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'providers', label: 'Providers' },
  { id: 'backup', label: 'Backup' },
  { id: 'about', label: 'About' }
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']

export function Settings({
  onClose,
  section,
  openCount
}: {
  onClose: () => void
  /** Open on this tab instead of the first one */
  section?: SettingsSection
  /** How many times something has asked to open Settings. A deep link to a tab you
   *  have since left names the same section as last time, so the section alone
   *  cannot say "take me there" twice — this counts the asking. */
  openCount?: number
}): JSX.Element {
  const [tab, setTab] = useState<SettingsSection>(section ?? SETTINGS_SECTIONS[0].id)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  /** the shell's, not About's: main pushes transitions whatever tab is on screen */
  const [update, setUpdate] = useState<UpdateState | null>(null)
  /** sr-only announcements (same pattern as ChatView's status region) */
  const [status, setStatus] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  useEffect(() => {
    if (section) setTab(section)
  }, [section, openCount])
  useEffect(() => {
    void api.getAppInfo().then(setAppInfo)
    void api.getUpdateState().then(setUpdate)
    // main pushes every transition (timer checks included) — announce the ones that matter
    return api.onUpdateState((s) => {
      setUpdate(s)
      const said = updateAnnouncement(s)
      if (said) setStatus(said)
    })
  }, [])

  /** One panel per tab, keyed by the section id: a `Record<SettingsSection, …>`
   *  will not compile if a tab is added to `SETTINGS_SECTIONS` without one, which a
   *  chain of `tab === '…' &&` would have rendered as an empty panel. */
  const panels: Record<SettingsSection, JSX.Element> = {
    accounts: <AccountsSection onStatus={setStatus} />,
    view: (
      <>
        <HistoryPanel onStatus={setStatus} />
        <DisplayPanel onStatus={setStatus} />
      </>
    ),
    notifications: (
      <NotificationsSection packaged={appInfo?.packaged ?? null} onStatus={setStatus} />
    ),
    providers: (
      <>
        {/* both answer "what backs my agents": an endpoint you bring a key for, and a
            CLI that speaks ACP. One tab, two groups. */}
        <h3 className="ns-label">Model providers</h3>
        <ModelProviders onStatus={setStatus} />
        <h3 className="ns-label">ACP agents</h3>
        <AcpAgents onStatus={setStatus} />
      </>
    ),
    backup: (
      <BackupSection
        onStatus={setStatus}
        onRestored={() => {
          // a restore rewrites the very settings this card shows. The other tabs are
          // unmounted and re-read on open; the display stores are app-wide, so they
          // are re-initialised here.
          void initTimeFormat()
        }}
      />
    ),
    about: (
      <AboutSection appInfo={appInfo} update={update} onUpdate={setUpdate} onStatus={setStatus} />
    )
  }

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>Settings</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
        {/* tabs, not a jump row: each panel is short enough to read whole, and the
            title, the tabs and Close stay put instead of scrolling away under you */}
        <TabList
          id="settings"
          label="Settings sections"
          tabs={SETTINGS_SECTIONS}
          selected={tab}
          onSelect={setTab}
        />
        <TabPanel id="settings" selected={tab}>
          {panels[tab]}
        </TabPanel>
        <div className="sr-only" role="status" aria-live="polite">{status}</div>
      </div>
    </main>
  )
}

/** How far back sessions are listed — a view filter, never anything on disk. */
function HistoryPanel({ onStatus }: { onStatus: (s: string) => void }): JSX.Element {
  /** null until loaded — the Select only renders with a real value */
  const [historyDays, setHistoryDays] = useState<number | null>(null)
  useEffect(() => {
    void api.getHistoryDays().then(setHistoryDays)
  }, [])

  const change = async (days: number): Promise<void> => {
    setHistoryDays(days)
    await api.setHistoryDays(days)
    onStatus(days === 0 ? 'Showing all history' : `Showing the last ${days} days of history`)
  }

  // a hand-edited config value outside the presets still renders as itself
  const options =
    historyDays !== null && !HISTORY_OPTIONS.some((o) => o.value === String(historyDays))
      ? [
          ...HISTORY_OPTIONS,
          { value: String(historyDays), label: `Last ${historyDays} day${historyDays === 1 ? '' : 's'}` }
        ]
      : HISTORY_OPTIONS

  return (
    <>
      <h3 className="ns-label">History</h3>
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
              options={options}
              onChange={(v) => void change(Number(v))}
            />
          )}
        </div>
      </div>
    </>
  )
}

/** How times read and how wide a conversation runs — both live in renderer stores. */
function DisplayPanel({ onStatus }: { onStatus: (s: string) => void }): JSX.Element {
  const timeFormat = useTimeFormat()
  const chatWidth = useChatWidth()

  const changeTimeFormat = (f: TimeFormat): void => {
    setTimeFormat(f)
    onStatus(`Session times shown in ${f === '24h' ? '24-hour' : '12-hour'} format`)
  }

  return (
    <>
      <h3 className="ns-label">Display</h3>
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
    </>
  )
}
