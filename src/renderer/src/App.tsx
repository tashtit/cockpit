import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import type {
  AttentionFocus,
  AttentionTarget,
  ChatEvent,
  PermissionMode,
  Provider,
  PrStatus,
  RepoGroup,
  SessionMessage,
  SessionMeta
} from '../../shared/types'
import { clampZoom } from '../../shared/window'
import { api } from './api'
import { withImageMarks, type ImageAttachment } from './attachments'
import { TreeSidebar } from './TreeSidebar'
import { ChatView } from './ChatView'
import { CleanupView } from './CleanupView'
import { CommandPalette, type PaletteViewKey } from './CommandPalette'
import { NewSession } from './NewSession'
import { HandoffView } from './HandoffView'
import type { HandoffSourceRef, StartHandoffRequest } from './HandoffView'
import { NewRoundtable } from './NewRoundtable'
import { RoundtableView } from './RoundtableView'
import { PROVIDER_LABEL } from './logos'
import { Settings, type SettingsSection } from './Settings'
import { branchHint, taskTitle } from './task-names'
import { initLanded } from './landed'
import { ProfileView } from './ProfileView'
import { AiSetup } from './AiSetup'
import { HomeView } from './HomeView'
import { DevBanner } from './DevBanner'
import { initBusySessions, spawnedTurn, useSessionRunsElsewhere } from './busy'
import { rejoinStream, type Rejoin } from './rejoin'
import { useRailWidth } from './rail'
import {
  addChatMessage,
  addChatNotice,
  announceChat,
  endChatStream,
  setChatLog,
  streamChatText
} from './chat-log'
import { preloadMarkdown } from './Markdown'
import { initTimeFormat } from './time'
import type { StartSessionRequest } from './NewSession'
import type { ChatBinding, PendingPermission, TranscriptAnchor } from './chat-binding'
import type { AccountsSnapshot } from '../../shared/types'

/** `--rail` on the grid: the width the rail was dragged to, in CSS pixels. */
const railStyle = (px: number): CSSProperties => ({ '--rail': `${px}px` }) as CSSProperties

/** `provider:nativeId` → the chip's {id, provider}; null for anything malformed
 *  (the lineage map lives in a hand-editable config file). */
function lineageRef(id: string | undefined): ChatBinding['continuedFrom'] | undefined {
  if (!id) return undefined
  const provider = id.split(':', 1)[0] as Provider
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'copilot') return undefined
  return { id, provider }
}

type View =
  | { kind: 'welcome' }
  | { kind: 'chat' }
  | { kind: 'new'; repo: RepoGroup; draft?: string; draftImages?: readonly ImageAttachment[] }
  | { kind: 'handoff'; source: HandoffSourceRef }
  | { kind: 'new-roundtable' }
  | { kind: 'roundtable'; id: string }
  | { kind: 'settings'; section?: SettingsSection; openCount?: number }
  | { kind: 'cleanup' }
  /** repoRoot null = the global agent setup; otherwise one repo's own */
  | { kind: 'extensions'; repoRoot: string | null }
  | { kind: 'profile' }

/** One place in the ⌘[/⌘] navigation history. Chat entries snapshot the binding
 *  so a previous conversation can be re-materialized; other views restore by kind. */
type NavEntry =
  | { readonly kind: 'view'; readonly view: Exclude<View, { kind: 'chat' }> }
  | { readonly kind: 'chat'; readonly binding: ChatBinding; readonly sessionId: string | null }

const NAV_MAX = 50

/** Same place = landing there again reuses the current entry instead of growing
 *  history. Chats compare by session id (id-less brand-new chats by binding
 *  identity), the new-session form by target repo + draft. */
const sameNavEntry = (a: NavEntry, b: NavEntry): boolean => {
  if (a.kind === 'chat' || b.kind === 'chat')
    return (
      a.kind === 'chat' &&
      b.kind === 'chat' &&
      a.sessionId === b.sessionId &&
      (a.sessionId !== null || a.binding === b.binding)
    )
  const av = a.view
  const bv = b.view
  if (av.kind === 'new' || bv.kind === 'new')
    return (
      av.kind === 'new' &&
      bv.kind === 'new' &&
      av.repo.key === bv.repo.key &&
      av.draft === bv.draft &&
      av.draftImages === bv.draftImages
    )
  if (av.kind === 'handoff' || bv.kind === 'handoff')
    return av.kind === 'handoff' && bv.kind === 'handoff' && av.source.id === bv.source.id
  // two different tables are different places — compare by id, not by kind
  if (av.kind === 'roundtable' || bv.kind === 'roundtable')
    return av.kind === 'roundtable' && bv.kind === 'roundtable' && av.id === bv.id
  return av.kind === bv.kind
}

export function App(): JSX.Element {
  const [repos, setRepos] = useState<RepoGroup[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)
  const [view, setView] = useState<View>({ kind: 'welcome' })
  const [indexVersion, setIndexVersion] = useState(0)
  /** The first full scan has finished — an empty repo list is real, not unread */
  const [indexed, setIndexed] = useState(false)
  const [prs, setPrs] = useState<PrStatus[]>([])
  const [binding, setBinding] = useState<ChatBinding | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  /** Where the open chat should land: the message a transcript-search hit named */
  const [anchor, setAnchor] = useState<TranscriptAnchor | null>(null)
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingPr, setCreatingPr] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [nav, setNav] = useState<{ readonly stack: readonly NavEntry[]; readonly index: number }>({
    stack: [{ kind: 'view', view: { kind: 'welcome' } }],
    index: 0
  })
  const navRef = useRef(nav)
  navRef.current = nav
  const selectedSessionIdRef = useRef<string | null>(null)
  selectedSessionIdRef.current = selectedSessionId
  const activeTurnRef = useRef<string | null>(null)
  activeTurnRef.current = activeTurn
  /** Events can beat the sendChat() reply for fast-failing spawns — hold them briefly. */
  const pendingEventsRef = useRef<ChatEvent[]>([])
  /** The active turn was running before its session was opened: its stream waits on the
   *  log being read, then skips the rows the log already holds (rejoin.ts). */
  const rejoinRef = useRef<Rejoin | null>(null)
  /** Guards against a slow transcript load landing after the user switched sessions. */
  const openSeqRef = useRef(0)
  /** Did this turn report an error? "finished" would be a lie if it did. */
  const turnFailedRef = useRef(false)
  /**
   * The transcript on screen as read from disk: which session, and when. A session
   * run in a terminal keeps writing under this view, so on every index update the
   * log is re-read when the index says it moved past this stamp. Null while the
   * view holds something disk does not — a turn Cockpit is streaming — and for a
   * conversation with no indexed session yet.
   */
  const diskLogRef = useRef<{ readonly id: string; readonly at: number } | null>(null)
  const armDiskLog = (id: string | null): void => {
    diskLogRef.current = id === null ? null : { id, at: Date.now() }
  }

  useEffect(() => initBusySessions(), [])
  // the open session's agent is running in a terminal or its own app — its log is
  // the live thing, and Send waits (a spawned turn of ours never reads as this)
  const elsewhere = useSessionRunsElsewhere(selectedSessionId)
  useEffect(() => initLanded(), [])
  // the transcript's markdown pipeline is its own chunk — warm it once the window
  // is up, so the first session opened renders formatted with no plain-text flash
  useEffect(() => preloadMarkdown(), [])

  useEffect(() => {
    void initTimeFormat()
    // the open transcript follows its log: when the index says the session moved
    // past the read on screen, read it again (a session run elsewhere keeps writing)
    const refreshOpenLog = (): void => {
      const stamp = diskLogRef.current
      if (!stamp || activeTurnRef.current !== null || stamp.id !== selectedSessionIdRef.current) return
      void api
        .getSession(stamp.id)
        .then(async (meta) => {
          if (!meta || meta.updatedAt <= stamp.at) return
          const messages = await api.getSessionMessages(stamp.id)
          // the view moved on meanwhile: another session, or a turn of ours
          if (diskLogRef.current !== stamp || activeTurnRef.current !== null) return
          setChatLog(messages)
          armDiskLog(stamp.id)
        })
        .catch(() => {})
    }
    const load = (): void => {
      void api.listRepos().then(setRepos)
      void api.getAccounts().then(setAccounts)
      setIndexVersion((v) => v + 1)
      refreshOpenLog()
    }
    load()
    // repos and the flag land in one render, so the home never sees "scanned" beside a
    // list from before the scan
    void api.whenIndexed().then(() =>
      api.listRepos().then((r) => {
        setRepos(r)
        setIndexed(true)
      })
    )
    return api.onIndexUpdated(load)
  }, [])

  // Zoom has no event of its own — the menu's ⌘+/- acts in main and the chip's reset in
  // preload — but every change resizes the layout viewport, so one resize listener sees
  // all of them (the poll this replaced left the chip up to 1.2s stale). A window drag
  // fires the same event, hence the ref: work is done only when the level really moved.
  const syncZoom = useCallback((): void => {
    const z = clampZoom(api.getZoomFactor())
    if (z !== api.getZoomFactor()) api.setZoomFactor(z)
    const level = Math.round(z * 100) / 100
    if (level === zoomRef.current) return
    zoomRef.current = level
    setZoom(level)
    // the traffic lights are drawn by the OS at a fixed size while everything in the
    // stylesheet is in CSS pixels — `--traffic-clear` divides by this to keep the one
    // measurement that has to meet them in the same units they are
    document.documentElement.style.setProperty('--zoom', String(level))
    // main keeps the window's minimum size in step: the floor is written in CSS pixels,
    // and the further in this is zoomed the fewer of them the same window holds
    void api.reportZoom(level)
  }, [])

  useEffect(() => {
    syncZoom()
    window.addEventListener('resize', syncZoom)
    return () => window.removeEventListener('resize', syncZoom)
  }, [syncZoom])

  // the rail's width once it has been dragged: it reaches the grid as `--rail`, which
  // the stylesheet holds to the bounds (`.app`) — nothing stored, nothing set
  const rail = useRailWidth()

  const bindingRef = useRef<ChatBinding | null>(null)
  bindingRef.current = binding
  const paletteOpenRef = useRef(false)
  paletteOpenRef.current = paletteOpen

  // every arrival lands in the nav history: a push truncates the forward entries,
  // and re-landing on the current entry (a ⌘[/⌘] restore, or a session-id mint
  // that applyEvent already patched in place) dedupes instead of growing the stack
  useEffect(() => {
    let entry: NavEntry
    if (view.kind === 'chat') {
      if (!binding) return
      entry = { kind: 'chat', binding, sessionId: selectedSessionId }
    } else {
      entry = { kind: 'view', view }
    }
    setNav(({ stack, index }) => {
      const cur = stack[index]
      if (cur && sameNavEntry(cur, entry)) return { stack, index }
      const next = [...stack.slice(0, index + 1), entry].slice(-NAV_MAX)
      return { stack: next, index: next.length - 1 }
    })
  }, [view, binding, selectedSessionId])

  // PR statuses for the repo behind the open chat
  useEffect(() => {
    const root = binding?.repoRoot
    if (!root) {
      setPrs([])
      return
    }
    let dead = false
    void api.getPrs(root).then((p) => !dead && setPrs(p))
    return () => {
      dead = true
    }
  }, [binding?.repoRoot, indexVersion])

  /** What the agent is called in an announcement — the provider behind this chat. */
  const speaker = useCallback(
    () => PROVIDER_LABEL[bindingRef.current?.provider ?? 'claude'],
    []
  )

  /**
   * Permission questions an ACP turn is blocked on. Kept out of the transcript on
   * purpose: this is a thing that is true *now*, not a thing that happened, and the
   * agent does not move again until one of them is answered.
   */
  const [permissions, setPermissions] = useState<PendingPermission[]>([])

  /**
   * A question a turn is now blocked on. A card belongs to the turn that asked: the chat
   * shows only the active turn's (`turnPermissions`), so an answer can never land in
   * another conversation's transcript, and one asked by a turn off screen waits for its
   * own chat — a rejoined turn must still find it. It goes when its turn ends or is
   * stopped. Request ids are the agent's own counter, so only turn and id together name
   * one; a repeat replaces the earlier copy.
   */
  const askPermission = useCallback((ev: Extract<ChatEvent, { type: 'permission' }>) => {
    setPermissions((list) => [
      ...list.filter((a) => a.turnId !== ev.turnId || a.requestId !== ev.requestId),
      {
        turnId: ev.turnId,
        requestId: ev.requestId,
        toolName: ev.toolName,
        preview: ev.preview ?? ev.detail,
        detail: ev.detail,
        options: ev.options
      }
    ])
  }, [])

  const answerPermission = useCallback((ask: PendingPermission, optionId: string) => {
    const label = ask.options.find((o) => o.optionId === optionId)?.name ?? optionId
    setPermissions((list) =>
      list.filter((a) => a.turnId !== ask.turnId || a.requestId !== ask.requestId)
    )
    void api.respondPermission(ask.turnId, ask.requestId, optionId)
    // the answer belongs in the transcript even though the question did not — it is
    // what the rest of the turn was conditioned on, and a reader should hear it once
    addChatNotice(`${label} — ${ask.preview}`)
  }, [])

  const applyEvent = useCallback(
    (ev: ChatEvent) => {
      if (ev.type === 'session') {
        // keep the tree highlight tracking the live conversation: row ids are
        // `${provider}:${nativeId}`, and providers can mint a new session id on
        // resume (claude forks one per turn) or on first turn of a new session
        const provider = bindingRef.current?.provider
        if (provider) {
          const newId = `${provider}:${ev.nativeSessionId}`
          const oldId = selectedSessionIdRef.current
          setSelectedSessionId(newId)
          // history entries for this conversation follow the mint — restoring
          // one later must resume the new id, not fork a pre-turn snapshot
          setNav(({ stack, index }) => {
            let changed = false
            const next = stack.map((e) => {
              if (e.kind !== 'chat' || e.sessionId !== oldId) return e
              if (oldId === null && e.binding !== bindingRef.current) return e
              changed = true
              return {
                ...e,
                sessionId: newId,
                binding: { ...e.binding, nativeSessionId: ev.nativeSessionId }
              }
            })
            return changed ? { stack: next, index } : { stack, index }
          })
        }
        setBinding((b) => (b ? { ...b, nativeSessionId: ev.nativeSessionId } : b))
      } else if (ev.type === 'text') {
        streamChatText(ev.text)
      } else if (ev.type === 'tool') {
        addChatMessage({
          role: 'assistant',
          kind: 'tool_call',
          toolName: ev.toolName,
          text: ev.detail,
          preview: ev.preview,
          // a question with options reaches the transcript as an answerable card
          ...(ev.asks ? { asks: ev.asks } : {}),
          // a plan, to-dos or an edit opens in the Work panel as it streams
          ...(ev.artifact ? { artifact: ev.artifact } : {})
        })
      } else if (ev.type === 'permission') {
        // the prompt is not a transcript row, but it must land after what came before it
        endChatStream({ keepText: true })
        askPermission(ev)
      } else if (ev.type === 'error') {
        // said as it happens, even mid-turn: an error nobody hears is the bug
        turnFailedRef.current = true
        addChatNotice(ev.message, `${speaker()}: ${ev.message}`)
      } else if (ev.type === 'done') {
        endChatStream({ keepText: true })
        setActiveTurn(null)
        rejoinRef.current = null
        // the log on disk is the conversation again — a terminal turn after this
        // one shows up here as it lands
        armDiskLog(selectedSessionIdRef.current)
        // the turn is over; anything it was still asking has been answered or abandoned
        setPermissions((list) => list.filter((a) => a.turnId !== ev.turnId))
        announceChat(
          turnFailedRef.current ? `${speaker()} finished with errors` : `${speaker()} finished`
        )
      }
    },
    [speaker, askPermission]
  )

  useEffect(() => {
    return api.onChatEvent((ev: ChatEvent) => {
      if (ev.turnId !== activeTurnRef.current) {
        // a question is the one thing a turn off screen can't be allowed to lose: it
        // waits for its conversation, and goes when the turn does
        if (ev.type === 'permission') askPermission(ev)
        else if (ev.type === 'done')
          setPermissions((list) => list.filter((a) => a.turnId !== ev.turnId))
        // spawn failures can emit before sendChat() resolves with the turn id
        if (activeTurnRef.current === null) {
          pendingEventsRef.current.push(ev)
          if (pendingEventsRef.current.length > 100) pendingEventsRef.current.shift()
        }
        return
      }
      const rejoin = rejoinRef.current
      for (const e of rejoin?.turnId === ev.turnId ? rejoin.offer(ev) : [ev]) applyEvent(e)
    })
  }, [applyEvent, askPermission])

  /**
   * Adopt a turn id and replay any events that arrived before we knew it.
   *
   * `rejoin` is a turn that was already running when its session was opened. Its rows
   * are in the log being read, so the replay keeps only what a log never holds (session
   * ids, permission questions, errors), and all of it waits on that read with whatever
   * streams in meanwhile (`landLog`). One that ended while the window was away is left
   * alone: the log is the whole story.
   */
  const beginTurn = useCallback(
    (turnId: string, { rejoin = false }: { readonly rejoin?: boolean } = {}) => {
      const buffered = pendingEventsRef.current.filter((e) => e.turnId === turnId)
      pendingEventsRef.current = []
      const stillLive = !buffered.some((e) => e.type === 'done')
      if (rejoin && !stillLive) return
      activeTurnRef.current = turnId
      turnFailedRef.current = false
      rejoinRef.current = null
      setActiveTurn(stillLive ? turnId : null)
      if (rejoin) {
        const joined = rejoinStream(turnId)
        for (const ev of buffered) if (ev.type !== 'text' && ev.type !== 'tool') joined.offer(ev)
        rejoinRef.current = joined
        return
      }
      announceChat(`${speaker()} is working…`)
      for (const ev of buffered) applyEvent(ev)
    },
    [applyEvent, speaker]
  )

  /**
   * A conversation is being opened: a turn of ours still running on it is rejoined —
   * its stream and its Stop — rather than shown idle with Send open beside it. Anything
   * else leaves the chat idle.
   */
  const joinTurn = useCallback(
    (turnId: string | null) => {
      // synchronously: the previous conversation's turn must not stream into this one
      activeTurnRef.current = null
      rejoinRef.current = null
      setActiveTurn(null)
      if (turnId !== null) beginTurn(turnId, { rejoin: true })
    },
    [beginTurn]
  )

  /**
   * The opened session's log, once read: on screen, with a rejoined turn's stream let in
   * behind it. A read that fails leaves the log empty rather than crash — the transcript
   * may be gone from disk — and a rejoined turn streams on regardless.
   */
  const landLog = useCallback(
    async (seq: number, id: string) => {
      let messages: readonly SessionMessage[] | null = null
      try {
        messages = await api.getSessionMessages(id)
      } catch {
        /* an empty log, not a crash */
      }
      // a slower load for a previously opened session must not clobber this one
      if (seq !== openSeqRef.current) return
      if (messages) setChatLog(messages)
      const rejoin = rejoinRef.current
      if (!rejoin) {
        if (messages) armDiskLog(id)
        return
      }
      // said now, not as the turn was adopted: putting the log on screen resets the line
      announceChat(`${speaker()} is working…`)
      for (const ev of rejoin.logRead(messages ?? [])) applyEvent(ev)
    },
    [applyEvent, speaker]
  )

  const openSession = useCallback(
    async (s: SessionMeta, opts: { readonly anchor?: TranscriptAnchor } = {}) => {
      // the conversation already on screen, its turn still streaming: the live log (and
      // any notice it carries that no log file does) stays as it is
      if (s.id === selectedSessionIdRef.current && activeTurnRef.current !== null && bindingRef.current) {
        setAnchor(opts.anchor ?? null)
        setView({ kind: 'chat' })
        return
      }
      const seq = ++openSeqRef.current
      setChatLog([])
      diskLogRef.current = null
      setSelectedSessionId(s.id)
      setAnchor(opts.anchor ?? null)
      // restore the account this session's source dir belongs to — otherwise a
      // reopened session would silently continue on the default account.
      // (SessionMeta.source is the source LABEL; copilot's historical user is
      // unknowable from logs, so copilotUser is deliberately left unset.)
      const acct = accounts?.accounts.find(
        (a) => a.provider === s.provider && a.label === s.source
      )
      setBinding({
        provider: s.provider,
        cwd: s.cwd ?? '~',
        nativeSessionId: s.nativeId,
        title: s.title,
        branch: s.gitBranch ?? null,
        repoRoot: s.repo?.root ?? null,
        configDir: acct && !acct.isDefault ? acct.path : undefined,
        accountLabel: acct ? (acct.identity ?? acct.label) : undefined,
        continuedFrom: lineageRef(s.continuedFrom),
        readOnly: s.roundtableId ? true : undefined
      })
      setView({ kind: 'chat' })
      // a seat's turn is its table's, and streams there — the seat's chat only reads
      joinTurn(s.roundtableId ? null : spawnedTurn(s.id))
      // the parent chip names the session, so it waits for the lookup — and a parent
      // the index no longer holds gets no chip at all rather than one that can't open
      if (s.parentId) {
        void api.getSession(s.parentId).then((p) => {
          if (!p || seq !== openSeqRef.current) return
          const startedBy = { id: p.id, provider: p.provider, title: p.title }
          setBinding((b) => (b && b.nativeSessionId === s.nativeId ? { ...b, startedBy } : b))
        })
      }
      await landLog(seq, s.id)
    },
    [accounts, joinTurn, landLog]
  )

  /** Land on a history entry. A chat entry that is still the bound conversation
   *  just flips the view back — the live log, streaming included, is untouched.
   *  Any other conversation is re-materialized from the entry's snapshot, the
   *  way openSession does it from a sidebar row. */
  const restoreNav = useCallback(
    (entry: NavEntry) => {
      if (entry.kind !== 'chat') {
        setView(entry.view)
        return
      }
      const sameChat =
        entry.sessionId === selectedSessionIdRef.current &&
        (entry.sessionId !== null || entry.binding === bindingRef.current)
      if (!sameChat) {
        const seq = ++openSeqRef.current
        setChatLog([])
        diskLogRef.current = null
        setSelectedSessionId(entry.sessionId)
        setAnchor(null)
        setBinding(entry.binding)
        // an entry with no id is a new chat that never announced one: nothing to rejoin
        // and no log to read
        const id = entry.sessionId
        joinTurn(id !== null && !entry.binding.readOnly ? spawnedTurn(id) : null)
        if (id !== null) void landLog(seq, id)
      }
      setView({ kind: 'chat' })
    },
    [joinTurn, landLog]
  )

  const goBack = useCallback(() => {
    const { stack, index } = navRef.current
    const entry = stack[index - 1]
    if (!entry) return
    setNav({ stack, index: index - 1 })
    restoreNav(entry)
  }, [restoreNav])

  const goForward = useCallback(() => {
    const { stack, index } = navRef.current
    const entry = stack[index + 1]
    if (!entry) return
    setNav({ stack, index: index + 1 })
    restoreNav(entry)
  }, [restoreNav])

  // global shortcuts: ⌘K palette, ⌘N new task, ⌘, settings, ⌘[/⌘] back/forward,
  // Esc backs out of secondary views
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      // while the palette is open it owns the keyboard (its own listener closes
      // on Escape) — the view-level shortcuts below must not also fire
      if (paletteOpenRef.current) return
      if (mod && e.key === '[') {
        e.preventDefault()
        goBack()
      } else if (mod && e.key === ']') {
        e.preventDefault()
        goForward()
      } else if (mod && e.key === 'n') {
        e.preventDefault()
        setView({ kind: 'welcome' })
      } else if (mod && e.key === ',') {
        e.preventDefault()
        setView({ kind: 'settings' })
      } else if (e.key === 'Escape') {
        // a habitual Escape must not discard a half-typed field: first blur, then close
        const t = e.target as HTMLElement | null
        if (t && t.closest('input, textarea, select')) {
          t.blur()
          return
        }
        setView((v) =>
          v.kind === 'settings' ||
          v.kind === 'extensions' ||
          v.kind === 'cleanup' ||
          v.kind === 'new' ||
          v.kind === 'handoff' ||
          v.kind === 'new-roundtable'
            ? bindingRef.current
              ? { kind: 'chat' }
              : { kind: 'welcome' }
            : v
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goBack, goForward])

  const send = useCallback(
    async (prompt: string, permissionMode: PermissionMode, images?: readonly string[]) => {
      if (!binding || activeTurn || binding.readOnly || elsewhere) return
      // from here the view holds what disk does not — no re-read may land on it
      diskLogRef.current = null
      // the transcript shows attachments as one marker line per image
      addChatMessage({ role: 'user', kind: 'text', text: withImageMarks(prompt, images) })
      try {
        const turnId = await api.sendChat({
          provider: binding.provider,
          cwd: binding.cwd,
          prompt,
          resumeNativeId: binding.nativeSessionId ?? undefined,
          permissionMode,
          options: binding.options,
          configDir: binding.configDir,
          copilotUser: binding.copilotUser,
          images
        })
        beginTurn(turnId)
      } catch (err) {
        // a rejected invoke (e.g. copilot account no longer logged in) must not
        // leave the prompt looking sent with no reply and no error
        addChatNotice(`Send failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [binding, activeTurn, elsewhere, beginTurn]
  )

  /** New session flow: create worktree, bind chat, fire the first prompt. */
  const startSession = useCallback(
    async (req: StartSessionRequest): Promise<string | null> => {
      const { repo, provider, name, prompt, mode, options, account, images } = req
      if (!repo.root) return 'This group has no git repository.'
      setCreating(true)
      try {
        const ws = await api.createWorkspace(repo.root, name || branchHint(prompt))
        setSelectedSessionId(null)
        setBinding({
          provider,
          cwd: ws.cwd,
          nativeSessionId: null,
          // the task is what the user will look for — the branch already has its own chip
          title: taskTitle(prompt) || ws.branch,
          branch: ws.branch,
          repoRoot: repo.root,
          options,
          configDir: account.configDir,
          copilotUser: account.copilotUser,
          accountLabel: account.display
        })
        setView({ kind: 'chat' })
        setChatLog([
          {
            role: 'system',
            kind: 'system',
            text: `Worktree ready on ${ws.branch} — running isolated from your main checkout.`
          },
          ...(ws.warning ? [{ role: 'system', kind: 'system', text: ws.warning } as const] : []),
          { role: 'user', kind: 'text', text: withImageMarks(prompt, images) }
        ])
        const turnId = await api.sendChat({
          provider,
          cwd: ws.cwd,
          prompt,
          permissionMode: mode,
          options,
          configDir: account.configDir,
          copilotUser: account.copilotUser,
          images
        })
        beginTurn(turnId)
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      } finally {
        setCreating(false)
      }
    },
    [beginTurn]
  )

  /** Open the handoff form for the current session (needs a started, idle session). */
  const openHandoff = useCallback(() => {
    const b = bindingRef.current
    if (!b || !b.nativeSessionId || activeTurnRef.current) return
    setView({
      kind: 'handoff',
      source: {
        id: `${b.provider}:${b.nativeSessionId}`,
        provider: b.provider,
        title: b.title,
        cwd: b.cwd,
        branch: b.branch,
        repoRoot: b.repoRoot
      }
    })
  }, [])

  /** Handoff flow: same shape as startSession minus the worktree — the source
   *  session's directory IS the workspace, and the briefing is the first prompt. */
  const startHandoff = useCallback(
    async (req: StartHandoffRequest): Promise<string | null> => {
      const { source, provider, briefing, mode, options, account } = req
      setCreating(true)
      try {
        setSelectedSessionId(null)
        setBinding({
          provider,
          cwd: source.cwd,
          nativeSessionId: null,
          title: source.title,
          branch: source.branch,
          repoRoot: source.repoRoot,
          options,
          configDir: account.configDir,
          copilotUser: account.copilotUser,
          accountLabel: account.display,
          continuedFrom: { id: source.id, provider: source.provider }
        })
        setView({ kind: 'chat' })
        setChatLog([
          {
            role: 'system',
            kind: 'system',
            text: `Continuing from ${PROVIDER_LABEL[source.provider]} in ${source.cwd} — same worktree, same branch.`
          },
          { role: 'user', kind: 'text', text: briefing }
        ])
        const turnId = await api.sendChat({
          provider,
          cwd: source.cwd,
          prompt: briefing,
          permissionMode: mode,
          options,
          configDir: account.configDir,
          copilotUser: account.copilotUser,
          handoffFrom: source.id
        })
        beginTurn(turnId)
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      } finally {
        setCreating(false)
      }
    },
    [beginTurn]
  )

  /** Lineage chip navigation: resolve the source session and open it. */
  const openLineage = useCallback(
    async (sourceId: string) => {
      const meta = await api.getSession(sourceId)
      if (meta) void openSession(meta)
      // one handler for both header chips — the one this continued, the one that started it
      else addChatNotice('That session is no longer in Cockpit’s index.')
    },
    [openSession]
  )

  const openRoundtable = useCallback((id: string) => {
    setSelectedSessionId(null)
    setView({ kind: 'roundtable', id })
  }, [])

  const cancel = useCallback(() => {
    if (activeTurn) {
      void api.cancelChat(activeTurn)
      // the killed turn's terminal `done` no longer matches activeTurnRef, so do
      // its cleanup locally: stop the shimmer and drop any not-yet-flushed text
      setActiveTurn(null)
      rejoinRef.current = null
      setPermissions((list) => list.filter((a) => a.turnId !== activeTurn))
      endChatStream({ keepText: false })
      // as a turn's own end does: the log on disk is the conversation again, or the
      // transcript stops following it until the session is reopened
      armDiskLog(selectedSessionIdRef.current)
      announceChat(`${speaker()} stopped`)
    }
  }, [activeTurn, speaker])

  const createPr = useCallback(async () => {
    // in-flight guard: a double-click must not race two `gh pr create` runs
    if (!binding || creatingPr) return
    setCreatingPr(true)
    addChatNotice('Pushing branch and opening PR…')
    try {
      const url = await api.createPr(binding.cwd)
      addChatNotice(`PR created: ${url}`)
      void api.openExternal(url)
      setIndexVersion((v) => v + 1)
    } catch (err) {
      addChatNotice(`PR failed: ${err instanceof Error ? err.message : err}`)
    } finally {
      setCreatingPr(false)
    }
  }, [binding, creatingPr])

  const openUrl = useCallback((url: string) => void api.openExternal(url), [])

  /** Nav icons are stateful: opening the view you're already on backs out of it. */
  const toggleView = useCallback((kind: 'settings' | 'extensions' | 'profile' | 'cleanup') => {
    setView((v) => {
      if (v.kind === kind) return bindingRef.current ? { kind: 'chat' } : { kind: 'welcome' }
      return kind === 'extensions' ? { kind, repoRoot: null } : { kind }
    })
  }, [])

  /** The rail's per-repo entry point: the same view, scoped to that repo. */
  const openRepoSetup = useCallback((repoRoot: string) => {
    setView({ kind: 'extensions', repoRoot })
  }, [])

  // what the window shows, for main: a session watched live never lands or notifies,
  // and opening one clears its landing, its Dock count and its banner (landed.ts)
  const roundtableOnScreen = view.kind === 'roundtable' ? view.id : null
  const chatOnScreen = view.kind === 'chat' ? binding : null
  const cleanupOnScreen = view.kind === 'cleanup'
  useEffect(() => {
    const focus: AttentionFocus = roundtableOnScreen
      ? { kind: 'roundtable', id: roundtableOnScreen }
      : cleanupOnScreen
        ? { kind: 'cleanup' }
        : chatOnScreen
          ? {
              kind: 'session',
              id: selectedSessionId,
              provider: chatOnScreen.provider,
              cwd: chatOnScreen.cwd
            }
          : { kind: 'none' }
    void api.setAttentionFocus(focus)
  }, [roundtableOnScreen, cleanupOnScreen, chatOnScreen?.provider, chatOnScreen?.cwd, selectedSessionId])

  // a clicked notification: main has already brought the window forward
  const openTargetRef = useRef<(target: AttentionTarget) => void>(() => {})
  openTargetRef.current = (target) => {
    if (target.kind === 'roundtable') {
      openRoundtable(target.id)
    } else if (target.kind === 'cleanup') {
      setView({ kind: 'cleanup' })
    } else if (target.kind === 'session') {
      // the conversation already on screen keeps its live log
      if (target.id === selectedSessionIdRef.current && bindingRef.current) {
        setView({ kind: 'chat' })
        return
      }
      void api
        .getSession(target.id)
        .then((meta) => (meta ? openSession(meta) : setView({ kind: 'welcome' })))
        .catch(() => setView({ kind: 'welcome' }))
    } else {
      // several landed at once — the board is where they all are
      setView({ kind: 'welcome' })
    }
  }
  useEffect(() => {
    const open = (target: AttentionTarget): void => openTargetRef.current(target)
    const off = api.onAttentionOpen(open)
    // clicked while this window didn't exist yet (closed on macOS)
    void api.takeAttentionOpen().then((target) => target && open(target))
    return off
  }, [])

  // the questions the turn on screen is blocked on; another conversation's turn keeps
  // its own, for when that conversation is opened and its turn rejoined
  const turnPermissions = useMemo(
    () => permissions.filter((p) => p.turnId === activeTurn),
    [permissions, activeTurn]
  )

  // hidden projects stay out of pickers too — the sidebar's eye popover still lists them
  const visibleRepos = useMemo(() => repos.filter((r) => !r.hidden), [repos])
  // the repo the window is on — what a transcript search scopes to before it widens.
  // Home and the other repo-less views have none, so there the search is global.
  const scopeRepo = useMemo((): RepoGroup | null => {
    if (view.kind === 'new') return view.repo
    const root =
      view.kind === 'chat' ? (binding?.repoRoot ?? null) : view.kind === 'extensions' ? view.repoRoot : null
    return root === null ? null : (repos.find((r) => r.root === root) ?? null)
  }, [view, binding, repos])

  return (
    <div className="app" style={rail === null ? undefined : railStyle(rail)}>
      <DevBanner />
      {/* the app is one page and this is its name: every view needs a level-one
          heading to sit under, and the view's own title is the h2 beneath it.
          In a banner so it is page content inside a landmark, like everything else. */}
      <header className="sr-only">
        <h1>Cockpit</h1>
      </header>
      {/* non-chat views have no draggable header of their own — give the window a
          slim grab strip along the top edge (chat's header is already a drag region) */}
      {view.kind !== 'chat' && <div className="drag-strip" aria-hidden />}
      <TreeSidebar
        repos={repos}
        indexVersion={indexVersion}
        accounts={accounts}
        zoom={zoom}
        onResetZoom={() => {
          api.setZoomFactor(1)
          // webFrame is synchronous, so the chip and main settle now rather than on the
          // resize this triggers — which then sees the level already where it left it
          syncZoom()
        }}
        selectedId={selectedSessionId}
        onSelect={openSession}
        onNewSession={(repo) => setView({ kind: 'new', repo })}
        onRepoSetup={openRepoSetup}
        selectedRoundtableId={view.kind === 'roundtable' ? view.id : null}
        onOpenRoundtable={openRoundtable}
        onNewTask={() => {
          setView({ kind: 'welcome' })
          // when already home, the view object changes but HomeView isn't remounted,
          // so its mount-autofocus doesn't re-run — land focus in the composer here
          requestAnimationFrame(() =>
            document.querySelector<HTMLTextAreaElement>('.composer-card textarea')?.focus()
          )
        }}
        onGoHome={() => setView({ kind: 'welcome' })}
        onNav={toggleView}
        onOpenSettings={(section) =>
          // count the asking, not just the section: the usage meters name 'accounts'
          // every time, and it has to move you there again after you've left that tab
          setView((v) => ({
            kind: 'settings',
            section,
            openCount: (v.kind === 'settings' ? (v.openCount ?? 0) : 0) + 1
          }))
        }
        onOpenUrl={openUrl}
        activeView={view.kind}
      />
      {view.kind === 'cleanup' ? (
        <CleanupView onClose={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })} />
      ) : view.kind === 'profile' ? (
        <ProfileView onClose={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })} />
      ) : view.kind === 'settings' ? (
        <Settings
          section={view.section}
          openCount={view.openCount}
          onClose={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })}
        />
      ) : view.kind === 'extensions' ? (
        <AiSetup
          repos={repos}
          repoRoot={view.repoRoot}
          onScope={(repoRoot) => setView({ kind: 'extensions', repoRoot })}
          onClose={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })}
        />
      ) : view.kind === 'new' ? (
        <NewSession
          repo={view.repo}
          repos={visibleRepos}
          busy={creating}
          initialPrompt={view.draft}
          initialImages={view.draftImages}
          onStart={startSession}
          onCancel={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })}
        />
      ) : view.kind === 'handoff' ? (
        <HandoffView
          source={view.source}
          busy={creating}
          onStart={startHandoff}
          onCancel={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })}
        />
      ) : view.kind === 'new-roundtable' ? (
        <NewRoundtable
          repos={visibleRepos}
          onCreated={openRoundtable}
          onCancel={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })}
        />
      ) : view.kind === 'roundtable' ? (
        // keyed: one table's seat picks, open limits editor and draft must never
        // carry over to the next — Save there wrote table A's limits onto table B
        <RoundtableView key={view.id} id={view.id} />
      ) : view.kind === 'welcome' ? (
        <HomeView
          repos={visibleRepos}
          indexed={indexed}
          indexVersion={indexVersion}
          busy={creating}
          onStart={startSession}
          onOpenSession={openSession}
          onOpenFull={(repo, draft, draftImages) => setView({ kind: 'new', repo, draft, draftImages })}
          onNewRoundtable={() => setView({ kind: 'new-roundtable' })}
          onOpenRoundtable={openRoundtable}
          onOpenSettings={() => setView({ kind: 'settings' })}
        />
      ) : (
        <ChatView
          binding={binding}
          prs={prs}
          busy={activeTurn !== null}
          elsewhere={activeTurn === null && elsewhere}
          prBusy={creatingPr}
          onSend={send}
          onCancel={cancel}
          onCreatePr={createPr}
          onOpenUrl={openUrl}
          onOpenHandoff={openHandoff}
          onOpenLineage={(id) => void openLineage(id)}
          permissions={turnPermissions}
          onAnswerPermission={answerPermission}
          anchor={anchor}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          repos={visibleRepos}
          scopeRepo={scopeRepo}
          onOpenSession={(s, at) => void openSession(s, at ? { anchor: at } : {})}
          onNewSession={(repo) => setView({ kind: 'new', repo })}
          onGoto={(v: PaletteViewKey) =>
            setView(v === 'extensions' ? { kind: v, repoRoot: null } : { kind: v })
          }
          onRepoSetup={openRepoSetup}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  )
}
