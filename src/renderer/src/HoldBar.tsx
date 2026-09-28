import type { JSX } from 'react'
import type { SessionControl, SessionProvider } from '../../shared/types'
import { isDrivable } from '../../shared/providers'
import { holderName, placeOf } from './hold'
import { HeldIcon, ProcessIcon, ProviderLogo, PROVIDER_LABEL, XIcon } from './logos'

/**
 * Who drives the session, and the way to change it — docked above the composer like a
 * permission card. A session with its agent always shows it (Take over is the one step
 * between reading it and sending to it); one Cockpit holds shows it from the header's
 * chip, to release it or to resume it in the agent's own CLI.
 */
export function HoldBar({
  control,
  provider,
  busy,
  elsewhere,
  asking = false,
  pending,
  onTakeOver,
  onRelease,
  onResume,
  onClose
}: {
  control: SessionControl
  provider: SessionProvider
  /** Cockpit's own turn is running — not the moment to hand the session back */
  busy: boolean
  /** The agent is running a turn outside Cockpit — not the moment to take it over */
  elsewhere: boolean
  /** That turn is stopped on a question the agent asked there: it waits for as long as the
   *  question does, so it ends when the person answers it — never on its own */
  asking?: boolean
  /** A change of hands is on its way to main */
  pending: boolean
  onTakeOver: () => void
  onRelease: () => void
  onResume: () => void
  /** Hide the bar (a session Cockpit holds) — the caller hands focus back to its chip */
  onClose: () => void
}): JSX.Element {
  const agent = PROVIDER_LABEL[provider]
  const held = control.holder === 'cockpit'
  const place = placeOf(control, provider)
  const why = held
    ? control.how === 'taken-over'
      ? `taken over from ${agent}, so Cockpit sends its turns. Release it to hand it back.`
      : `started here, so Cockpit sends its turns. Release it to carry on in ${agent} instead.`
    : elsewhere
      ? asking
        ? `${agent} is waiting for your answer ${place ? `in ${place}` : 'outside Cockpit'} — answer it there, then take it over.`
        : `${agent} is working on it ${place ? `in ${place}` : 'outside Cockpit'} right now — take it over once that turn ends.`
      : control.how === 'released'
        ? `released from Cockpit, which only follows its log. Take it over to send from here.`
        : place
          ? `opened outside Cockpit. Cockpit only follows its log; to send from here, close it in ${place} and take it over.`
          : control.surface === 'headless'
            ? `run headless outside Cockpit — a script, or ${agent}’s own -p mode. Cockpit only follows its log; take it over to send from here.`
            : `opened outside Cockpit — in a terminal or ${agent}’s own app. Cockpit only follows its log; take it over to send from here.`
  // a turn running would be pulled from under: Cockpit's own holds up a release, the
  // agent's a take-over, and either one a second CLI opened on the same log
  const ourTurn = 'Cockpit is running a turn in it — stop it, or let it finish, first'
  const theirTurn = asking
    ? `${agent} is waiting for your answer in it — answer it there first`
    : `${agent} is running a turn in it — wait for that turn to end`
  const blocked = held ? busy : elsewhere
  const blockedWhy = held ? ourTurn : theirTurn
  const resumeBlocked = busy || elsewhere
  const resumeWhy = busy ? ourTurn : theirTurn
  // a disabled key can't take focus, so its title reaches neither the keyboard nor a
  // screen reader: what holds one back is said in the sentence everyone reads too. A
  // session with its agent already says it — the turn elsewhere is what it waits on
  const holdup = held
    ? busy
      ? 'Cockpit is running a turn in it — stop it, or let it finish, to release it.'
      : elsewhere && isDrivable(provider)
        ? asking
          ? `${agent} is waiting for your answer outside Cockpit — answer it there; Open in Terminal waits for it.`
          : `${agent} is running a turn in it outside Cockpit — Open in Terminal waits for that turn to end.`
        : null
    : busy && isDrivable(provider)
      ? 'Cockpit is running a turn in it — Open in Terminal waits for it to end.'
      : null
  return (
    <div
      className={`hold-bar ${held ? 'held' : `acct-${provider}`}`}
      id="hold-bar"
      role="region"
      aria-label="Who drives this session"
    >
      <span className="hold-mark" aria-hidden="true">
        {held ? <HeldIcon size={12} /> : <ProviderLogo p={provider} size={12} />}
      </span>
      <p className="hold-text">
        <strong>{holderName(control, provider)}</strong> — {why}
        {holdup && ` ${holdup}`}
      </p>
      <div className="hold-actions">
        {/* only a CLI Cockpit runs has a resume command to hand a terminal; one driven
            over ACP is picked up in its own app */}
        {isDrivable(provider) && (
          <button
            className="btn-ghost small"
            disabled={resumeBlocked || pending}
            title={
              resumeBlocked
                ? resumeWhy
                : `${held ? 'Release it and resume' : 'Resume'} it in ${agent}’s own CLI, in a Terminal window`
            }
            onClick={onResume}
          >
            <ProcessIcon size={11} /> Open in Terminal
          </button>
        )}
        {held ? (
          <>
            <button
              className="btn-ghost small"
              disabled={blocked || pending}
              title={blocked ? blockedWhy : `Hand it back to ${agent} — Cockpit stops sending to it`}
              onClick={onRelease}
            >
              Release to {agent}
            </button>
            <button className="icon-btn small" aria-label="Hide this bar" title="Hide" onClick={onClose}>
              <XIcon />
            </button>
          </>
        ) : (
          <button
            className="btn-primary hold-take"
            disabled={blocked || pending}
            title={blocked ? blockedWhy : 'Cockpit sends its turns from here on'}
            onClick={onTakeOver}
          >
            Take over
          </button>
        )}
      </div>
    </div>
  )
}
