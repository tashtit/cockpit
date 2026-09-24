import { useEffect, useRef, useState, type JSX } from 'react'
import { api } from './api'
import { UpdateIcon } from './logos'
import { turnsWord, useRestartToUpdate, useUpdatePrompt, type UpdatePrompt } from './update-prompt'

/** What the status region says when the bar changes — progress ticks stay silent. */
function announcement(p: UpdatePrompt | null): string {
  switch (p?.kind) {
    case 'available':
      return `Cockpit ${p.version} is available`
    case 'ready':
      return `Cockpit ${p.version} is ready — restart to update`
    case 'failed':
      return p.version ? `Cockpit ${p.version} could not be installed` : 'The last update could not be installed'
    default:
      return ''
  }
}

/**
 * The sidebar footer's update bar: rides on top of the footer only while an update
 * needs you, and is the one click that acts on it — fetch it, or restart into it.
 * Everything else (the switches, release notes, the full reason a step failed) stays
 * in Settings › About, which the bar opens whenever it has nothing to do itself.
 */
export function UpdateBar({ onOpenAbout }: { onOpenAbout: () => void }): JSX.Element {
  const prompt = useUpdatePrompt()
  const { armed, restart, disarm } = useRestartToUpdate()
  const [said, setSaid] = useState('')
  const lastKind = useRef<UpdatePrompt['kind'] | null>(null)

  // announce a change of kind, not every push: `downloading` ticks, and `ready` is
  // re-sent by every check that finds nothing newer
  useEffect(() => {
    const kind = prompt?.kind ?? null
    if (kind === lastKind.current) return
    lastKind.current = kind
    const text = announcement(prompt)
    if (text) setSaid(text)
  }, [prompt])
  useEffect(() => {
    if (armed !== null) setSaid(`Restarting stops ${turnsWord(armed)} Cockpit is running — press again to restart anyway`)
  }, [armed])

  return (
    <>
      {/* mounted whatever the bar shows: a live region that arrives with its text is
          one a screen reader may never read */}
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
      {prompt && <Bar prompt={prompt} armed={armed} onRestart={restart} onDisarm={disarm} onOpenAbout={onOpenAbout} />}
    </>
  )
}

function Bar({
  prompt,
  armed,
  onRestart,
  onDisarm,
  onOpenAbout
}: {
  prompt: UpdatePrompt
  armed: number | null
  onRestart: () => void
  onDisarm: () => void
  onOpenAbout: () => void
}): JSX.Element {
  switch (prompt.kind) {
    case 'available':
      return (
        <button
          className="footer-update"
          onClick={() => void api.downloadUpdate()}
          aria-label={`Download Cockpit ${prompt.version}`}
          title={`Cockpit ${prompt.version} is out. Download it now — it installs when you restart.`}
        >
          <UpdateIcon />
          <span className="footer-update-label">Update available</span>
          <span className="footer-update-ver">{prompt.version}</span>
        </button>
      )
    case 'downloading':
      return (
        <button
          className="footer-update"
          onClick={onOpenAbout}
          aria-label={`Downloading Cockpit ${prompt.version} — open About`}
          title={`Downloading Cockpit ${prompt.version}. It is checked before anything installs.`}
        >
          <UpdateIcon />
          <span className="footer-update-label">Downloading update</span>
          <span className="footer-update-ver">{prompt.percent}%</span>
        </button>
      )
    case 'ready':
      if (armed !== null) {
        return (
          <button
            className="footer-update armed"
            onClick={onRestart}
            onBlur={onDisarm}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                onDisarm()
              }
            }}
            aria-label={`Confirm: restarting stops ${turnsWord(armed)} Cockpit is running`}
            title={`Cockpit is running ${turnsWord(armed)}, and restarting stops them. Click again to restart now, or let them finish first.`}
          >
            <UpdateIcon />
            <span className="footer-update-label">Stop {turnsWord(armed)} and restart?</span>
          </button>
        )
      }
      return (
        <button
          className="footer-update"
          onClick={onRestart}
          aria-label={`Restart to update Cockpit to ${prompt.version}`}
          title={`Cockpit ${prompt.version} is downloaded. Restart to install it — Cockpit opens again by itself.`}
        >
          <UpdateIcon />
          <span className="footer-update-label">Restart to update</span>
          <span className="footer-update-ver">{prompt.version}</span>
        </button>
      )
    case 'failed':
      return (
        <button
          className="footer-update failed"
          onClick={onOpenAbout}
          aria-label={`${prompt.version ? `Cockpit ${prompt.version}` : 'The last update'} could not be installed — open About`}
          title={prompt.reason}
        >
          <UpdateIcon />
          <span className="footer-update-label">Update failed</span>
          {prompt.version && <span className="footer-update-ver">{prompt.version}</span>}
        </button>
      )
  }
}
