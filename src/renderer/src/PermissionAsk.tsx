import type { JSX, ReactNode } from 'react'
import type { SessionProvider } from '../../shared/types'
import type { PendingPermission } from './chat-binding'
import { PROVIDER_LABEL } from './logos'

/**
 * A live ACP or Claude turn has stopped and is waiting on a decision.
 *
 * Docked between the transcript and the composer rather than written into the log: this
 * is a thing that is true *now*, and nothing else in the turn moves until it is answered.
 * It carries the agent's livery (`.tint-*`) because "this one needs you" is the same
 * signal the sidebar's asks-mark gives, in the same colour.
 *
 * What is being allowed is on the card itself, never only in a tooltip a keyboard or a
 * screen reader can't reach: the command whole, or any other tool's input, and what the
 * request says of itself — why it asks, the path that made it, and, in the danger colour
 * and in words, a command asking to run with the sandbox off.
 *
 * Sibling of `AskPicker`, deliberately not merged with it: that one answers a question
 * *read out of a transcript* by composing the next message, which is how a session in
 * someone's terminal gets answered. This one holds the process open and answers it
 * directly, so it is one decision, not a form, and it can never be left half-filled.
 */
export function PermissionAsk({
  ask,
  provider,
  onAnswer
}: {
  ask: PendingPermission
  provider: SessionProvider
  onAnswer: (optionId: string) => void
}): JSX.Element {
  // what is being allowed is what the card shows — a command whole, else the tool's input;
  // the agent's title is its own account of it, and sits above as the lesser line
  const shown = shownOf(ask)
  const exec = ask.toolName === 'shell'
  const unsandboxed = ask.sandboxBypass === true
  return (
    <div
      className={`perm-card tint-${provider}${shown ? ' perm-detailed' : ''}${unsandboxed ? ' perm-unsandboxed' : ''}`}
      role="group"
      aria-label={`${PROVIDER_LABEL[provider]} needs permission${unsandboxed ? ' to run outside the sandbox' : ''}: ${ask.preview}`}
    >
      <div className="perm-body">
        <span className="perm-tool">{ask.toolName}</span>
        <span className="perm-what" title={ask.preview}>
          {ask.preview}
        </span>
      </div>
      {/* in words as well as the colour: the sandbox is what keeps a command to the
          workspace, and this one asks to run without it */}
      {unsandboxed && <p className="perm-flag">Outside the sandbox — it asks to run this command with the sandbox off.</p>}
      {ask.reason && (
        <p className="perm-note">
          <span className="perm-note-k">Why it asks</span>{' '}
          <Visible text={ask.reason} />
        </p>
      )}
      {ask.blockedPath && (
        <p className="perm-note">
          <span className="perm-note-k">Path</span>{' '}
          <Visible text={ask.blockedPath} />
        </p>
      )}
      {shown && (
        <>
          {/* scrolls in itself, so it takes focus: a keyboard reader must reach the end
              of what they are allowing. Wrapped, never cut at the edge */}
          <pre
            className="perm-detail"
            tabIndex={0}
            role="region"
            aria-label={exec ? 'The command it wants to run' : 'What the tool would be given'}
            dir="ltr"
          >
            <Visible text={shown.text} />
          </pre>
          {shown.cut > 0 && (
            <p className="perm-cut">
              Truncated — {shown.cut.toLocaleString()} more {shown.cut === 1 ? 'character' : 'characters'} not
              shown
            </p>
          )}
        </>
      )}
      <div className="perm-actions">
        {ask.options.map((o) => (
          <button
            key={o.optionId}
            type="button"
            // one yes is the affirmative action. "Allow always" hands the agent every
            // later call of this kind unasked, so it must not look as safe as a single
            // yes — it and every other answer stay quiet, and the answer styled to be
            // clicked without reading is never the one that gives away the most
            className={o.kind === 'allow_once' ? 'btn-primary' : 'btn-ghost'}
            onClick={() => onAnswer(o.optionId)}
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The note main's `capText` ends a cut text with: how many characters did not come. */
const CUT_NOTE = /\n… \((\d+) more chars\)$/

/**
 * What the card shows of what would run: a command as main sends it whole, up to its
 * bound, and any other tool's input the same way. Null when another tool has nothing past
 * the headline — an agent that named no input sends its title back as the detail. A command
 * is always shown whole, even one its own title repeats: the headline is cut to one line.
 */
function shownOf(ask: PendingPermission): { readonly text: string; readonly cut: number } | null {
  const detail = ask.detail
  if (!detail.trim()) return null
  if (ask.toolName !== 'shell' && (detail === ask.preview || detail === JSON.stringify(ask.preview))) return null
  const cut = CUT_NOTE.exec(detail)
  return cut ? { text: detail.slice(0, cut.index), cut: Number(cut[1]) } : { text: detail, cut: 0 }
}

/**
 * Characters that change what a command looks like without looking like anything:
 * control characters other than newline and tab (a carriage return rewrites the line a
 * terminal shows), bidi embeddings, overrides and isolates (they reorder what is drawn,
 * so the text read is not the text run), and the zero-width and other invisible format
 * characters and fillers.
 */
const HIDDEN =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]/g

/** Text with each hidden character drawn as its code point, in a mark of its own. */
function Visible({ text }: { text: string }): JSX.Element {
  const parts: ReactNode[] = []
  let at = 0
  for (const m of text.matchAll(HIDDEN)) {
    const i = m.index
    if (i > at) parts.push(text.slice(at, i))
    const code = m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
    parts.push(
      <span key={i} className="perm-ctl" title="An invisible character, shown by its code">
        U+{code}
      </span>
    )
    at = i + m[0].length
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
