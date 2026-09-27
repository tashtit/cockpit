import { memo, useEffect, useRef, type JSX } from 'react'
import type { Provider } from '../../shared/types'
import { SIDE_QUESTION_MAX } from '../../shared/side-chat'
import { Markdown } from './Markdown'
import { PROVIDER_LABEL, ProviderMark, XIcon } from './logos'
import { SidePanel } from './SidePanel'
import {
  askSide,
  clearSide,
  setSideDraft,
  sideKey,
  stopSide,
  useSideDraft,
  useSideThread,
  type SideEntry,
  type SideLook,
  type SideTarget
} from './side-chat-log'

/**
 * Side chat: questions about the session on screen, asked of a throwaway copy of it —
 * "why did it drop the cache?", "what's left?" — while its turn runs or not. Nothing
 * asked or answered here reaches the session; an answer worth telling the agent goes to
 * the composer (`onCompose`), where the person edits it before it is sent.
 *
 * It shares the Work panel's slot beside the conversation (`SidePanel`: the same frame,
 * the same dragged width, the same cover under 720px of deck) — one side panel at a time.
 */
export const SideChat = memo(function SideChat({
  target,
  onClose,
  onCompose,
  at
}: {
  target: SideTarget
  onClose: () => void
  /** Put an answer in the message to the session's agent; absent where nothing can be sent */
  onCompose?: (text: string) => void
  /** Bumped on every open, so opening again puts the caret back in the question */
  at: number
}): JSX.Element {
  const session = sideKey(target)
  const entries = useSideThread(session)
  const draft = useSideDraft(session)
  const agent = PROVIDER_LABEL[target.provider]
  const asking = entries.some((e) => e.state === 'asking')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // opening moves the reader in: the question field, since asking is why it opened
  useEffect(() => {
    inputRef.current?.focus()
  }, [at])

  // a question just asked goes to the bottom, where its answer will appear; an answer
  // growing follows only a reader who is still there — never hijack a scroll-up
  const last = entries[entries.length - 1]
  const atBottom = useRef(true)
  useEffect(() => {
    atBottom.current = true
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [entries.length, session])
  useEffect(() => {
    if (atBottom.current) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [last?.answer, last?.state, last?.looked.length])

  const submit = (): void => {
    if (!draft.trim() || asking) return
    askSide(target, draft)
  }

  // said once per transition, never per streamed line (the chat's own rule)
  const status =
    last?.state === 'asking'
      ? `${agent} is answering on the side…`
      : last?.state === 'answered'
        ? `${agent} answered on the side`
        : last?.state === 'failed'
          ? 'The side question failed'
          : ''

  return (
    <SidePanel id="side-chat" label="Side chat" onClose={onClose}>
      <div className="work-head side-head">
        <h2 className="ns-label side-title">Side chat</h2>
        {entries.length > 0 && (
          <button
            className="btn-ghost small"
            title="Start the side chat over — stops a question being answered and forgets this one"
            onClick={() => clearSide(session)}
          >
            Clear
          </button>
        )}
        <button
          className="icon-btn small work-close"
          aria-label="Close the side chat"
          title="Close (Esc)"
          onClick={onClose}
        >
          <XIcon />
        </button>
      </div>
      <div
        className="side-body"
        ref={bodyRef}
        role="region"
        aria-label="Side questions and answers"
        // the thread scrolls on its own: a keyboard reader must be able to reach it
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        <p className="work-note">
          Ask {agent} about this session. It answers from a copy of the conversation — nothing here reaches
          the session, and it can read files but not change them.
        </p>
        {entries.map((e) => (
          <Exchange key={e.key} entry={e} provider={target.provider} onCompose={onCompose} />
        ))}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
      <footer className="composer side-composer">
        <textarea
          ref={inputRef}
          aria-label={`Ask ${agent} on the side`}
          placeholder="Ask on the side…  (Enter to ask)"
          maxLength={SIDE_QUESTION_MAX}
          value={draft}
          onChange={(e) => setSideDraft(session, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              // a habitual Escape must not close on a half-typed question: the first one
              // leaves the field (the draft is kept either way), the next closes the panel
              e.preventDefault()
              e.stopPropagation()
              e.currentTarget.blur()
            }
          }}
        />
        {asking ? (
          <button className="btn-danger" onClick={() => stopSide(session)}>
            Stop
          </button>
        ) : (
          <button className="btn-primary" disabled={!draft.trim()} onClick={submit}>
            Ask
          </button>
        )}
      </footer>
    </SidePanel>
  )
})

/** "3 steps · Read ×2 · Grep" — the transcript's work-fold wording, for what a copy looked at. */
export function lookSummary(looked: readonly SideLook[]): string {
  const counts = new Map<string, number>()
  for (const l of looked) counts.set(l.tool, (counts.get(l.tool) ?? 0) + 1)
  const tools = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(' · ')
  return `${looked.length} ${looked.length === 1 ? 'step' : 'steps'} · ${tools}`
}

/** One question and what came back, in the transcript's own row grammar. */
const Exchange = memo(function Exchange({
  entry,
  provider,
  onCompose
}: {
  entry: SideEntry
  provider: Provider
  onCompose?: (text: string) => void
}): JSX.Element {
  const agent = PROVIDER_LABEL[provider]
  const asking = entry.state === 'asking'
  const latest = entry.looked[entry.looked.length - 1]
  return (
    <div className="side-exchange">
      <div className="msg msg-user">
        <div className="bubble bubble-user">
          <pre>{entry.question}</pre>
        </div>
      </div>
      {entry.answer && (
        <div className={`msg msg-assistant${asking ? ' streaming' : ''}`}>
          <ProviderMark p={provider} size={14} box="avatar" decorative />
          <div className="assistant-body markdown">
            <Markdown text={entry.answer} />
          </div>
        </div>
      )}
      {asking && (
        <div className="thinking">
          <span className="pulse" /> {latest ? `${agent} is looking: ${latest.what}` : `${agent} is answering…`}
        </div>
      )}
      {entry.state === 'failed' && <div className="sys-row">Side question failed: {entry.error}</div>}
      {entry.state === 'stopped' && <div className="sys-row">Stopped.</div>}
      {!asking && (entry.looked.length > 0 || (entry.state === 'answered' && onCompose)) && (
        <div className="side-foot">
          {entry.looked.length > 0 && (
            <details className="side-looked">
              <summary>{lookSummary(entry.looked)}</summary>
              <ul>
                {entry.looked.map((l, i) => (
                  // a fixed list, never reordered: its place is its identity
                  <li key={i}>
                    <code>{l.what}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {entry.state === 'answered' && onCompose && (
            <button
              className="link-btn side-use"
              title={`Put this answer in your message to ${agent} — edit it before you send`}
              onClick={() => onCompose(entry.answer)}
            >
              Add to message
            </button>
          )}
        </div>
      )}
    </div>
  )
})
