import { useId, useState, type JSX } from 'react'
import type { AskPrompt, Provider } from '../../shared/types'
import { formatAskAnswer } from '../../shared/asks'
import { PROVIDER_LABEL, QuestionIcon } from './logos'
import { Markdown } from './Markdown'

/**
 * The agent stopped to ask: its questions, with the answers it offered as picks.
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
  onAnswer,
  plan,
  onOpenPlan
}: {
  prompts: readonly AskPrompt[]
  provider: Provider
  /** A turn is running (or the session takes no input) — the answer can't go yet */
  disabled: boolean
  onAnswer: (text: string) => void
  /** The plan an approval question is about: read here, before the pick */
  plan?: string
  /** Opens the plan in the Work panel, for a long one */
  onOpenPlan?: () => void
}): JSX.Element {
  const id = useId()
  // one entry per question, in the order asked; a single-select question holds at most one
  const [picks, setPicks] = useState<readonly (readonly string[])[]>(() => prompts.map(() => []))

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicks((prev) =>
      prev.map((picked, i) => {
        if (i !== qi) return picked
        if (!multi) return picked[0] === label ? [] : [label]
        return picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label]
      })
    )
  }

  // every question wants an answer: a half-filled reply reads as an answer to the
  // first question and silence on the rest
  const complete = picks.every((p) => p.length > 0)
  const answer = formatAskAnswer(prompts, picks)

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
      {prompts.map((p, qi) => (
        <fieldset className="ask-q" key={`${qi}-${p.question}`}>
          <legend className="ask-legend">
            {p.header ?? `Question ${qi + 1}`}
            {p.multiSelect && <span className="ask-multi"> · pick any</span>}
          </legend>
          <p className="ask-question">{p.question}</p>
          <div className="ask-opts">
            {p.options.map((o) => {
              const on = picks[qi]?.includes(o.label) ?? false
              return (
                <label className={`ask-opt ${on ? 'on' : ''}`} key={o.label}>
                  <input
                    type={p.multiSelect ? 'checkbox' : 'radio'}
                    name={`${id}-q${qi}`}
                    checked={on}
                    disabled={disabled}
                    onChange={() => toggle(qi, o.label, p.multiSelect === true)}
                  />
                  <span className="ask-opt-text">
                    <span className="ask-opt-label">{o.label}</span>
                    {o.description && <span className="ask-opt-desc">{o.description}</span>}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      ))}
      <div className="ask-actions">
        <span className="ask-note">Sends as your next message — or write your own answer below.</span>
        <button
          className="btn-primary"
          disabled={disabled || !complete}
          title={complete ? 'Send this answer to the agent' : 'Pick an answer to every question first'}
          onClick={() => answer && onAnswer(answer)}
        >
          Send answer
        </button>
      </div>
    </section>
  )
}
