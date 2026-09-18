import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AcpPermissionOption,
  AttentionFocus,
  AttentionTarget,
  ChatEvent,
  PermissionMode,
  Provider,
  PrStatus,
  RepoGroup,
  SessionMeta
} from '../../shared/types'
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
import { initBusySessions } from './busy'
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
import type { AccountsSnapshot, AgentOptions } from '../../shared/types'

/**
 * A permission request a live ACP turn is blocked on, and the answers it will take.
 *
 * Not to be confused with `AskPrompt` / `AskPicker`: that is a question *read out of a
 * transcript*, answered by composing the next message, and it works for sessions Cockpit
 * never spawned. This one is a process Cockpit is holding open — the answer goes back
 * down the protocol, and nothing in the turn moves until it does.
 */
export type PendingPermission = {
  readonly turnId: string
  readonly requestId: string
  readonly toolName: string
  /** The agent's own one-line headline for what it wants to do */
  readonly preview: string
  /** The raw tool input behind the headline — the tooltip, so a click is informed */
  readonly detail: string
  readonly options: readonly AcpPermissionOption[]
}

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
  const [view, setView] = useState<View>({ kind: 'welcome' })
  const [indexVersion, setIndexVersion] = useState(0)
  /** The first full scan has finished — an empty repo list is real, not unread */
  const [indexed, setIndexed] = useState(false)
  const [prs, setPrs] = useState<PrStatus[]>([])
  const [binding, setBinding] = useState<ChatBinding | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
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
  /** Did this turn report an error? "finished" would be a lie if it did. */
  const turnFailedRef = useRef(false)

  useEffect(() => initBusySessions(), [])
  useEffect(() => initLanded(), [])
  // the transcript's markdown pipeline is its own chunk — warm it once the window
  // is up, so the first session opened renders formatted with no plain-text flash
  useEffect(() => preloadMarkdown(), [])

  useEffect(() => {
    void initTimeFormat()
    const load = (): void => {
      void api.listRepos().then(setRepos)
      void api.getAccounts().then(setAccounts)
      setIndexVersion((v) => v + 1)
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

  const answerPermission = useCallback((ask: PendingPermission, optionId: string) => {
    const label = ask.options.find((o) => o.optionId === optionId)?.name ?? optionId
    setPermissions((list) => list.filter((a) => a.requestId !== ask.requestId))
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
          ...(ev.asks ? { asks: ev.asks } : {})
        })
      } else if (ev.type === 'permission') {
        // the prompt is not a transcript row, but it must land after what came before it
        endChatStream({ keepText: true })
        setPermissions((list) => [
          ...list.filter((a) => a.requestId !== ev.requestId),
          {
            turnId: ev.turnId,
            requestId: ev.requestId,
            toolName: ev.toolName,
            preview: ev.preview ?? ev.detail,
            detail: ev.detail,
            options: ev.options
          }
        ])
      } else if (ev.type === 'error') {
        // said as it happens, even mid-turn: an error nobody hears is the bug
        turnFailedRef.current = true
        addChatNotice(ev.message, `${speaker()}: ${ev.message}`)
      } else if (ev.type === 'done') {
        endChatStream({ keepText: true })
        setActiveTurn(null)
        // the turn is over; anything it was still asking has been answered or abandoned
        setPermissions([])
        announceChat(
          turnFailedRef.current ? `${speaker()} finished with errors` : `${speaker()} finished`
        )
      }
    },
    [speaker]
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
      turnFailedRef.current = false
      setActiveTurn(stillLive ? turnId : null)
      announceChat(`${speaker()} is working…`)
      for (const ev of buffered) applyEvent(ev)
    },
    [applyEvent, speaker]
  )

  const openSession = useCallback(
    async (s: SessionMeta) => {
      const seq = ++openSeqRef.current
      setChatLog([])
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
        branch: s.gitBranch ?? null,
        repoRoot: s.repo?.root ?? null,
        configDir: acct && !acct.isDefault ? acct.path : undefined,
        accountLabel: acct ? (acct.identity ?? acct.label) : undefined,
        continuedFrom: lineageRef(s.continuedFrom),
        readOnly: s.roundtableId ? true : undefined
      })
      setView({ kind: 'chat' })
      const messages = await api.getSessionMessages(s.id)
      // a slower load for a previously clicked session must not clobber this one
      if (seq === openSeqRef.current) setChatLog(messages)
    },
    [accounts]
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
        setActiveTurn(null)
        setSelectedSessionId(entry.sessionId)
        setBinding(entry.binding)
        if (entry.sessionId) {
          void api
            .getSessionMessages(entry.sessionId)
            .then((messages) => {
              if (seq === openSeqRef.current) setChatLog(messages)
            })
            // the transcript may be gone from disk — an empty log, not a crash
            .catch(() => {})
        }
      }
      setView({ kind: 'chat' })
    },
    []
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
      if (!binding || activeTurn || binding.readOnly) return
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
    [binding, activeTurn, beginTurn]
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
      else addChatNotice('The session this one continued is no longer in Cockpit’s index.')
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
      endChatStream({ keepText: false })
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
  useEffect(() => {
    const focus: AttentionFocus = roundtableOnScreen
      ? { kind: 'roundtable', id: roundtableOnScreen }
      : chatOnScreen
        ? {
            kind: 'session',
            id: selectedSessionId,
            provider: chatOnScreen.provider,
            cwd: chatOnScreen.cwd
          }
        : { kind: 'none' }
    void api.setAttentionFocus(focus)
  }, [roundtableOnScreen, chatOnScreen?.provider, chatOnScreen?.cwd, selectedSessionId])

  // a clicked notification: main has already brought the window forward
  const openTargetRef = useRef<(target: AttentionTarget) => void>(() => {})
  openTargetRef.current = (target) => {
    if (target.kind === 'roundtable') {
      openRoundtable(target.id)
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
    <div className="app">
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
        <RoundtableView id={view.id} />
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
          prBusy={creatingPr}
          onSend={send}
          onCancel={cancel}
          onCreatePr={createPr}
          onOpenUrl={openUrl}
          onOpenHandoff={openHandoff}
          onOpenLineage={(id) => void openLineage(id)}
          permissions={permissions}
          onAnswerPermission={answerPermission}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          repos={visibleRepos}
          scopeRepo={scopeRepo}
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
