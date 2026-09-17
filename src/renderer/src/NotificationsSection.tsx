import { useEffect, useState, type JSX } from 'react'
import type { AttentionPrefs, NotificationDelivery } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'

const SWITCHES: ReadonlyArray<{
  readonly key: keyof AttentionPrefs
  readonly label: string
  readonly note: string
}> = [
  {
    key: 'notifications',
    label: 'Desktop notifications',
    note: 'The agent, the session and how it ended — or what it asks you, or which pull request went red. Click one to open that session.'
  },
  {
    key: 'sound',
    label: 'Sound',
    note: 'The macOS Glass sound when a turn finishes or an agent asks you something, Basso when a turn fails or a pull request goes red.'
  },
  {
    key: 'badge',
    label: 'Dock badge',
    note: 'How many sessions need you that you haven’t opened yet.'
  }
]

type TestState = 'idle' | 'sending' | NotificationDelivery

/** The test row's readout: what macOS did, and what that means here. */
function testLine(state: TestState, packaged: boolean | null): string {
  if (state === 'sending') return 'Asking macOS…'
  if (state === 'idle') {
    return packaged === false
      ? 'Development run: macOS names these after Electron, and a switch you haven’t flipped stays off here.'
      : 'Sends a sample. The first notification Cockpit posts makes macOS ask for permission.'
  }
  switch (state.status) {
    case 'shown':
      return 'macOS showed it. Missed it? Check System Settings › Notifications › Cockpit.'
    case 'refused':
      return 'macOS refused it. Builds without an Apple Developer ID signature aren’t allowed to post notifications, so Cockpit bounces its Dock icon instead.'
    case 'unknown':
      return 'No answer from macOS yet. If it asked for permission, allow Cockpit and try again.'
  }
}

/**
 * Notifications: how Cockpit gets your attention when an agent needs you.
 *
 * Its own component like BackupSection — the switches round-trip to main, and the
 * test waits on macOS for seconds. `onStatus` feeds Settings' sr-only announcer.
 */
export function NotificationsSection({
  packaged,
  onStatus
}: {
  /** null until Settings knows — the idle readout differs for a development run */
  packaged: boolean | null
  onStatus: (msg: string) => void
}): JSX.Element {
  const [prefs, setPrefs] = useState<AttentionPrefs | null>(null)
  const [test, setTest] = useState<TestState>('idle')

  useEffect(() => {
    void api.getAttentionPrefs().then(setPrefs)
  }, [])

  const flip = async (key: keyof AttentionPrefs, on: boolean): Promise<void> => {
    if (!prefs) return
    const name = SWITCHES.find((s) => s.key === key)?.label ?? key
    const next = { ...prefs, [key]: on }
    setPrefs(next)
    try {
      setPrefs(await api.setAttentionPrefs(next))
      onStatus(`${name} ${on ? 'on' : 'off'}`)
    } catch (err) {
      setPrefs(prefs)
      onStatus(`Could not change ${name}: ${ipcErrorText(err)}`)
    }
  }

  const sendTest = async (): Promise<void> => {
    setTest('sending')
    let result: NotificationDelivery
    try {
      result = await api.testNotification()
    } catch (err) {
      result = { status: 'refused', message: ipcErrorText(err) }
    }
    setTest(result)
    onStatus(testLine(result, packaged))
  }

  return (
    <>
      <p className="ns-hint ns-prose">
        When an agent finishes, fails or stops to ask you something while you&apos;re somewhere
        else — another session, another app, a terminal — Cockpit tells you, and when an open pull
        request on a session&apos;s branch turns red. Never about the session in front of you;
        endings that arrive together share one notification, and a roundtable speaks once it
        concludes.
      </p>
      <ul className="source-list">
        {SWITCHES.map((s) => (
          <li key={s.key}>
            <label className="source-row attn-switch">
              {/* the row is the click target, but the name is the label alone — the note
                  is its description, not part of what the switch is called */}
              <input
                type="checkbox"
                checked={prefs?.[s.key] ?? false}
                disabled={prefs === null}
                aria-labelledby={`attn-${s.key}-label`}
                aria-describedby={`attn-${s.key}-note`}
                onChange={(e) => void flip(s.key, e.currentTarget.checked)}
              />
              <span className="source-body">
                <span className="source-label" id={`attn-${s.key}-label`}>
                  {s.label}
                </span>
                <span className="source-note" id={`attn-${s.key}-note`}>
                  {s.note}
                </span>
              </span>
            </label>
          </li>
        ))}
        <li className="source-row">
          <div className="source-body">
            <div className="source-label">Try it</div>
            <div className="source-note">{testLine(test, packaged)}</div>
            {typeof test === 'object' && test.status === 'refused' && (
              <div className="source-note">
                macOS said: <code>{test.message}</code>
              </div>
            )}
          </div>
          <div className="source-health">
            <button
              className="btn-ghost small"
              disabled={test === 'sending'}
              onClick={() => void sendTest()}
            >
              {test === 'sending' ? 'Sending…' : 'Send a test notification'}
            </button>
          </div>
        </li>
      </ul>
    </>
  )
}
