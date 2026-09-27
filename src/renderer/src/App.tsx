import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react'
import type {
  AccountsSnapshot,
  AttentionFocus,
  AttentionTarget,
  ChatRequest,
  PermissionMode,
  PrStatus,
  RepoGroup,
  SessionControl,
  SessionHolder,
  SessionMessage,
  SessionMeta
} from '../../shared/types'
import { PROVIDERS } from '../../shared/library'
import { api } from './api'
import { followUpRepo } from './follow-up'
import { withImageMarks } from './attachments'
import { TreeSidebar } from './TreeSidebar'
import { ChatView } from './ChatView'
import { CleanupView } from './CleanupView'
import { CommandPalette, type PaletteViewKey } from './CommandPalette'
import { NewSession } from './NewSession'
import { HandoffView, type StartHandoffRequest } from './HandoffView'
import { NewRoundtable } from './NewRoundtable'
import { RoundtableView } from './RoundtableView'
import { PROVIDER_LABEL } from './logos'
import { Settings } from './Settings'
import { branchHint, taskTitle } from './task-names'
import { ipcErrorText } from './ipc-error'
import { initLanded } from './landed'
import { initSideChat } from './side-chat-log'
import { ProfileView } from './ProfileView'
import { AiSetup } from './AiSetup'
import { HomeView } from './HomeView'
import { DevBanner } from './DevBanner'
import { initBusySessions, spawnedTurn, useSessionRunsElsewhere } from './busy'
import { useRailWidth } from './rail'
import { addChatMessage, addChatNotice, refreshChatLog, setChatLog } from './chat-log'
import { preloadMarkdown } from './Markdown'
import { initTimeFormat } from './time'
import { initBranchPrefix } from './branch-prefix'
import { keepSame } from './same'
import type { StartSessionRequest } from './agent-choice'
import type { ChatBinding, TranscriptAnchor } from './chat-binding'
import type { NavEntry, View } from './nav-history'
import { useChatTurns } from './use-chat-turns'
import { useNavHistory } from './use-nav-history'
import { useZoom } from './use-zoom'

/** `--rail` on the grid: the width the rail was dragged to, in CSS pixels. */
const railStyle = (px: number): CSSProperties => ({ '--rail': `${px}px` }) as CSSProperties

/** A conversation Cockpit itself just started — held here until the index says otherwise. */
function startedHere(): SessionControl {
  return { holder: 'cockpit', how: 'started', since: Date.now() }
}

/** `provider:nativeId` → the chip's {id, provider}; null for anything malformed
 *  (the lineage map lives in a hand-editable config file). */
function lineageRef(id: string | undefined): ChatBinding['continuedFrom'] | undefined {
  if (!id) return undefined
  const provider = PROVIDERS.find((p) => p === id.split(':', 1)[0])
  return provider ? { id, provider } : undefined
}

/** Where closing a view lands: the conversation still bound, else home. */
function behind(binding: ChatBinding | null): View {
  return binding ? { kind: 'chat' } : { kind: 'welcome' }
}

/** What a turn carries beyond the conversation it belongs to. */
type TurnInput = Pick<ChatRequest, 'prompt' | 'permissionMode' | 'images' | 'handoffFrom'>

/** A turn of the conversation `b` is bound to: its agent, directory, account and options. */
function turnRequest(b: ChatBinding, turn: TurnInput): ChatRequest {
  return {
    provider: b.provider,
    cwd: b.cwd,
    resumeNativeId: b.nativeSessionId ?? undefined,
    options: b.options,
    configDir: b.configDir,
    copilotUser: b.copilotUser,
    ...turn
  }
}

export function App(): JSX.Element {
  const [repos, setRepos] = useState<RepoGroup[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [view, setView] = useState<View>({ kind: 'welcome' })
  const [indexVersion, setIndexVersion] = useState(0)
  /** The first full scan has finished — an empty repo list is real, not unread */
  const [indexed, setIndexed] = useState(false)
  const [prs, setPrs] = useState<PrStatus[]>([])
  const [binding, setBinding] = useState<ChatBinding | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  /** Who drives the open conversation (main's record, re-read as the index changes);
   *  null while unknown and for a seat, which its table drives */
  const [control, setControl] = useState<SessionControl | null>(null)
  /** Where the open chat should land: the message a transcript-search hit named */
  const [anchor, setAnchor] = useState<TranscriptAnchor | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingPr, setCreatingPr] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const selectedSessionIdRef = useRef<string | null>(null)
  selectedSessionIdRef.current = selectedSessionId
  const bindingRef = useRef<ChatBinding | null>(null)
  bindingRef.current = binding
  /** Read at the click, so `openSession` — every sidebar row's handler — stays one function */
  const accountsRef = useRef<AccountsSnapshot | null>(null)
  accountsRef.current = accounts
  const paletteOpenRef = useRef(false)
  paletteOpenRef.current = paletteOpen
  /** Guards against a slow transcript load landing after the user switched sessions. */
  const openSeqRef = useRef(0)
  /**
   * The transcript on screen as read from disk: which session, and when. A session
   * run in a terminal keeps writing under this view, so on every index update the
   * log is re-read when the index says it moved past this stamp. Null while the
   * view holds something disk does not — a turn Cockpit is streaming — and for a
   * conversation with no indexed session yet.
   */
  const diskLogRef = useRef<{ readonly id: string; readonly at: number } | null>(null)
  const armDiskLog = useCallback((id: string | null): void => {
    diskLogRef.current = id === null ? null : { id, at: Date.now() }
  }, [])

  const { zoom, resetZoom } = useZoom()

  // the rail's width once it has been dragged: it reaches the grid as `--rail`, which
  // the stylesheet holds to the bounds (`.app`) — nothing stored, nothing set
  const rail = useRailWidth()

  const { step, followMint } = useNavHistory({ view, binding, sessionId: selectedSessionId })

  /** What the agent is called in an announcement — the provider behind this chat. */
  const speaker = useCallback(
    () => PROVIDER_LABEL[bindingRef.current?.provider ?? 'claude'],
    []
  )

  /**
   * A turn named its session. Keep the tree highlight tracking the live conversation:
   * row ids are `${provider}:${nativeId}`, and providers can mint a new session id on
   * resume (claude forks one per turn) or on first turn of a new session.
   */
  const followSession = useCallback(
    (nativeSessionId: string) => {
      const provider = bindingRef.current?.provider
      if (provider) {
        const newId = `${provider}:${nativeSessionId}`
        const oldId = selectedSessionIdRef.current
        setSelectedSessionId(newId)
        // history entries for this conversation follow the mint — restoring
        // one later must resume the new id, not fork a pre-turn snapshot
        followMint({ oldId, newId, nativeSessionId, binding: bindingRef.current })
      }
      setBinding((b) => (b ? { ...b, nativeSessionId } : b))
    },
    [followMint]
  )

  // a turn is over: the log on disk is the conversation again
  const settleLog = useCallback(() => armDiskLog(selectedSessionIdRef.current), [armDiskLog])

  const {
    activeTurn,
    activeTurnRef,
    permissions,
    answerPermission,
    run: runTurn,
    join: joinTurn,
    logLanded,
    cancel
  } = useChatTurns({ speaker, onSession: followSession, onSettled: settleLog })

  useEffect(() => initBusySessions(), [])
  // the open session's agent is running in a terminal or its own app — its log is
  // the live thing, and Send waits (a spawned turn of ours never reads as this)
  const elsewhere = useSessionRunsElsewhere(selectedSessionId)
  // who drives the open conversation follows main's record: read again whenever the
  // index moves — a take-over or release (here or in another window), or the id a
  // resumed claude turn forks. A just-minted id the index can't name yet keeps what
  // the conversation already had.
  useEffect(() => {
    const id = selectedSessionId
    if (id === null) return
    let dead = false
    void api.getSession(id).then((s) => {
      if (dead || !s) return
      const next = s.roundtableId ? null : (s.control ?? null)
      setControl((prev) => keepSame(prev, next))
    })
    return () => {
      dead = true
    }
  }, [selectedSessionId, indexVersion])
  useEffect(() => initLanded(), [])
  // side questions' answers land while their panel is closed, or another view is up
  useEffect(() => initSideChat(), [])
  // the transcript's markdown pipeline is its own chunk — warm it once the window
  // is up, so the first session opened renders formatted with no plain-text flash
  useEffect(() => preloadMarkdown(), [])

  useEffect(() => {
    void initTimeFormat()
    void initBranchPrefix()
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
          // the same conversation, further on: rows it already showed keep their place
          refreshChatLog(messages)
          armDiskLog(stamp.id)
        })
        .catch(() => {})
    }
    const load = (): void => {
      // every push answers with fresh clones: one that says what the rail already
      // shows must not redraw it (or re-make `openSession` for every row under it)
      void api.listRepos().then((r) => setRepos((prev) => keepSame(prev, r)))
      void api.getAccounts().then((a) => setAccounts((prev) => keepSame(prev, a)))
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

  // PR statuses for the repo behind the open chat
  useEffect(() => {
    const root = binding?.repoRoot
    if (!root) {
      setPrs([])
      return
    }
    let dead = false
    void api.getPrs(root).then((p) => !dead && setPrs((prev) => keepSame(prev, p)))
    return () => {
      dead = true
    }
  }, [binding?.repoRoot, indexVersion])

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
      // with no rejoined turn to let in behind it, the log on disk is the conversation
      if (!logLanded(messages ?? []) && messages) armDiskLog(id)
    },
    [logLanded, armDiskLog]
  )

  /**
   * Put a conversation on screen in place of the one there: an empty log until its own is
   * read, its binding, who drives it, where it should land, and a turn of ours still
   * running on it rejoined (`turn`). Returns this open's sequence number, which the log
   * read and any lookup behind it must still hold when they land.
   */
  const mountConversation = useCallback(
    (c: {
      readonly sessionId: string | null
      readonly binding: ChatBinding
      readonly control: SessionControl | null
      readonly anchor: TranscriptAnchor | null
      readonly turn: string | null
    }): number => {
      const seq = ++openSeqRef.current
      setChatLog([])
      diskLogRef.current = null
      setSelectedSessionId(c.sessionId)
      setControl(c.control)
      setAnchor(c.anchor)
      setBinding(c.binding)
      setView({ kind: 'chat' })
      joinTurn(c.turn)
      return seq
    },
    [joinTurn]
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
      // restore the account this session's source dir belongs to — otherwise a
      // reopened session would silently continue on the default account.
      // (SessionMeta.source is the source LABEL; copilot's historical user is
      // unknowable from logs, so copilotUser is deliberately left unset.)
      const acct = accountsRef.current?.accounts.find(
        (a) => a.provider === s.provider && a.label === s.source
      )
      const seq = mountConversation({
        sessionId: s.id,
        binding: {
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
        },
        control: s.roundtableId ? null : (s.control ?? null),
        anchor: opts.anchor ?? null,
        // a seat's turn is its table's, and streams there — the seat's chat only reads
        turn: s.roundtableId ? null : spawnedTurn(s.id)
      })
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
    [mountConversation, landLog, activeTurnRef]
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
      if (sameChat) {
        setView({ kind: 'chat' })
        return
      }
      // an entry with no id is a new chat that never announced one: nothing to rejoin
      // and no log to read
      const id = entry.sessionId
      const seq = mountConversation({
        sessionId: id,
        binding: entry.binding,
        // a chat that never announced an id is one Cockpit started; any other is read
        // back from the index as the id lands
        control: id === null && !entry.binding.readOnly ? startedHere() : null,
        anchor: null,
        turn: id !== null && !entry.binding.readOnly ? spawnedTurn(id) : null
      })
      if (id !== null) void landLog(seq, id)
    },
    [mountConversation, landLog]
  )

  const goBack = useCallback(() => {
    const entry = step(-1)
    if (entry) restoreNav(entry)
  }, [step, restoreNav])

  const goForward = useCallback(() => {
    const entry = step(1)
    if (entry) restoreNav(entry)
  }, [step, restoreNav])

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
            ? behind(bindingRef.current)
            : v
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goBack, goForward])

  const send = useCallback(
    async (prompt: string, permissionMode: PermissionMode, images?: readonly string[]) => {
      // a session with its agent is taken over first — main refuses it otherwise too
      if (!binding || activeTurn || binding.readOnly || elsewhere || control?.holder === 'agent') return
      // from here the view holds what disk does not — no re-read may land on it
      diskLogRef.current = null
      // the transcript shows attachments as one marker line per image
      addChatMessage({ role: 'user', kind: 'text', text: withImageMarks(prompt, images) })
      try {
        await runTurn(turnRequest(binding, { prompt, permissionMode, images }))
      } catch (err) {
        // a rejected invoke (e.g. copilot account no longer logged in) must not
        // leave the prompt looking sent with no reply and no error
        addChatNotice(`Send failed: ${ipcErrorText(err)}`)
      }
    },
    [binding, activeTurn, elsewhere, control, runTurn]
  )

  /** Take the open session over, or release it back to its agent. */
  const setHolder = useCallback(async (holder: SessionHolder): Promise<boolean> => {
    const id = selectedSessionIdRef.current
    if (id === null) return false
    try {
      const next = await api.setSessionHolder(id, holder)
      if (selectedSessionIdRef.current === id) setControl(next)
      return true
    } catch (err) {
      addChatNotice(`Couldn't ${holder === 'cockpit' ? 'take it over' : 'release it'}: ${ipcErrorText(err)}`)
      return false
    }
  }, [])

  /** Release the open session and resume it in its agent's own CLI, in Terminal. */
  const resumeInTerminal = useCallback(async (): Promise<boolean> => {
    const id = selectedSessionIdRef.current
    if (id === null) return false
    try {
      await api.resumeInTerminal(id)
      const s = await api.getSession(id)
      if (s?.control && selectedSessionIdRef.current === id) setControl(s.control)
      return true
    } catch (err) {
      addChatNotice(`Couldn't open it in Terminal: ${ipcErrorText(err)}`)
      return false
    }
  }, [])

  /**
   * A conversation Cockpit starts itself — a new session in its own worktree, or a handoff
   * in the source's — bound, on screen with its opening rows, and its first turn sent.
   * Rejects as `sendChat` does; the form it was started from says why.
   */
  const launchChat = useCallback(
    async (launch: {
      readonly binding: ChatBinding
      /** What the transcript opens with: notes, then the first prompt as the person wrote it */
      readonly rows: readonly SessionMessage[]
      readonly turn: TurnInput
    }): Promise<void> => {
      // a session opened just before is still reading its log: that read, its parent
      // lookup and a disk-log refresh must all land nowhere now, and its search anchor
      // belongs to it — the same reset mountConversation gives an opened session
      openSeqRef.current++
      diskLogRef.current = null
      setAnchor(null)
      setSelectedSessionId(null)
      setControl(startedHere())
      setBinding(launch.binding)
      setView({ kind: 'chat' })
      setChatLog(launch.rows)
      await runTurn(turnRequest(launch.binding, launch.turn))
    },
    [runTurn]
  )

  /** New session flow: create worktree, bind chat, fire the first prompt. */
  const startSession = useCallback(
    async (req: StartSessionRequest): Promise<string | null> => {
      const { repo, provider, name, prompt, mode, options, account, images } = req
      if (!repo.root) return 'This group has no git repository.'
      setCreating(true)
      try {
        const ws = await api.createWorkspace(repo.root, name || branchHint(prompt))
        await launchChat({
          binding: {
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
          },
          rows: [
            {
              role: 'system',
              kind: 'system',
              text: `Worktree ready on ${ws.branch} — running isolated from your main checkout.`
            },
            ...(ws.warning ? [{ role: 'system', kind: 'system', text: ws.warning } as const] : []),
            { role: 'user', kind: 'text', text: withImageMarks(prompt, images) }
          ],
          turn: { prompt, permissionMode: mode, images }
        })
        return null
      } catch (err) {
        return ipcErrorText(err)
      } finally {
        setCreating(false)
      }
    },
    [launchChat]
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
  }, [activeTurnRef])

  /**
   * A suggestion the open session's agent made, started as a session of its own: the
   * new-session form, filled in, on the repo it names (its `cwd`), else the session's
   * own — so any agent can take it, in a worktree of its own. Its title leads the task:
   * the first line is what names the branch and the session.
   */
  const startFollowUp = useCallback(
    (followUp: { readonly title: string; readonly prompt: string; readonly cwd?: string }) => {
      const repo = followUpRepo(repos, followUp, bindingRef.current)
      if (repo) setView({ kind: 'new', repo, draft: `${followUp.title}\n\n${followUp.prompt}` })
    },
    [repos]
  )

  /** Handoff flow: same shape as startSession minus the worktree — the source
   *  session's directory IS the workspace, and the briefing is the first prompt. */
  const startHandoff = useCallback(
    async (req: StartHandoffRequest): Promise<string | null> => {
      const { source, provider, briefing, mode, options, account } = req
      setCreating(true)
      try {
        await launchChat({
          binding: {
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
          },
          rows: [
            {
              role: 'system',
              kind: 'system',
              text: `Continuing from ${PROVIDER_LABEL[source.provider]} in ${source.cwd} — same worktree, same branch.`
            },
            { role: 'user', kind: 'text', text: briefing }
          ],
          turn: { prompt: briefing, permissionMode: mode, handoffFrom: source.id }
        })
        return null
      } catch (err) {
        return ipcErrorText(err)
      } finally {
        setCreating(false)
      }
    },
    [launchChat]
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
      addChatNotice(`PR failed: ${ipcErrorText(err)}`)
    } finally {
      setCreatingPr(false)
    }
  }, [binding, creatingPr])

  const openUrl = useCallback((url: string) => void api.openExternal(url), [])

  /** Close a view: back to the conversation still bound, else home. */
  const backOut = useCallback(() => setView(behind(bindingRef.current)), [])

  /** Nav icons are stateful: opening the view you're already on backs out of it. */
  const toggleView = useCallback((kind: 'settings' | 'extensions' | 'profile' | 'cleanup') => {
    setView((v) => {
      if (v.kind === kind) return behind(bindingRef.current)
      return kind === 'extensions' ? { kind, repoRoot: null } : { kind }
    })
  }, [])

  /** The rail's per-repo entry point: the same view, scoped to that repo. */
  const openRepoSetup = useCallback((repoRoot: string) => {
    setView({ kind: 'extensions', repoRoot })
  }, [])

  const newSession = useCallback((repo: RepoGroup) => setView({ kind: 'new', repo }), [])

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
        onResetZoom={resetZoom}
        selectedId={selectedSessionId}
        onSelect={openSession}
        onNewSession={newSession}
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
        <CleanupView onClose={backOut} />
      ) : view.kind === 'profile' ? (
        <ProfileView onClose={backOut} />
      ) : view.kind === 'settings' ? (
        <Settings section={view.section} openCount={view.openCount} onClose={backOut} />
      ) : view.kind === 'extensions' ? (
        <AiSetup
          repos={repos}
          repoRoot={view.repoRoot}
          onScope={(repoRoot) => setView({ kind: 'extensions', repoRoot })}
          onClose={backOut}
        />
      ) : view.kind === 'new' ? (
        <NewSession
          repo={view.repo}
          repos={visibleRepos}
          busy={creating}
          initialPrompt={view.draft}
          initialImages={view.draftImages}
          onStart={startSession}
          onCancel={backOut}
        />
      ) : view.kind === 'handoff' ? (
        <HandoffView source={view.source} busy={creating} onStart={startHandoff} onCancel={backOut} />
      ) : view.kind === 'new-roundtable' ? (
        <NewRoundtable repos={visibleRepos} onCreated={openRoundtable} onCancel={backOut} />
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
          onStartFollowUp={startFollowUp}
          onOpenLineage={(id) => void openLineage(id)}
          permissions={permissions}
          onAnswerPermission={answerPermission}
          control={control}
          onSetHolder={setHolder}
          onResumeInTerminal={resumeInTerminal}
          anchor={anchor}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          repos={visibleRepos}
          scopeRepo={scopeRepo}
          onOpenSession={(s, at) => void openSession(s, at ? { anchor: at } : {})}
          onNewSession={newSession}
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
