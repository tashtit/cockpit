import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { PermissionMode, Provider, PrStatus, SessionMessage } from '../../shared/types'
import { api } from './api'
import { AskPicker } from './AskPicker'
import type { ChatBinding, PendingPermission, TranscriptAnchor } from './chat-binding'
import { AttachRow, useImageAttachments } from './attachments'
import { CHAT_WIDTH_CSS, useChatWidth } from './chat-width'
import { announceChat, useChatLog, useChatStatus } from './chat-log'
import { Markdown } from './Markdown'
import { MODES } from './NewSession'
import { cwdLabel } from '../../shared/library'
import { BranchChip, CockpitLogo, DiffIcon, HandoffIcon, PrBadge, ProviderLogo, PROVIDER_LABEL } from './logos'
import { ReviewPanel } from './ReviewPanel'
import { Select } from './Select'
import { findAnchor } from './transcript-anchor'
import { EarlierRow, JumpToLatest, useTranscriptWindow, useUnseenBelow } from './transcript-window'

/** Big transcripts are already tail-capped in main; this bounds the DOM too — the
 *  newest rows first, and "show earlier" brings the next batch of this size. */
const RENDER_LAST = 400
/** Rows kept above a message a search landed on, so it reads in its context */
const ANCHOR_CONTEXT = 8
/** How long the ring stays on a message a search landed on */
const ANCHOR_RING_MS = 3_000

export function ChatView({
  binding,
  prs,
  busy,
  elsewhere,
  prBusy,
  onSend,
  onCancel,
  onCreatePr,
  onOpenUrl,
  onOpenHandoff,
  onOpenLineage,
  permissions,
  onAnswerPermission,
  anchor = null
}: {
  binding: ChatBinding | null
  prs: PrStatus[]
  busy: boolean
  /** The session's agent is running outside Cockpit right now — a terminal or its
   *  own app, judged from its log (busy.ts) — so the transcript is a live tail of
   *  someone else's turn and a message now would run a second turn on it */
  elsewhere: boolean
  prBusy: boolean
  onSend: (prompt: string, mode: PermissionMode, images?: readonly string[]) => void
  onCancel: () => void
  onCreatePr: () => void
  onOpenUrl: (url: string) => void
  onOpenHandoff: () => void
  onOpenLineage: (sourceId: string) => void
  permissions: readonly PendingPermission[]
  onAnswerPermission: (ask: PendingPermission, optionId: string) => void
  /** The message to open on, from a transcript-search hit; null opens at the bottom */
  anchor?: TranscriptAnchor | null
}): JSX.Element {
  // the transcript is the app's hottest state and this is its only reader —
  // subscribing here keeps a streaming turn out of every other view (chat-log.ts)
  const log = useChatLog()
  const announced = useChatStatus()
  const [draft, setDraft] = useState('')
  const atts = useImageAttachments()
  const [mode, setMode] = useState<PermissionMode>(
    () => (window.localStorage.getItem('cockpit:mode') as PermissionMode) ?? 'auto-edit'
  )
  const [cwdCopied, setCwdCopied] = useState(false)
  /** Review mode: the worktree's changes take the transcript's place */
  const [review, setReview] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  /** Auto-scroll only while the user is pinned to the bottom — never hijack a scroll-up. */
  const atBottomRef = useRef(true)
  /** What a reader is looking at, stable across the binding objects App makes for it */
  const conversation = binding ? `${binding.provider}|${binding.cwd}|${binding.nativeSessionId ?? ''}` : null
  // the DOM window over the log, and the way down for a reader who scrolled up. The
  // window resets per conversation, not per binding object: App re-makes the binding
  // when a parent chip or a native id arrives, and that must not shrink the window an
  // anchor just raised
  const { limit, showEarlier, raise } = useTranscriptWindow(scrollRef, RENDER_LAST, conversation)
  const below = useUnseenBelow(scrollRef, atBottomRef, log)

  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [log, busy, elsewhere])

  // a transcript-search hit: find the message it meant once the log is in, bring it
  // into the DOM window, scroll it to the middle and ring it for a moment. Applied once
  // per anchor — the log keeps growing under a live session and must not re-scroll.
  const [anchoredKey, setAnchoredKey] = useState<number | null>(null)
  const appliedAnchor = useRef<TranscriptAnchor | null>(null)
  const scrolledKey = useRef<number | null>(null)
  useEffect(() => {
    // a new anchor, or none (every open sets one): the old ring and scroll are forgotten
    // first, so the apply below — same commit, declared after — is what a new one gets
    setAnchoredKey(null)
    scrolledKey.current = null
    appliedAnchor.current = null
  }, [anchor])
  useEffect(() => {
    // the log lands after the binding and the anchor do, so this waits for it
    if (!anchor || anchor === appliedAnchor.current || log.length === 0) return
    appliedAnchor.current = anchor
    const idx = findAnchor(log, anchor)
    if (idx < 0) return
    raise(log.length - idx + ANCHOR_CONTEXT)
    setAnchoredKey(idx)
  }, [anchor, log, raise])
  useLayoutEffect(() => {
    if (anchoredKey === null || scrolledKey.current === anchoredKey) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-log-key="${anchoredKey}"]`)
    if (!el) return
    scrolledKey.current = anchoredKey
    atBottomRef.current = false
    el.scrollIntoView({ block: 'center' })
    announceChat('Showing the message that matched your search')
  }, [anchoredKey, limit])
  useEffect(() => {
    if (anchoredKey === null) return
    const t = setTimeout(() => setAnchoredKey(null), ANCHOR_RING_MS)
    return () => clearTimeout(t)
  }, [anchoredKey])

  useEffect(() => {
    if (!cwdCopied) return
    const t = setTimeout(() => setCwdCopied(false), 1500)
    return () => clearTimeout(t)
  }, [cwdCopied])

  // focus follows the conversation: opening/starting a session lands in the composer
  useEffect(() => {
    if (binding) composerRef.current?.focus()
  }, [binding?.cwd, binding?.nativeSessionId === null])

  // a freshly opened session always starts pinned to the bottom — per conversation,
  // not per binding object: App re-makes the binding mid-turn (the native id from the
  // CLI's first event, a parent chip), and re-pinning then yanked a reader who had
  // scrolled up back to the bottom on the next row
  useEffect(() => {
    atBottomRef.current = true
  }, [conversation])

  // attachments belong to the conversation they were pasted into — drop them on switch
  useEffect(() => {
    atts.clear()
  }, [binding?.provider, binding?.cwd])

  // review is a way of looking at one worktree — a different session opens on its transcript
  const reviewable = !!binding?.repoRoot && !binding.readOnly
  useEffect(() => {
    setReview(false)
  }, [binding?.cwd])

  // ⌘D flips between the conversation and its changes (the palette owns the
  // keyboard while it is open — a dialog on screen means leave it alone)
  useEffect(() => {
    if (!reviewable) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'd' || document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      setReview((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reviewable])

  /** Review notes and fix prompts land in the composer, ready to send — the reviewer gets the last word. */
  const compose = (text: string): void => {
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${text}` : text))
    composerRef.current?.focus()
  }

  const branchPr = useMemo(
    () => (binding?.branch ? prs.find((p) => p.headRefName === binding.branch) : undefined),
    [prs, binding?.branch]
  )
  const chatWidth = useChatWidth()

  // a session sitting on the branch a PR would target (the main checkout on `main`)
  // can't open one — gh refuses a PR from a branch onto itself. Unknown default =
  // offer it anyway: a missing answer must never hide a working affordance.
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  useEffect(() => {
    setDefaultBranch(null)
    const root = binding?.repoRoot
    if (!root) return
    let dead = false
    void api.getDefaultBranch(root).then((b) => !dead && setDefaultBranch(b))
    return () => {
      dead = true
    }
  }, [binding?.repoRoot])
  const onDefaultBranch = !!binding?.branch && binding.branch === defaultBranch

  const sliced = log.length > limit ? log.slice(-limit) : log
  const base = log.length - sliced.length
  // providers repeat identical system notices; consecutive duplicates add nothing.
  // each row keeps its absolute log offset as the key — stable because the log is
  // append-only, even when the dedup filter drops rows in the middle.
  // a tool call and the result that answers it are one event: the result folds into
  // the call's row (its key stays the call's offset) instead of a second ↳ row
  const visible: Array<{ m: SessionMessage; key: number; result?: SessionMessage }> = []
  sliced.forEach((m, i) => {
    if (m.kind === 'system' && sliced[i - 1]?.kind === 'system' && sliced[i - 1].text === m.text)
      return
    const prev = visible[visible.length - 1]
    if (m.kind === 'tool_result' && prev?.m.kind === 'tool_call' && !prev.result) {
      prev.result = m
      return
    }
    visible.push({ m, key: base + i })
  })
  const hidden = log.length - sliced.length

  // the agent's question is answerable while it is the last thing in the transcript
  // and nothing has answered it — an older one is history, and a seat session's
  // conversation belongs to its table
  const lastRow = visible[visible.length - 1]
  const pendingAsk = lastRow && isPendingAsk(lastRow) && !binding?.readOnly ? lastRow : undefined

  // a long stretch of tool calls is one piece of work, not twenty rows of it: four or
  // more in a row fold into a work-log block that says what happened. The run a turn
  // is still producing never folds — watching it is the point while it runs.
  const blocks = foldToolRuns(visible, busy || elsewhere)

  // a blocked agent is the most important thing on the screen — it speaks over
  // whatever the turn last said. Otherwise chat-log.ts owns the announcements, and
  // the working line is only the fallback for a turn that has not announced one
  // (App does, at every turn start) — never an override, or a mid-turn error would
  // be the one thing a reader never hears.
  const status =
    (permissions.length ? `Permission needed: ${permissions[0].preview}` : announced) ||
    (busy && binding ? `${PROVIDER_LABEL[binding.provider]} is working…` : '') ||
    (elsewhere && binding ? `${PROVIDER_LABEL[binding.provider]} is working elsewhere…` : '')

  // a turn running in a terminal is not Cockpit's to interrupt, and resuming the
  // session under it would run a second turn on the same log — Send waits for it
  const sendBlocked = busy || elsewhere
  const elsewhereHint = binding
    ? `${PROVIDER_LABEL[binding.provider]} is working on this session in a terminal or its own app — Send waits for that turn to finish`
    : undefined

  /** A pick from the agent's own options: the same send path a typed message takes. */
  const sendAnswer = (text: string): void => {
    if (!text.trim() || sendBlocked || !binding) return
    onSend(text, mode)
  }


  const submit = (): void => {
    const p = draft.trim()
    if ((!p && atts.attachments.length === 0) || sendBlocked || !binding) return
    setDraft('')
    const images = atts.paths()
    atts.clear()
    onSend(p, mode, images)
  }

  if (!binding) {
    return (
      <main className="chat">
        <div className="empty-chat">
          <CockpitLogo size={52} />
          <h2>Cockpit</h2>
          <p>Pick a repository, open a session — or start one in a fresh worktree and ship it as a PR.</p>
        </div>
      </main>
    )
  }

  return (
    // the conversation column tracks the user's width preference live
    <main className="chat" style={{ '--chat-col': CHAT_WIDTH_CSS[chatWidth] } as React.CSSProperties}>
      <header className="chat-header">
        {/* the name sheds on narrow windows before the title does; the mark stays */}
        <span className={`badge badge-${binding.provider}`} title={PROVIDER_LABEL[binding.provider]}>
          <ProviderLogo p={binding.provider} size={11} />
          <span className="badge-text">{PROVIDER_LABEL[binding.provider]}</span>
        </span>
        {/* compact: the local part identifies the account at a glance; the full
            identity lives in the tooltip (same pattern as the sidebar footer) */}
        <span
          className={`acct-chip acct-${binding.provider}`}
          title={`Running as ${binding.accountLabel ?? 'default account'}`}
        >
          {(binding.accountLabel ?? 'default account').split('@')[0]}
        </span>
        <div className="chat-header-text">
          <h2 className="chat-title">{binding.title}</h2>
          <div className="chat-sub">
            {binding.continuedFrom && (
              <button
                className={`acct-chip acct-${binding.continuedFrom.provider} lineage-chip`}
                aria-label={`Continued from a ${PROVIDER_LABEL[binding.continuedFrom.provider]} session — open it`}
                title={`Continued from a ${PROVIDER_LABEL[binding.continuedFrom.provider]} session — click to open it`}
                onClick={() => binding.continuedFrom && onOpenLineage(binding.continuedFrom.id)}
              >
                <ProviderLogo p={binding.continuedFrom.provider} size={10} /> from{' '}
                {PROVIDER_LABEL[binding.continuedFrom.provider]}
              </button>
            )}
            {binding.startedBy && (
              <button
                className={`acct-chip acct-${binding.startedBy.provider} lineage-chip parent-chip`}
                aria-label={`Started by the ${PROVIDER_LABEL[binding.startedBy.provider]} session “${binding.startedBy.title}” — open it`}
                title={`Started by “${binding.startedBy.title}” — click to open it`}
                onClick={() => binding.startedBy && onOpenLineage(binding.startedBy.id)}
              >
                <ProviderLogo p={binding.startedBy.provider} size={10} /> by{' '}
                <span className="chip-text">{binding.startedBy.title}</span>
              </button>
            )}
            {binding.branch && <BranchChip branch={binding.branch} />}
            <button
              className={`chat-cwd ${cwdCopied ? 'copied' : ''}`}
              title={`${binding.cwd}${binding.nativeSessionId ? `\nsession ${binding.nativeSessionId}` : ''}\nclick to copy path`}
              onClick={() => {
                void navigator.clipboard.writeText(binding.cwd)
                setCwdCopied(true)
              }}
            >
              {cwdLabel(binding.cwd, binding.repoRoot, binding.branch)}
            </button>
            {cwdCopied && (
              <span className="copy-flash" role="status">
                copied
              </span>
            )}
            {!binding.nativeSessionId && ' · not started'}
          </div>
        </div>
        {branchPr ? (
          <PrBadge pr={branchPr} onOpen={onOpenUrl} />
        ) : (
          binding.repoRoot &&
          binding.branch &&
          !onDefaultBranch && (
            <button
              className="btn-pr"
              disabled={busy || prBusy}
              onClick={onCreatePr}
              title="Push branch and open a pull request"
            >
              {prBusy ? 'Creating PR…' : 'Create PR'}
            </button>
          )
        )}
        {/* review before landing: the worktree's changes, in the transcript's place.
            A session outside a repository has nothing to diff; a seat session's
            tree belongs to its table. */}
        {reviewable && (
          <button
            className="btn-review"
            aria-label="Changes"
            aria-pressed={review}
            title={
              review
                ? 'Back to the conversation (⌘D)'
                : "Review the worktree's changes before they ship (⌘D)"
            }
            onClick={() => setReview((v) => !v)}
          >
            <DiffIcon />
            <span className="lbl">Changes</span>
          </button>
        )}
        {/* progressive disclosure: only a started session can be handed off; a
            running turn merely disables it. A roundtable seat session is the
            table's internal, not a conversation to continue — main refuses it
            as a handoff source, so the affordance must not be offered either. */}
        {binding.nativeSessionId && !binding.readOnly && (
          <button
            className="btn-handoff"
            disabled={busy}
            onClick={onOpenHandoff}
            aria-label="Continue in another agent…"
            title="Continue this session with another agent — new session, same worktree"
          >
            <HandoffIcon size={12} />
            <span className="lbl">Continue in…</span>
          </button>
        )}
      </header>

      {review && reviewable ? (
        <ReviewPanel
          cwd={binding.cwd}
          provider={binding.provider}
          busy={busy}
          onCompose={compose}
          pr={branchPr}
          repoRoot={binding.repoRoot}
          onOpenUrl={onOpenUrl}
        />
      ) : (
        <div
          className="messages"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
            if (atBottomRef.current) below.settle()
          }}
        >
          {hidden > 0 && (
            <EarlierRow shown={sliced.length} total={log.length} step={RENDER_LAST} onShow={showEarlier} />
          )}
          {blocks.map((b) =>
            b.kind === 'run' ? (
              <ToolRun key={b.rows[0].key} rows={b.rows} provider={binding.provider} cwd={binding.cwd} />
            ) : b.row === pendingAsk && b.row.m.asks ? (
              // the question takes the tool row's place: its options are the point,
              // and a collapsed ⚙︎ row hid them behind the raw JSON
              <AskPicker
                key={b.row.key}
                prompts={b.row.m.asks}
                provider={binding.provider}
                disabled={sendBlocked}
                onAnswer={sendAnswer}
              />
            ) : (
              <Message
                key={b.row.key}
                m={b.row.m}
                provider={binding.provider}
                result={b.row.result}
                cwd={binding.cwd}
                logKey={b.row.key}
                anchored={b.row.key === anchoredKey}
              />
            )
          )}
          {busy && (
            <div className="thinking">
              <span className="pulse" /> {PROVIDER_LABEL[binding.provider]} is working…
            </div>
          )}
          {/* the same annunciator for a turn someone else is running: the log grows
              under this view (App re-reads it as the index sees each write) */}
          {!busy && elsewhere && (
            <div className="thinking" title={elsewhereHint}>
              <span className="pulse" /> {PROVIDER_LABEL[binding.provider]} is working elsewhere…
            </div>
          )}
          {log.length === 0 && !sendBlocked && (
            <div className="empty-chat small">Send a prompt to start this session.</div>
          )}
          <JumpToLatest on={below.unseen} onJump={below.jump} />
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>

      {permissions.map((ask) => (
        <PermissionAsk
          key={ask.requestId}
          ask={ask}
          provider={binding.provider}
          onAnswer={(optionId) => onAnswerPermission(ask, optionId)}
        />
      ))}

      <footer className="composer">
        {binding.readOnly ? (
          // roundtable seat-session: the table's round loop owns this conversation
          <div className="composer-readonly">
            Seat session of a roundtable — read-only. Talk to it at the table.
          </div>
        ) : (
          <>
            <AttachRow atts={atts} />
            <textarea
              ref={composerRef}
              aria-label={`Message ${PROVIDER_LABEL[binding.provider]}`}
              placeholder={`Message ${PROVIDER_LABEL[binding.provider]}…  (Enter to send, Shift+Enter for newline)`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={atts.onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />
            {/* the mode governs the next turn, so it sits beside the button that sends
                it — the same grammar as Home's composer bar, and the header stays identity */}
            <Select
              className="mode-select-wrap"
              value={mode}
              ariaLabel="Permission mode"
              options={MODES.map((m) => ({ value: m.v, label: m.label, title: m.hint }))}
              onChange={(v) => {
                setMode(v as PermissionMode)
                window.localStorage.setItem('cockpit:mode', v)
              }}
            />
            {busy ? (
              <button className="btn-danger" onClick={onCancel}>
                Stop
              </button>
            ) : (
              <button
                className="btn-primary"
                disabled={elsewhere || (!draft.trim() && atts.attachments.length === 0)}
                title={elsewhere ? elsewhereHint : undefined}
                onClick={submit}
              >
                Send
              </button>
            )}
          </>
        )}
      </footer>
    </main>
  )
}


/** A transcript row, or a folded run of consecutive tool rows. */
type Row = { m: SessionMessage; key: number; result?: SessionMessage }
type Block = { kind: 'row'; row: Row } | { kind: 'run'; rows: Row[] }

/** Four is where a run stops reading as "a couple of steps" and starts as a wall. */
const FOLD_AT = 4

/** A question the agent is still waiting on: never folded away, never a one-liner. */
export function isPendingAsk(row: Row): boolean {
  return row.m.kind === 'tool_call' && !!row.m.asks?.length && !row.result
}

export function foldToolRuns(rows: readonly Row[], busy: boolean): Block[] {
  const out: Block[] = []
  let run: Row[] = []
  const flush = (last: boolean): void => {
    // the tail run of a live turn stays open: that is the work you are watching
    if (run.length >= FOLD_AT && !(busy && last)) out.push({ kind: 'run', rows: run })
    else for (const row of run) out.push({ kind: 'row', row })
    run = []
  }
  for (const row of rows) {
    if ((row.m.kind === 'tool_call' || row.m.kind === 'tool_result') && !isPendingAsk(row)) run.push(row)
    else {
      flush(false)
      out.push({ kind: 'row', row })
    }
  }
  flush(true)
  return out
}

/** "6 steps · Bash ×3 · Edit ×2 · Read" — what the run did, in the order it did it. */
export function runSummary(rows: readonly Row[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const name = r.m.kind === 'tool_call' ? (r.m.toolName ?? 'tool') : 'result'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const tools = [...counts]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .slice(0, 4)
    .join(' · ')
  return `${rows.length} steps · ${tools}`
}

/**
 * A folded run of tool calls: one line that says what the agent did, opening to the
 * rows themselves. Collapsed by default — a twelve-step run between two paragraphs
 * of prose buried the prose.
 */
function ToolRun({
  rows,
  provider,
  cwd
}: {
  rows: Row[]
  provider: Provider
  cwd: string
}): JSX.Element {
  return (
    <details className="tool-run">
      <summary>
        <span className="tool-chip">
          <span aria-hidden="true">⚙︎ </span>
          work
        </span>
        <span className="tool-run-sum">{runSummary(rows)}</span>
      </summary>
      <div className="tool-run-rows">
        {rows.map((r) => (
          <Message key={r.key} m={r.m} provider={provider} result={r.result} cwd={cwd} />
        ))}
      </div>
    </details>
  )
}

/** Paths inside the session's own directory read relative to it — the header already
 *  names the directory, so repeating it in every tool row only pushes the file off-screen. */
function relative(text: string, cwd: string | undefined): string {
  return cwd ? text.split(`${cwd}/`).join('') : text
}

/** The first non-empty line of a tool's output: its verdict ("20 passed"), at a glance. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? ''
}

/** Memoized: during streaming only the last row's props change. */
export const Message = memo(function Message({
  m,
  provider,
  result,
  cwd,
  logKey,
  anchored = false
}: {
  m: SessionMessage
  provider: Provider
  /** The tool_result answering this tool_call, folded into the same row */
  result?: SessionMessage
  /** The session's directory — paths under it render relative */
  cwd?: string
  /** The row's absolute log offset, on the element so a search anchor can find it */
  logKey?: number
  /** The message a transcript search landed on — rings for a moment */
  anchored?: boolean
}): JSX.Element {
  const ring = anchored ? ' anchored' : ''
  if (m.kind === 'tool_call' || m.kind === 'tool_result') {
    const call = m.kind === 'tool_call'
    const peek = result ? firstLine(result.text) : ''
    return (
      <details className={`tool-row${ring}`} data-log-key={logKey}>
        <summary>
          <span className="tool-chip">
            {/* ︎ forces text presentation — the bare gear renders as color emoji on some
                platforms; aria-hidden keeps screen readers from reading the glyph aloud */}
            <span aria-hidden="true">{call ? '⚙︎ ' : '↳ '}</span>
            {call ? (m.toolName ?? 'tool') : 'result'}
          </span>
          <code className="tool-preview">{relative(m.preview ?? m.text, cwd).slice(0, 120)}</code>
          {peek && (
            // a short verdict ("ok", "20 passed") keeps its place in a narrow row; a long
            // first line gives the width back to the command (see `@container tool`)
            <span className={`tool-peek${peek.length <= 12 ? ' tool-peek-short' : ''}`}>
              <span className="sr-only">result: </span>
              {peek.slice(0, 60)}
            </span>
          )}
        </summary>
        <pre className="tool-full">{relative(m.text, cwd)}</pre>
        {result && (
          <pre className="tool-full tool-out">
            <span className="tool-out-label" aria-hidden="true">↳ </span>
            {relative(result.text, cwd)}
          </pre>
        )}
      </details>
    )
  }
  if (m.kind === 'system') {
    return (
      <div className={`sys-row${ring}`} data-log-key={logKey}>
        {m.text}
      </div>
    )
  }
  if (m.role === 'user') {
    return (
      <div className={`msg msg-user${ring}`} data-log-key={logKey}>
        <div className="bubble bubble-user">
          <pre>{m.text}</pre>
        </div>
      </div>
    )
  }
  return (
    <div
      className={`msg msg-assistant ${m.streaming ? 'streaming' : ''} ${m.kind === 'reasoning' ? 'reasoning' : ''}${ring}`}
      data-log-key={logKey}
    >
      <span className={`avatar plogo-${provider}`} aria-hidden="true">
        <ProviderLogo p={provider} size={14} />
      </span>
      <div className="assistant-body markdown">
        {m.streaming ? (
          // the in-flight message grows on every ~40ms flush — re-running the full
          // markdown+highlight pipeline over it each time is O(n²) per reply, so
          // stream as plain text and markdownify once when the turn completes
          <p className="streaming-plain">{m.text}</p>
        ) : (
          <Markdown text={m.text} />
        )}
      </div>
    </div>
  )
})

/**
 * A live ACP turn has stopped and is waiting on a decision.
 *
 * Docked between the transcript and the composer rather than written into the log: this
 * is a thing that is true *now*, and nothing else in the turn moves until it is answered.
 * It carries the agent's livery (`.tint-*`) because "this one needs you" is the same
 * signal the sidebar's asks-mark gives, in the same colour.
 *
 * Sibling of `AskPicker`, deliberately not merged with it: that one answers a question
 * *read out of a transcript* by composing the next message, which is how a session in
 * someone's terminal gets answered. This one holds the process open and answers it
 * directly, so it is one decision, not a form, and it can never be left half-filled.
 */
function PermissionAsk({
  ask,
  provider,
  onAnswer
}: {
  ask: PendingPermission
  provider: Provider
  onAnswer: (optionId: string) => void
}): JSX.Element {
  return (
    <div
      className={`perm-card tint-${provider}`}
      role="group"
      aria-label={`${PROVIDER_LABEL[provider]} needs permission: ${ask.preview}`}
    >
      <div className="perm-body">
        <span className="perm-tool">{ask.toolName}</span>
        <span className="perm-what" title={ask.detail}>
          {ask.preview}
        </span>
      </div>
      <div className="perm-actions">
        {ask.options.map((o) => (
          <button
            key={o.optionId}
            type="button"
            // allow is the affirmative action; everything else stays quiet, so the
            // safe answer is never the one styled to be clicked without reading
            className={o.kind?.startsWith('allow') ? 'btn-primary' : 'btn-ghost'}
            onClick={() => onAnswer(o.optionId)}
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  )
}
