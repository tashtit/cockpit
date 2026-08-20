import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  ChatEvent,
  PermissionMode,
  Provider,
  PrStatus,
  RepoGroup,
  SessionMeta,
  SessionMessage
} from '../../shared/types'
import { api } from './api'
import { withImageMarks, type ImageAttachment } from './attachments'
import { TreeSidebar } from './TreeSidebar'
import { ChatView } from './ChatView'
import { CommandPalette, type PaletteViewKey } from './CommandPalette'
import { NewSession } from './NewSession'
import { HandoffView } from './HandoffView'
import type { HandoffSourceRef, StartHandoffRequest } from './HandoffView'
import { NewRoundtable } from './NewRoundtable'
import { RoundtableView } from './RoundtableView'
import { PROVIDER_LABEL } from './logos'
import { Settings } from './Settings'
import { ProfileView } from './ProfileView'
import { AiSetup } from './AiSetup'
import { HomeView } from './HomeView'
import { DevBanner } from './DevBanner'
import { initBusySessions } from './busy'
import { initTimeFormat } from './time'
import type { StartSessionRequest } from './NewSession'
import type { AccountsSnapshot, AgentOptions } from '../../shared/types'

export type ChatBinding = {
  readonly provider: Provider
  readonly cwd: string
  readonly nativeSessionId: string | null
  readonly title: string
  readonly branch: string | null
  readonly repoRoot: string | null
  /** Per-agent options chosen at session start; reused for every turn */
  readonly options?: AgentOptions
  /** Account chosen at session start (config home + copilot user) */
  readonly configDir?: string
  readonly copilotUser?: string
  /** Human-readable identity shown in the chat header */
  readonly accountLabel?: string
  /** Lineage chip: the session this one was handed off from */
  readonly continuedFrom?: { readonly id: string; readonly provider: Provider }
  /** Roundtable seat-session: view only, no composer (main refuses sends there too) */
  readonly readOnly?: boolean
}

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
  | { kind: 'settings' }
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
  const [view, setView] = useState<View>({ kind: 'welcome' })
  const [indexVersion, setIndexVersion] = useState(0)
  const [prs, setPrs] = useState<PrStatus[]>([])
  const [binding, setBinding] = useState<ChatBinding | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [log, setLog] = useState<SessionMessage[]>([])
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
  /** Guards against a slow transcript load landing after the user switched sessions. */
  const openSeqRef = useRef(0)
  /** Streamed text is batched (~40ms) so each stdout chunk doesn't re-render the log. */
  const textBufRef = useRef('')
  const textFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => initBusySessions(), [])

  useEffect(() => {
    void initTimeFormat()
    const load = (): void => {
      void api.listRepos().then(setRepos)
      void api.getAccounts().then(setAccounts)
      setIndexVersion((v) => v + 1)
    }
    load()
    return api.onIndexUpdated(load)
  }, [])

  // menu zoom (⌘+/-) has no renderer event — poll, clamp to limits, surface the level.
  // Bounds mirror ZOOM_MIN/ZOOM_MAX in preload (which does the actual clamping); the
  // ceiling is 2.0 so text can reach 200% per WCAG 1.4.4.
  useEffect(() => {
    const t = setInterval(() => {
      const z = api.getZoomFactor()
      if (z > 2 || z < 0.7) api.setZoomFactor(z)
      setZoom(Math.round(api.getZoomFactor() * 100) / 100)
    }, 1200)
    return () => clearInterval(t)
  }, [])

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

  /** Drop buffered stream text and its timer — switching sessions or cancelling a
   *  turn must not let a pending 40ms flush write into the next view of the log. */
  const clearPendingText = useCallback(() => {
    textBufRef.current = ''
    if (textFlushRef.current) {
      clearTimeout(textFlushRef.current)
      textFlushRef.current = null
    }
  }, [])

  const flushText = useCallback(() => {
    textFlushRef.current = null
    const chunk = textBufRef.current
    if (!chunk) return
    textBufRef.current = ''
    setLog((l) => {
      const last = l[l.length - 1]
      if (last && last.role === 'assistant' && last.kind === 'text' && last.streaming) {
        return [...l.slice(0, -1), { ...last, text: last.text + chunk }]
      }
      return [...l, { role: 'assistant', kind: 'text', text: chunk, streaming: true } as SessionMessage]
    })
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
        textBufRef.current += ev.text
        if (!textFlushRef.current) textFlushRef.current = setTimeout(flushText, 40)
      } else if (ev.type === 'tool') {
        flushText()
        setLog((l) => [
          ...l,
          {
            role: 'assistant',
            kind: 'tool_call',
            toolName: ev.toolName,
            text: ev.detail,
            preview: ev.preview
          }
        ])
      } else if (ev.type === 'error') {
        flushText()
        setLog((l) => [...l, { role: 'system', kind: 'system', text: ev.message }])
      } else if (ev.type === 'done') {
        flushText()
        setActiveTurn(null)
        // only touch rows that were streaming: replacing every row's identity here
        // would re-render (and re-markdown) the whole memoized transcript at once
        setLog((l) =>
          l.some((m) => m.streaming)
            ? l.map((m) => (m.streaming ? { ...m, streaming: false } : m))
            : l
        )
      }
    },
    [flushText]
  )

  useEffect(() => {
    return api.onChatEvent((ev: ChatEvent) => {
      if (ev.turnId !== activeTurnRef.current) {
        // spawn failures can emit before sendChat() resolves with the turn id
        if (activeTurnRef.current === null) {
          pendingEventsRef.current.push(ev)
          if (pendingEventsRef.current.length > 100) pendingEventsRef.current.shift()
        }
        return
      }
      applyEvent(ev)
    })
  }, [applyEvent])

  /** Adopt a turn id and replay any events that arrived before we knew it. */
  const beginTurn = useCallback(
    (turnId: string) => {
      const buffered = pendingEventsRef.current.filter((e) => e.turnId === turnId)
      pendingEventsRef.current = []
      const stillLive = !buffered.some((e) => e.type === 'done')
      activeTurnRef.current = turnId
      setActiveTurn(stillLive ? turnId : null)
      for (const ev of buffered) applyEvent(ev)
    },
    [applyEvent]
  )

  const openSession = useCallback(
    async (s: SessionMeta) => {
      const seq = ++openSeqRef.current
      clearPendingText()
      setActiveTurn(null)
      setSelectedSessionId(s.id)
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
        branch: s.gitBranch,
        repoRoot: s.repo?.root ?? null,
        configDir: acct && !acct.isDefault ? acct.path : undefined,
        accountLabel: acct ? (acct.identity ?? acct.label) : undefined,
        continuedFrom: lineageRef(s.continuedFrom),
        readOnly: s.roundtableId ? true : undefined
      })
      setView({ kind: 'chat' })
      setLog([])
      const messages = await api.getSessionMessages(s.id)
      // a slower load for a previously clicked session must not clobber this one
      if (seq === openSeqRef.current) setLog(messages)
    },
    [accounts, clearPendingText]
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
        clearPendingText()
        setActiveTurn(null)
        setSelectedSessionId(entry.sessionId)
        setBinding(entry.binding)
        setLog([])
        if (entry.sessionId) {
          void api
            .getSessionMessages(entry.sessionId)
            .then((messages) => {
              if (seq === openSeqRef.current) setLog(messages)
            })
            // the transcript may be gone from disk — an empty log, not a crash
            .catch(() => {})
        }
      }
      setView({ kind: 'chat' })
    },
    [clearPendingText]
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
      if (!binding || activeTurn || binding.readOnly) return
      // the transcript shows attachments as one marker line per image
      setLog((l) => [...l, { role: 'user', kind: 'text', text: withImageMarks(prompt, images) }])
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
        setLog((l) => [
          ...l,
          {
            role: 'system',
            kind: 'system',
            text: `Send failed: ${err instanceof Error ? err.message : String(err)}`
          }
        ])
      }
    },
    [binding, activeTurn, beginTurn]
  )

  /** New session flow: create worktree, bind chat, fire the first prompt. */
  const startSession = useCallback(
    async (req: StartSessionRequest): Promise<string | null> => {
      const { repo, provider, name, prompt, mode, options, account, images } = req
      if (!repo.root) return 'This group has no git repository.'
      setCreating(true)
      try {
        const ws = await api.createWorkspace(repo.root, name || undefined)
        setSelectedSessionId(null)
        setBinding({
          provider,
          cwd: ws.cwd,
          nativeSessionId: null,
          title: ws.branch,
          branch: ws.branch,
          repoRoot: repo.root,
          options,
          configDir: account.configDir,
          copilotUser: account.copilotUser,
          accountLabel: account.display
        })
        setView({ kind: 'chat' })
        setLog([
          {
            role: 'system',
            kind: 'system',
            text: `Worktree ready on ${ws.branch} — running isolated from your main checkout.`
          },
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
        setLog([
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
      else {
        setLog((l) => [
          ...l,
          { role: 'system', kind: 'system', text: 'The session this one continued is no longer in Cockpit’s index.' }
        ])
      }
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
      clearPendingText()
      setLog((l) =>
        l.some((m) => m.streaming)
          ? l.map((m) => (m.streaming ? { ...m, streaming: false } : m))
          : l
      )
    }
  }, [activeTurn, clearPendingText])

  const createPr = useCallback(async () => {
    // in-flight guard: a double-click must not race two `gh pr create` runs
    if (!binding || creatingPr) return
    setCreatingPr(true)
    setLog((l) => [...l, { role: 'system', kind: 'system', text: 'Pushing branch and opening PR…' }])
    try {
      const url = await api.createPr(binding.cwd)
      setLog((l) => [...l, { role: 'system', kind: 'system', text: `PR created: ${url}` }])
      void api.openExternal(url)
      setIndexVersion((v) => v + 1)
    } catch (err) {
      setLog((l) => [
        ...l,
        { role: 'system', kind: 'system', text: `PR failed: ${err instanceof Error ? err.message : err}` }
      ])
    } finally {
      setCreatingPr(false)
    }
  }, [binding, creatingPr])

  const openUrl = useCallback((url: string) => void api.openExternal(url), [])

  /** Nav icons are stateful: opening the view you're already on backs out of it. */
  const toggleView = useCallback((kind: 'settings' | 'extensions' | 'profile') => {
    setView((v) => {
      if (v.kind === kind) return bindingRef.current ? { kind: 'chat' } : { kind: 'welcome' }
      return kind === 'extensions' ? { kind, repoRoot: null } : { kind }
    })
  }, [])

  /** The rail's per-repo entry point: the same view, scoped to that repo. */
  const openRepoSetup = useCallback((repoRoot: string) => {
    setView({ kind: 'extensions', repoRoot })
  }, [])

  // hidden projects stay out of pickers too — the sidebar's eye popover still lists them
  const visibleRepos = useMemo(() => repos.filter((r) => !r.hidden), [repos])

  return (
    <div className="app">
      <DevBanner />
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
          setZoom(1)
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
        onOpenSettings={() => setView({ kind: 'settings' })}
        onOpenUrl={openUrl}
        activeView={view.kind}
      />
      {view.kind === 'profile' ? (
        <ProfileView onClose={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })} />
      ) : view.kind === 'settings' ? (
        <Settings onClose={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })} />
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
        <RoundtableView id={view.id} />
      ) : view.kind === 'welcome' ? (
        <HomeView
          repos={visibleRepos}
          indexVersion={indexVersion}
          busy={creating}
          onStart={startSession}
          onOpenSession={openSession}
          onOpenFull={(repo, draft, draftImages) => setView({ kind: 'new', repo, draft, draftImages })}
          onNewRoundtable={() => setView({ kind: 'new-roundtable' })}
          onOpenRoundtable={openRoundtable}
        />
      ) : (
        <ChatView
          binding={binding}
          prs={prs}
          log={log}
          busy={activeTurn !== null}
          prBusy={creatingPr}
          onSend={send}
          onCancel={cancel}
          onCreatePr={createPr}
          onOpenUrl={openUrl}
          onOpenHandoff={openHandoff}
          onOpenLineage={(id) => void openLineage(id)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          repos={visibleRepos}
          onOpenSession={(s) => void openSession(s)}
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
