import { useCallback, useEffect, useRef, useState } from 'react'
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
import { TreeSidebar } from './TreeSidebar'
import { ChatView } from './ChatView'
import { NewSession } from './NewSession'
import { Settings } from './Settings'
import { AiSetup } from './AiSetup'
import { HomeView } from './HomeView'
import type { AccountChoice } from './NewSession'
import type { AccountsSnapshot, AgentOptions } from '../../shared/types'

export interface ChatBinding {
  provider: Provider
  cwd: string
  nativeSessionId: string | null
  title: string
  branch: string | null
  repoRoot: string | null
  /** Per-agent options chosen at session start; reused for every turn */
  options?: AgentOptions
  /** Account chosen at session start (config home + copilot user) */
  configDir?: string
  copilotUser?: string
  /** Human-readable identity shown in the chat header */
  accountLabel?: string
}

type View =
  | { kind: 'welcome' }
  | { kind: 'chat' }
  | { kind: 'new'; repo: RepoGroup }
  | { kind: 'settings' }
  | { kind: 'extensions' }

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
  const activeTurnRef = useRef<string | null>(null)
  activeTurnRef.current = activeTurn
  /** Events can beat the sendChat() reply for fast-failing spawns — hold them briefly. */
  const pendingEventsRef = useRef<ChatEvent[]>([])
  /** Guards against a slow transcript load landing after the user switched sessions. */
  const openSeqRef = useRef(0)
  /** Streamed text is batched (~40ms) so each stdout chunk doesn't re-render the log. */
  const textBufRef = useRef('')
  const textFlushRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const load = (): void => {
      void api.listRepos().then(setRepos)
      void api.getAccounts().then(setAccounts)
      setIndexVersion((v) => v + 1)
    }
    load()
    return api.onIndexUpdated(load)
  }, [])

  // menu zoom (⌘+/-) has no renderer event — poll, clamp to limits, surface the level
  useEffect(() => {
    const t = setInterval(() => {
      const z = api.getZoomFactor()
      if (z > 1.5 || z < 0.7) api.setZoomFactor(z)
      setZoom(Math.round(api.getZoomFactor() * 100) / 100)
    }, 1200)
    return () => clearInterval(t)
  }, [])

  // global shortcuts: ⌘K search, ⌘N new task, Esc backs out of secondary views
  const bindingRef = useRef<ChatBinding | null>(null)
  bindingRef.current = binding
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'k') {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.search')?.focus()
      } else if (mod && e.key === 'n') {
        e.preventDefault()
        setView({ kind: 'welcome' })
      } else if (e.key === 'Escape') {
        setView((v) =>
          v.kind === 'settings' || v.kind === 'extensions' || v.kind === 'new'
            ? bindingRef.current
              ? { kind: 'chat' }
              : { kind: 'welcome' }
            : v
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        setBinding((b) => (b ? { ...b, nativeSessionId: ev.nativeSessionId } : b))
      } else if (ev.type === 'text') {
        textBufRef.current += ev.text
        if (!textFlushRef.current) textFlushRef.current = setTimeout(flushText, 40)
      } else if (ev.type === 'tool') {
        flushText()
        setLog((l) => [
          ...l,
          { role: 'assistant', kind: 'tool_call', toolName: ev.toolName, text: ev.detail }
        ])
      } else if (ev.type === 'error') {
        flushText()
        setLog((l) => [...l, { role: 'system', kind: 'system', text: ev.message }])
      } else if (ev.type === 'done') {
        flushText()
        setActiveTurn(null)
        setLog((l) => (l.some((m) => m.streaming) ? l.map((m) => ({ ...m, streaming: false })) : l))
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
        accountLabel: acct ? (acct.identity ?? acct.label) : undefined
      })
      setView({ kind: 'chat' })
      setLog([])
      const messages = await api.getSessionMessages(s.id)
      // a slower load for a previously clicked session must not clobber this one
      if (seq === openSeqRef.current) setLog(messages)
    },
    [accounts]
  )

  const send = useCallback(
    async (prompt: string, permissionMode: PermissionMode) => {
      if (!binding || activeTurn) return
      setLog((l) => [...l, { role: 'user', kind: 'text', text: prompt }])
      const turnId = await api.sendChat({
        provider: binding.provider,
        cwd: binding.cwd,
        prompt,
        resumeNativeId: binding.nativeSessionId ?? undefined,
        permissionMode,
        options: binding.options,
        configDir: binding.configDir,
        copilotUser: binding.copilotUser
      })
      beginTurn(turnId)
    },
    [binding, activeTurn, beginTurn]
  )

  /** New session flow: create worktree, bind chat, fire the first prompt. */
  const startSession = useCallback(
    async (
      repo: RepoGroup,
      provider: Provider,
      name: string,
      prompt: string,
      mode: PermissionMode,
      options: AgentOptions,
      account: AccountChoice = {}
    ): Promise<string | null> => {
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
          { role: 'user', kind: 'text', text: prompt }
        ])
        const turnId = await api.sendChat({
          provider,
          cwd: ws.cwd,
          prompt,
          permissionMode: mode,
          options,
          configDir: account.configDir,
          copilotUser: account.copilotUser
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

  const cancel = useCallback(() => {
    if (activeTurn) {
      void api.cancelChat(activeTurn)
      setActiveTurn(null)
    }
  }, [activeTurn])

  const createPr = useCallback(async () => {
    if (!binding) return
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
    }
  }, [binding])

  const openUrl = useCallback((url: string) => void api.openExternal(url), [])

  return (
    <div className="app">
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
        onGoHome={() => setView({ kind: 'welcome' })}
        onOpenSettings={() => setView({ kind: 'settings' })}
        onOpenExtensions={() => setView({ kind: 'extensions' })}
        onOpenUrl={openUrl}
      />
      {view.kind === 'settings' ? (
        <Settings onClose={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })} />
      ) : view.kind === 'extensions' ? (
        <AiSetup
          repos={repos}
          onClose={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })}
          onOpenUrl={openUrl}
        />
      ) : view.kind === 'new' ? (
        <NewSession
          repo={view.repo}
          repos={repos}
          busy={creating}
          onStart={startSession}
          onCancel={() => setView(binding ? { kind: 'chat' } : { kind: 'welcome' })}
        />
      ) : view.kind === 'welcome' ? (
        <HomeView
          repos={repos}
          indexVersion={indexVersion}
          busy={creating}
          onStart={startSession}
          onOpenSession={openSession}
        />
      ) : (
        <ChatView
          binding={binding}
          prs={prs}
          log={log}
          busy={activeTurn !== null}
          onSend={send}
          onCancel={cancel}
          onCreatePr={createPr}
          onOpenUrl={openUrl}
        />
      )}
    </div>
  )
}
