import { useState, type JSX } from 'react'
import type { AttentionPrefs, AttentionTone, NotificationDelivery, SoundPlayback } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { useLoaded } from './use-loaded'

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
    note: 'Two notes rising when a turn finishes, a tap-tap and a lift when an agent asks you something, two notes falling when a turn fails or a pull request goes red.'
  },
  {
    key: 'badge',
    label: 'Dock badge',
    note: 'How many sessions need you that you haven’t opened yet.'
  },
  {
    key: 'cleanup',
    label: 'Cleanup reminders',
    note: 'A daily look at what has gone idle past Cleanup’s threshold. When something new has, Cleanup gets a dot in the sidebar and you get a notification — at most once a week, never with a sound.'
  }
]

/** The preview keys, in the order a turn meets them; `about` finishes "the sound for …" */
const TONES: ReadonlyArray<{
  readonly tone: AttentionTone
  readonly label: string
  readonly about: string
}> = [
  { tone: 'finish', label: 'Finished', about: 'a finished turn' },
  { tone: 'asks', label: 'Asks you', about: 'an agent asking you' },
  { tone: 'fail', label: 'Failed', about: 'a failure or a red pull request' }
]

type TestState = 'idle' | 'sending' | NotificationDelivery

/** What a preview key's press did, in words — never "played" for a sound nobody heard. */
function heardLine(r: SoundPlayback, about: string): string {
  if (r.played) return `Played the sound for ${about}`
  switch (r.why) {
    case 'muted':
      return `The sound for ${about} is silent: the Alert volume in System Settings › Sound is at zero, and Cockpit’s sounds follow it`
    case 'unsupported':
      return 'Cockpit plays its sounds only on macOS'
    case 'failed':
      return `Could not play the sound: ${r.message ?? 'the player failed'}`
  }
}

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
  const { value: prefs, set: setPrefs } = useLoaded(() => api.getAttentionPrefs(), [])
  const [test, setTest] = useState<TestState>('idle')

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

  const hear = async (t: (typeof TONES)[number]): Promise<void> => {
    try {
      onStatus(heardLine(await api.playSound(t.tone), t.about))
    } catch (err) {
      onStatus(`Could not play the sound: ${ipcErrorText(err)}`)
    }
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
        <li className="source-row">
          <div className="source-body">
            <div className="source-label" id="attn-hear-label">
              Hear each sound
            </div>
            <div className="source-note">Plays it once, whether Sound is on or not.</div>
          </div>
          {/* the group lends each key its context: "Hear each sound, Asks you" */}
          <div className="source-health" role="group" aria-labelledby="attn-hear-label">
            {TONES.map((t) => (
              <button
                key={t.tone}
                className="btn-ghost small"
                title={`Play the sound for ${t.about}`}
                onClick={() => void hear(t)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </li>
      </ul>
    </>
  )
}
