import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { PermissionMode, PrStatus, SessionControl, SessionHolder } from '../../shared/types'
import { api } from './api'
import { useTranscriptAnchor } from './anchor-scroll'
import { AskPicker } from './AskPicker'
import type { ChatBinding, PendingPermission, TranscriptAnchor } from './chat-binding'
import { AttachRow, useImageAttachments } from './attachments'
import { CHAT_WIDTH_CSS, useChatWidth } from './chat-width'
import { useChatKeys, useChatLog, useChatStatus } from './chat-log'
import { CopyPath } from './CopyPath'
import { MODES, rememberMode, savedMode } from './agent-choice'
import { cwdLabel } from '../../shared/library'
import { holdSentence, holderName, placeOf } from './hold'
import { HoldBar } from './HoldBar'
import {
  BranchChip,
  CockpitLogo,
  DiffIcon,
  HandoffIcon,
  HeldIcon,
  PrBadge,
  ProviderLogo,
  PROVIDER_LABEL,
  SideChatIcon,
  WorkIcon
} from './logos'
import { Message, ToolRun } from './Message'
import { PermissionAsk } from './PermissionAsk'
import { ReviewPanel } from './ReviewPanel'
import { SideChat } from './SideChat'
import { sideChatSupported } from '../../shared/side-chat'
import type { SideTarget } from './side-chat-log'
import { Select } from './Select'
import { promptsOf, samePrompts, usePromptNav, type Prompt } from './prompt-nav'
import { PromptRail } from './PromptRail'
import { foldToolRuns, isPendingAsk, transcriptRows } from './transcript-rows'
import { EarlierRow, JumpToLatest, useTranscriptWindow, useUnseenBelow } from './transcript-window'
import { useLoaded } from './use-loaded'
import { useWorkPanel } from './work-panel-state'
import { WorkPanel } from './WorkPanel'

/** Big transcripts are already tail-capped in main; this bounds the DOM too — the
 *  newest rows first, and "show earlier" brings the next batch of this size. */
const RENDER_LAST = 400

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
  onStartFollowUp,
  onOpenLineage,
  permissions,
  onAnswerPermission,
  control = null,
  onSetHolder,
  onResumeInTerminal,
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
  /** Start a session on work this one's agent suggested: the new-session form, filled in */
  onStartFollowUp?: (followUp: { readonly title: string; readonly prompt: string; readonly cwd?: string }) => void
  onOpenLineage: (sourceId: string) => void
  permissions: readonly PendingPermission[]
  onAnswerPermission: (ask: PendingPermission, optionId: string) => void
  /** Who drives this session — Cockpit, or its agent outside it (main's record); null
   *  while unknown, and for a seat, which its table drives */
  control?: SessionControl | null
  /** Take the session over, or release it back to its agent; resolves true once it did */
  onSetHolder?: (holder: SessionHolder) => Promise<boolean>
  /** Release it and resume it in its agent's own CLI, in Terminal; resolves true once opened */
  onResumeInTerminal?: () => Promise<boolean>
  /** The message to open on, from a transcript-search hit; null opens at the bottom */
  anchor?: TranscriptAnchor | null
}): JSX.Element {
  // the transcript is the app's hottest state and this is its only reader —
  // subscribing here keeps a streaming turn out of every other view (chat-log.ts)
  const log = useChatLog()
  const keys = useChatKeys()
  const announced = useChatStatus()
  const [draft, setDraft] = useState('')
  const atts = useImageAttachments()
  const [mode, setMode] = useState<PermissionMode>(savedMode)
  /** Review mode: the worktree's changes take the transcript's place */
  const [review, setReview] = useState(false)
  /** Side chat beside the transcript, in the Work panel's slot: when it last opened, or closed */
  const [side, setSide] = useState<number | null>(null)
  const sideOpener = useRef<HTMLElement | null>(null)
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
  // the person's own messages, for the rail and ⌥⌘↑/↓: the same array until one of them
  // arrives, changes or leaves, so a stream flush never redraws the rail
  const promptsRef = useRef<readonly Prompt[]>([])
  const prompts = useMemo(() => {
    const next = promptsOf(log, keys)
    if (samePrompts(promptsRef.current, next)) return promptsRef.current
    promptsRef.current = next
    return next
  }, [log, keys])
  const railed = prompts.length > 1
  const nav = usePromptNav(scrollRef, atBottomRef, {
    prompts,
    total: log.length,
    limit,
    raise,
    enabled: !review,
    resetKey: conversation
  })

  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [log, busy, elsewhere])

  // a transcript-search hit: the message it meant, brought into view and ringed
  const anchoredKey = useTranscriptAnchor(anchor, { log, keys, limit, raise, scrollRef, atBottomRef })

  // focus follows the conversation: opening/starting a session lands in the composer
  useEffect(() => {
    if (binding) composerRef.current?.focus()
  }, [binding?.cwd, binding?.nativeSessionId === null])

  /** The hold bar opened from the header chip on a session Cockpit holds (one with its
   *  agent always shows it), and what the last change of hands said, for the status line */
  const [holdOpen, setHoldOpen] = useState(false)
  const [holdPending, setHoldPending] = useState(false)
  const [holdSaid, setHoldSaid] = useState('')
  useEffect(() => {
    setHoldOpen(false)
    setHoldSaid('')
  }, [conversation])
  // a turn's own announcements take the status line back
  useEffect(() => {
    if (busy) setHoldSaid('')
  }, [busy])

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
    setSide(null)
  }, [binding?.cwd])

  // what the transcript draws: worked out when the log or its window moves, not on
  // every keystroke in the composer
  const { shown, visible } = useMemo(() => transcriptRows(log, keys, limit), [log, keys, limit])
  const hidden = log.length - shown

  // the agent's question is answerable while it is the last thing in the transcript
  // and nothing has answered it — an older one is history, and a seat session's
  // conversation belongs to its table
  const lastRow = visible[visible.length - 1]
  const pendingAsk = lastRow && isPendingAsk(lastRow) && !binding?.readOnly ? lastRow : undefined
  const pendingPlanKey = pendingAsk?.m.artifact?.kind === 'plan' ? pendingAsk.key : null

  // the agent's plan, to-dos and edits beside the conversation (work-panel-state.ts) — one
  // panel beside the conversation at a time, so opening it closes the side chat
  const { work, workable, model, workFocus, pendingPlanAt, openWork, closeWork, hideWork, workTab, toggleWork } =
    useWorkPanel({ log, keys, cwd: binding?.cwd, pendingPlanKey, onOpen: () => setSide(null) })

  // side chat: questions about this session, asked of a copy of it — offered once there
  // is a session to copy, by an agent whose CLI can copy one without writing to it. A
  // running turn is no reason to hold it: asking mid-turn is the point
  const sideable = !!binding?.nativeSessionId && !binding.readOnly && sideChatSupported(binding.provider)
  const sideTarget = useMemo<SideTarget | null>(
    () =>
      binding?.nativeSessionId && sideable
        ? {
            provider: binding.provider,
            cwd: binding.cwd,
            nativeSessionId: binding.nativeSessionId,
            options: binding.options,
            configDir: binding.configDir
          }
        : null,
    [sideable, binding?.provider, binding?.cwd, binding?.nativeSessionId, binding?.options, binding?.configDir]
  )
  const openSide = useCallback(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !active.closest('#side-chat')) sideOpener.current = active
    hideWork()
    setSide(Date.now())
  }, [hideWork])
  const closeSide = useCallback(() => {
    setSide(null)
    const back = sideOpener.current
    sideOpener.current = null
    if (back?.isConnected) back.focus()
  }, [])
  const toggleSide = (): void => (side !== null ? closeSide() : openSide())
  const toggleSideRef = useRef(toggleSide)
  toggleSideRef.current = toggleSide
  // ⌘L opens and closes it (the palette owns the keyboard while it is open)
  useEffect(() => {
    if (!sideable) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'l' || document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      toggleSideRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sideable])

  /** Changes, from the header, ⌘D or the Edits tab. Where the panel covers the
   *  conversation (a narrow deck), the review would open unseen behind it — so it
   *  gives way first; beside the conversation it stays, to read the two together. */
  const toggleReview = useCallback(() => {
    if (panelCovers()) {
      closeWork()
      closeSide()
    }
    setReview((v) => !v)
  }, [closeWork, closeSide])
  const reviewRef = useRef(review)
  reviewRef.current = review
  /** The Edits tab's way to the real diff: opens it, never closes it */
  const openChanges = useCallback(() => {
    if (!reviewRef.current) toggleReview()
  }, [toggleReview])

  // ⌘D flips between the conversation and its changes (the palette owns the
  // keyboard while it is open — a dialog on screen means leave it alone)
  useEffect(() => {
    if (!reviewable) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'd' || document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      toggleReview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reviewable, toggleReview])

  /** Review notes and fix prompts land in the composer, ready to send — the reviewer
   *  gets the last word. Stable, so the memoized review is not redrawn by this view's
   *  every stream flush and keystroke. */
  const compose = useCallback((text: string): void => {
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${text}` : text))
    composerRef.current?.focus()
  }, [])
  /** A side answer on its way into the message: a panel covering the composer steps aside */
  const composeFromSide = useCallback(
    (text: string): void => {
      if (panelCovers()) setSide(null)
      compose(text)
    },
    [compose]
  )

  const branchPr = useMemo(
    () => (binding?.branch ? prs.find((p) => p.headRefName === binding.branch) : undefined),
    [prs, binding?.branch]
  )
  const chatWidth = useChatWidth()

  // a session sitting on the branch a PR would target (the main checkout on `main`)
  // can't open one — gh refuses a PR from a branch onto itself. Unknown default =
  // offer it anyway: a missing answer must never hide a working affordance.
  const repoRoot = binding?.repoRoot
  const { value: defaultBranch } = useLoaded(
    repoRoot ? () => api.getDefaultBranch(repoRoot) : null,
    [binding?.repoRoot],
    { reset: true }
  )
  const onDefaultBranch = !!binding?.branch && binding.branch === defaultBranch

  // a long stretch of tool calls is one piece of work, not twenty rows of it: four or
  // more in a row fold into a work-log block that says what happened. The run a turn
  // is still producing never folds — watching it is the point while it runs.
  const live = busy || elsewhere
  const blocks = useMemo(() => foldToolRuns(visible, live), [visible, live])

  // a blocked agent is the most important thing on the screen — it speaks over
  // whatever the turn last said. Otherwise chat-log.ts owns the announcements, and
  // the working line is only the fallback for a turn that has not announced one
  // (App does, at every turn start) — never an override, or a mid-turn error would
  // be the one thing a reader never hears.
  // a session with its agent is shown, never sent to: Cockpit follows its log, and the
  // person takes it over — one explicit step — before anything here resumes it
  const withAgent = control?.holder === 'agent' && !binding?.readOnly
  const status =
    (permissions.length ? `Permission needed: ${permissions[0].preview}` : announced) ||
    holdSaid ||
    (busy && binding ? `${PROVIDER_LABEL[binding.provider]} is working…` : '') ||
    (elsewhere && binding
      ? `${PROVIDER_LABEL[binding.provider]} is ${pendingAsk ? 'waiting for your answer' : 'working'} elsewhere…`
      : '')

  // a turn running in a terminal is not Cockpit's to interrupt, and resuming the
  // session under it would run a second turn on the same log — Send waits for it
  const sendBlocked = busy || elsewhere || withAgent
  // where the turn elsewhere runs, when the log named the place it was opened in
  const where = (control && binding && placeOf(control, binding.provider)) || 'a terminal or its own app'
  const elsewhereHint = binding
    ? elsewhere
      ? `${PROVIDER_LABEL[binding.provider]} is working on this session in ${where} — Send waits for that turn to finish`
      : withAgent
        ? `This session is with ${PROVIDER_LABEL[binding.provider]} — take it over to send from Cockpit`
        : undefined
    : undefined
  // the process that asked is still waiting on its own prompt: answering here too would
  // resume the session under it, so the card says where the answer goes instead
  const askElsewhereNote =
    elsewhere && binding
      ? `${PROVIDER_LABEL[binding.provider]} is waiting for this in ${where} — answer it there. Send waits for that turn to finish.`
      : withAgent && binding
        ? `This session is with ${PROVIDER_LABEL[binding.provider]} — answer it there, or take it over to answer here.`
        : undefined

  /** Change hands: the bar's buttons, each saying what happened once main agrees. */
  const changeHands = (to: SessionHolder): void => {
    if (!onSetHolder || holdPending || !binding) return
    setHoldPending(true)
    void onSetHolder(to)
      .then((ok) => {
        if (!ok) return
        if (to === 'cockpit') {
          setHoldSaid('Taken over — Cockpit sends this session’s turns now')
          composerRef.current?.focus()
        } else {
          setHoldSaid(`Released to ${PROVIDER_LABEL[binding.provider]} — Cockpit only follows its log now`)
          setHoldOpen(false)
        }
      })
      .finally(() => setHoldPending(false))
  }
  const resumeThere = (): void => {
    if (!onResumeInTerminal || holdPending || !binding) return
    setHoldPending(true)
    void onResumeInTerminal()
      .then((ok) => {
        if (ok) setHoldSaid(`Released and resumed in Terminal — continue it with ${PROVIDER_LABEL[binding.provider]} there`)
      })
      .finally(() => setHoldPending(false))
  }

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
            {/* who drives it, first: a session Cockpit holds opens its bar from here
                (release, resume in Terminal); one with its agent always shows the bar */}
            {control &&
              !binding.readOnly &&
              (control.holder === 'cockpit' ? (
                <button
                  className="acct-chip hold-chip held"
                  aria-expanded={holdOpen}
                  aria-controls={holdOpen ? 'hold-bar' : undefined}
                  title={`${holdSentence(control, binding.provider)} — click to release it`}
                  onClick={() => setHoldOpen((v) => !v)}
                >
                  <HeldIcon size={10} />
                  <span className="chip-text">{holderName(control, binding.provider)}</span>
                </button>
              ) : (
                <span
                  className={`acct-chip hold-chip acct-${binding.provider}`}
                  title={holdSentence(control, binding.provider)}
                >
                  <ProviderLogo p={binding.provider} size={10} />
                  <span className="chip-text">{holderName(control, binding.provider)}</span>
                </span>
              ))}
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
            <CopyPath
              path={binding.cwd}
              label={cwdLabel(binding.cwd, binding.repoRoot, binding.branch)}
              detail={binding.nativeSessionId ? `session ${binding.nativeSessionId}` : undefined}
            />
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
            onClick={toggleReview}
          >
            <DiffIcon />
            <span className="lbl">Changes</span>
          </button>
        )}
        {/* the agent's plan, to-dos and edits beside the conversation — offered once
            the transcript holds any of them. Its mark alone at every width: the rows
            are the way in, and a fourth label took the title's room at 900px */}
        {(workable || work) && (
          <button
            className="btn-review btn-work"
            aria-label="Work"
            aria-pressed={work !== null}
            aria-controls={work ? 'work-panel' : undefined}
            title={work ? 'Close the Work panel (⌘J)' : "Work — the agent's plan, to-dos and edits, beside the conversation (⌘J)"}
            onClick={toggleWork}
          >
            <WorkIcon />
          </button>
        )}
        {/* questions about the session that never reach it — its mark alone, like Work */}
        {sideable && (
          <button
            className="btn-review btn-work"
            aria-label="Side chat"
            aria-pressed={side !== null}
            aria-controls={side !== null ? 'side-chat' : undefined}
            title={
              side !== null
                ? 'Close the side chat (⌘L)'
                : `Side chat — ask ${PROVIDER_LABEL[binding.provider]} about this session without adding to it (⌘L)`
            }
            onClick={toggleSide}
          >
            <SideChatIcon />
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

      <div className="chat-deck">
        <div className="chat-main">
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
            // the transcript and, once there are two messages of the person's own to move
            // between, the rail of them on its right edge
            <div className={`chat-transcript${railed ? ' railed' : ''}`}>
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
                  <EarlierRow shown={shown} total={log.length} step={RENDER_LAST} onShow={showEarlier} />
                )}
                {blocks.map((b) =>
                  b.kind === 'run' ? (
                    <ToolRun
                      key={b.rows[0].key}
                      rows={b.rows}
                      provider={binding.provider}
                      cwd={binding.cwd}
                      onOpenWork={openWork}
                    />
                  ) : b.row === pendingAsk && b.row.m.asks ? (
                    // the question takes the tool row's place: its options are the point,
                    // and a collapsed ⚙︎ row hid them behind the raw JSON
                    <AskPicker
                      key={b.row.key}
                      prompts={b.row.m.asks}
                      provider={binding.provider}
                      disabled={sendBlocked}
                      note={askElsewhereNote}
                      onAnswer={sendAnswer}
                      // a plan is approved with the plan in view, never on its title alone
                      plan={b.row.m.artifact?.kind === 'plan' ? b.row.m.artifact.text : undefined}
                      onOpenPlan={() => openWork(b.row.key, 'plan')}
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
                      onOpenWork={openWork}
                    />
                  )
                )}
                {busy && (
                  <div className="thinking">
                    <span className="pulse" /> {PROVIDER_LABEL[binding.provider]} is working…
                  </div>
                )}
                {/* the same annunciator for a turn someone else is running: the log grows
                    under this view (App re-reads it as the index sees each write). A turn
                    stopped on a question is not working — the card above says what it waits on */}
                {!busy && elsewhere && !pendingAsk && (
                  <div className="thinking" title={elsewhereHint}>
                    <span className="pulse" /> {PROVIDER_LABEL[binding.provider]} is working elsewhere…
                  </div>
                )}
                {log.length === 0 && !sendBlocked && (
                  <div className="empty-chat small">Send a prompt to start this session.</div>
                )}
                <JumpToLatest on={below.unseen} onJump={below.jump} />
              </div>
              {railed && <PromptRail prompts={prompts} current={nav.current} onJump={nav.jump} />}
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

          {control && !binding.readOnly && (withAgent || holdOpen) && (
            <HoldBar
              control={control}
              provider={binding.provider}
              busy={busy}
              elsewhere={elsewhere}
              pending={holdPending}
              onTakeOver={() => changeHands('cockpit')}
              onRelease={() => changeHands('agent')}
              onResume={resumeThere}
              onClose={() => setHoldOpen(false)}
            />
          )}

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
                    rememberMode(v as PermissionMode)
                  }}
                />
                {busy ? (
                  <button className="btn-danger" onClick={onCancel}>
                    Stop
                  </button>
                ) : (
                  <button
                    className="btn-primary"
                    disabled={elsewhere || withAgent || (!draft.trim() && atts.attachments.length === 0)}
                    title={elsewhere || withAgent ? elsewhereHint : undefined}
                    onClick={submit}
                  >
                    Send
                  </button>
                )}
              </>
            )}
          </footer>
        </div>
        {workFocus && model && (
          <WorkPanel
            model={model}
            focus={workFocus}
            onTab={workTab}
            onClose={closeWork}
            cwd={binding.cwd}
            provider={binding.provider}
            pendingPlanKey={pendingPlanAt}
            onOpenChanges={reviewable ? openChanges : undefined}
            sessionId={binding.nativeSessionId ? `${binding.provider}:${binding.nativeSessionId}` : null}
            onOpenUrl={onOpenUrl}
            onStartFollowUp={onStartFollowUp}
          />
        )}
        {side !== null && sideTarget && (
          <SideChat target={sideTarget} at={side} onClose={closeSide} onCompose={composeFromSide} />
        )}
      </div>
    </main>
  )
}

/** Whether the panel beside the conversation — Work or side chat — covers it instead (a narrow deck). */
function panelCovers(): boolean {
  const panel = document.querySelector('.chat-deck > .work-panel')
  return !!panel && getComputedStyle(panel).position === 'absolute'
}
