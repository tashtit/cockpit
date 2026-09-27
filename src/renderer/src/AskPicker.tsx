import { useId, useState, type JSX } from 'react'
import type { AskPrompt, SessionProvider } from '../../shared/types'
import { formatAskAnswer } from '../../shared/asks'
import { PROVIDER_LABEL, QuestionIcon } from './logos'
import { Markdown } from './Markdown'

/** The answer the person writes when none of the agent's fits — held while unpicked */
type Other = { readonly on: boolean; readonly text: string }

/**
 * The agent stopped to ask: its questions, with the answers it offered as picks — and
 * `Other` under them, for when none of those is the answer. The agents' own prompts
 * offer the same escape (Claude's lists end in one), so a card without it would force
 * a pick the person disagrees with, or a detour through the composer.
 *
 * Cockpit never holds the process that is waiting (most sessions run in a terminal
 * or the provider's own app), so a pick is not a keystroke into that prompt — it is
 * the next message on the session, worded from the question. That is what the note
 * under the options says, and why nothing sends until the key is pressed.
 */
export function AskPicker({
  prompts,
  provider,
  disabled,
  note,
  onAnswer,
  plan,
  onOpenPlan
}: {
  prompts: readonly AskPrompt[]
  provider: SessionProvider
  /** A turn is running (or the session takes no input) — the answer can't go yet */
  disabled: boolean
  /** Where the answer goes instead, when not here — replaces the sends-as-a-message note */
  note?: string
  onAnswer: (text: string) => void
  /** The plan an approval question is about: read here, before the pick */
  plan?: string
  /** Opens the plan in the Work panel, for a long one */
  onOpenPlan?: () => void
}): JSX.Element {
  const id = useId()
  // one entry per question, in the order asked; a single-select question holds at most one
  const [picks, setPicks] = useState<readonly (readonly string[])[]>(() => prompts.map(() => []))
  const [others, setOthers] = useState<readonly Other[]>(() => prompts.map(() => ({ on: false, text: '' })))

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicks((prev) =>
      prev.map((picked, i) => {
        if (i !== qi) return picked
        if (!multi) return picked[0] === label ? [] : [label]
        return picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label]
      })
    )
    // a single answer is one answer: picking an offered one sets the written one aside
    if (!multi) setOthers((prev) => prev.map((o, i) => (i === qi ? { ...o, on: false } : o)))
  }

  const toggleOther = (qi: number, multi: boolean): void => {
    setOthers((prev) => prev.map((o, i) => (i === qi ? { ...o, on: !o.on } : o)))
    if (!multi) setPicks((prev) => prev.map((picked, i) => (i === qi ? [] : picked)))
  }

  const write = (qi: number, text: string): void => {
    setOthers((prev) => prev.map((o, i) => (i === qi ? { ...o, text } : o)))
  }

  // what each question is answered with: the offered picks, then the written one — an
  // Other left empty is no answer yet
  const answers = picks.map((picked, i) => {
    const other = others[i]
    const written = other?.on ? other.text.trim() : ''
    return written ? [...picked, written] : picked
  })
  // every question wants an answer: a half-filled reply reads as an answer to the
  // first question and silence on the rest
  const complete = answers.every((p) => p.length > 0)
  const answer = formatAskAnswer(prompts, answers)
  const send = (): void => {
    if (!disabled && complete && answer) onAnswer(answer)
  }

  return (
    <section className={`ask-card tint-${provider}`} aria-label={`${PROVIDER_LABEL[provider]} is asking you`}>
      <div className="ask-title">
        <span className={`asks-mark plogo-${provider}`} aria-hidden="true">
          <QuestionIcon size={11} />
        </span>
        asks you
      </div>
      {plan && (
        <div className="ask-plan">
          {/* the card's own scroller: reachable by keyboard, named for what it holds */}
          <div className="ask-plan-body markdown" role="region" aria-label="The plan" tabIndex={0}>
            <Markdown text={plan} />
          </div>
          {onOpenPlan && (
            <button className="btn-ghost small ask-plan-open" onClick={onOpenPlan}>
              Open in the Work panel
            </button>
          )}
        </div>
      )}
      {prompts.map((p, qi) => {
        const multi = p.multiSelect === true
        const other = others[qi] ?? { on: false, text: '' }
        return (
          <fieldset className="ask-q" key={`${qi}-${p.question}`}>
            <legend className="ask-legend">
              {p.header ?? `Question ${qi + 1}`}
              {multi && <span className="ask-multi"> · pick any</span>}
            </legend>
            <p className="ask-question">{p.question}</p>
            <div className="ask-opts">
              {p.options.map((o) => {
                const on = picks[qi]?.includes(o.label) ?? false
                return (
                  <label className={`ask-opt ${on ? 'on' : ''}`} key={o.label}>
                    <input
                      type={multi ? 'checkbox' : 'radio'}
                      name={`${id}-q${qi}`}
                      checked={on}
                      disabled={disabled}
                      onChange={() => toggle(qi, o.label, multi)}
                    />
                    <span className="ask-opt-text">
                      <span className="ask-opt-label">{o.label}</span>
                      {o.description && <span className="ask-opt-desc">{o.description}</span>}
                    </span>
                  </label>
                )
              })}
              <label className={`ask-opt ${other.on ? 'on' : ''}`}>
                <input
                  type={multi ? 'checkbox' : 'radio'}
                  name={`${id}-q${qi}`}
                  checked={other.on}
                  disabled={disabled}
                  onChange={() => toggleOther(qi, multi)}
                />
                <span className="ask-opt-text">
                  <span className="ask-opt-label">Other</span>
                  <span className="ask-opt-desc">None of these — write your own answer</span>
                </span>
              </label>
              {other.on && (
                <textarea
                  className="ask-other"
                  aria-label={`Your own answer to: ${p.question}`}
                  placeholder="Your answer…  (Enter to send, Shift+Enter for newline)"
                  value={other.text}
                  disabled={disabled}
                  // appears because it was just asked for: the person means to type here
                  autoFocus
                  onChange={(e) => write(qi, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      send()
                    }
                  }}
                />
              )}
            </div>
          </fieldset>
        )
      })}
      <div className="ask-actions">
        <span className="ask-note">{note ?? 'Sends as your next message.'}</span>
        <button
          className="btn-primary"
          disabled={disabled || !complete}
          title={complete ? 'Send this answer to the agent' : 'Pick or write an answer to every question first'}
          onClick={send}
        >
          Send answer
        </button>
      </div>
    </section>
  )
}
