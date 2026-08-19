import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  PermissionMode,
  Provider,
  RepoGroup,
  RoundtableMeta,
  SessionMeta
} from '../../shared/types'
import { api } from './api'
import { AttachRow, useImageAttachments, type ImageAttachment } from './attachments'
import { useBusyMap } from './busy'
import { accountOptions, MODES, savedAccount, type StartSessionRequest } from './NewSession'
import { BranchChip, LiveDot, ProviderLogo, PROVIDER_LABEL, RepoIcon } from './logos'
import { Select } from './Select'
import { fmtElapsed, fmtTime, useTimeFormat } from './time'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

/** "titan-ron" → "Titan": the login's first name-ish segment, capitalized. */
function firstName(login: string): string {
  const first = login.split(/[-._]/, 1)[0] || login
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/**
 * Mission-control home, patterned after GitHub's Agent HQ: a task composer front
 * and center (repo + agent + permissions inline), recent agent work below it.
 */
export function HomeView({
  repos,
  indexVersion,
  busy,
  onStart,
  onOpenSession,
  onOpenFull,
  onNewRoundtable,
  onOpenRoundtable
}: {
  repos: RepoGroup[]
  indexVersion: number
  busy: boolean
  onStart: (req: StartSessionRequest) => Promise<string | null>
  onOpenSession: (s: SessionMeta) => void
  /** Open the full New session form (branch, model, custom provider), keeping the draft */
  onOpenFull: (repo: RepoGroup, draft: string, images?: readonly ImageAttachment[]) => void
  onNewRoundtable: () => void
  onOpenRoundtable: (id: string) => void
}): JSX.Element {
  const selectable = useMemo(() => repos.filter((r) => r.root), [repos])
  const [repoKey, setRepoKey] = useState<string | null>(null)
  const [provider, setProvider] = useState<Provider>(
    () => (window.localStorage.getItem('cockpit:provider') as Provider) ?? 'claude'
  )
  const [mode, setMode] = useState<PermissionMode>(
    () => (window.localStorage.getItem('cockpit:mode') as PermissionMode) ?? 'auto-edit'
  )
  const [prompt, setPrompt] = useState('')
  const atts = useImageAttachments()
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<SessionMeta[]>([])
  const [recentTotal, setRecentTotal] = useState(0)
  const [tables, setTables] = useState<RoundtableMeta[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [accountKey, setAccountKey] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const opts = useMemo(() => accountOptions(accounts, provider), [accounts, provider])
  const account = opts.find((o) => o.key === accountKey) ?? savedAccount(accounts, provider) ?? null

  useEffect(() => {
    setAccountKey(null)
  }, [provider])

  const selected =
    selectable.find((r) => r.key === repoKey) ?? (selectable.length > 0 ? selectable[0] : null)

  useEffect(() => {
    promptRef.current?.focus()
    void api.getAccounts().then(setAccounts)
  }, [])

  useEffect(() => {
    let dead = false
    void api.pageSessions({ limit: 10 }).then((p) => {
      if (dead) return
      setRecent(p.items)
      setRecentTotal(p.total)
    })
    return () => {
      dead = true
    }
  }, [indexVersion])

  // roundtable strip: reload on mount and whenever a round starts/ends elsewhere
  useEffect(() => {
    let dead = false
    const load = (): void => {
      void api.listRoundtables?.().then((r) => !dead && setTables(r))
    }
    load()
    const unsub = api.onRoundtableEvent?.((ev) => {
      if (ev.type === 'round') load()
    })
    return () => {
      dead = true
      unsub?.()
    }
  }, [indexVersion])

  const start = async (): Promise<void> => {
    // same guard the Start button enforces — ⌘Enter must not start a session
    // under no account once the accounts snapshot says there is none
    if (
      busy ||
      (!prompt.trim() && atts.attachments.length === 0) ||
      !selected ||
      (accounts !== null && !account)
    )
      return
    setError(null)
    window.localStorage.setItem('cockpit:provider', provider)
    window.localStorage.setItem('cockpit:mode', mode)
    if (account) window.localStorage.setItem(`cockpit:account:${provider}`, account.key)
    const err = await onStart({
      repo: selected,
      provider,
      name: '',
      prompt: prompt.trim(),
      mode,
      options: {},
      account: {
        configDir: account?.configDir,
        copilotUser: account?.copilotUser,
        display: account?.display
      },
      images: atts.paths()
    })
    if (err) setError(err)
  }

  return (
    <main className="chat home-view">
      <div className="home-inner">
        {recent.length > 0 && (
          <Board sessions={recent} total={recentTotal} onOpen={onOpenSession} />
        )}
        {tables.length > 0 && <RoundtableStrip tables={tables} onOpen={onOpenRoundtable} />}
        <div className="home-hero">
          <h2>
            What should we ship
            {accounts?.githubUser ? (
              <span className="hero-name">, {firstName(accounts.githubUser)}?</span>
            ) : (
              '?'
            )}
          </h2>
          <p className="home-sub">
            Assign a task to an agent — it runs in an isolated worktree and lands as a PR.
            <span className="home-kbd">⌘N new task · ⌘K jump anywhere</span>
          </p>
        </div>

        <div className="composer-card">
          <AttachRow atts={atts} />
          <textarea
            ref={promptRef}
            aria-label="Task description"
            placeholder="Describe a task…  (⌘Enter to start)"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={atts.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start()
            }}
          />
          <div className="composer-bar">
            <span className="composer-repo-icon"><RepoIcon size={13} /></span>
            <Select
              className="composer-repo"
              ariaLabel="Repository"
              value={selected?.key ?? ''}
              options={
                selectable.length > 0
                  ? selectable.map((r) => ({ value: r.key, label: r.fullName ?? r.name }))
                  : [{ value: '', label: 'no repositories indexed yet' }]
              }
              onChange={setRepoKey}
            />
            <div className="composer-identity">
              <div className="composer-agents" role="group" aria-label="Agent">
                {PROVIDERS.map((p) => {
                  const pAcct = savedAccount(accounts, p)
                  return (
                    <button
                      key={p}
                      aria-pressed={provider === p}
                      aria-label={PROVIDER_LABEL[p]}
                      title={`${PROVIDER_LABEL[p]} — ${pAcct?.display ?? 'not signed in'}`}
                      className={`composer-agent plogo-${p} ${provider === p ? 'active' : ''} ${
                        accounts !== null && !pAcct ? 'no-acct' : ''
                      }`}
                      onClick={() => setProvider(p)}
                    >
                      <ProviderLogo p={p} size={15} />
                    </button>
                  )
                })}
              </div>
              {accounts === null ? (
                // still loading — an empty placeholder, never a false "not signed in"
                <span className="acct-chip" aria-hidden="true">
                  …
                </span>
              ) : opts.length > 0 ? (
                <Select
                  className="composer-acct-wrap"
                  mono
                  quiet
                  ariaLabel={`${PROVIDER_LABEL[provider]} account`}
                  title={`${PROVIDER_LABEL[provider]} account in use`}
                  value={account?.key ?? ''}
                  options={opts.map((o) => ({ value: o.key, label: o.display }))}
                  onChange={(v) => {
                    window.localStorage.setItem(`cockpit:account:${provider}`, v)
                    setAccountKey(v)
                  }}
                />
              ) : (
                <span className="acct-chip missing">not signed in</span>
              )}
            </div>
            <Select
              ariaLabel="Permission mode"
              value={mode}
              options={MODES.map((m) => ({ value: m.v, label: m.label, title: m.hint }))}
              onChange={(v) => setMode(v as PermissionMode)}
            />
            <button
              className="btn-primary"
              title={account ? `runs as ${account.display}` : undefined}
              disabled={
                busy ||
                (!prompt.trim() && atts.attachments.length === 0) ||
                !selected ||
                (accounts !== null && !account)
              }
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : `Start with ${PROVIDER_LABEL[provider]}`}
            </button>
          </div>
        </div>
        <div className="home-more">
          <button className="link-btn" disabled={busy} onClick={onNewRoundtable}>
            Start a roundtable — several agents, one discussion
          </button>
          {selected && (
            <button
              className="link-btn"
              disabled={busy}
              onClick={() => onOpenFull(selected, prompt, atts.release())}
            >
              All options — branch name, model, custom model provider…
            </button>
          )}
        </div>
        {mode === 'yolo' && (
          <div className="ns-hint yolo">{MODES.find((m) => m.v === 'yolo')?.hint}</div>
        )}
        {error && <div className="new-error" role="alert">{error}</div>}

      </div>
    </main>
  )
}

/**
 * The board — the home view's opening move and the app's signature element:
 * a departure-board of sessions, flying first. Livery-colored pulse + placard
 * agent label + branch + elapsed time for running sessions; idle sessions keep
 * their timestamp. Replaces the old "Recent activity" list (the sidebar remains
 * the exhaustive one).
 */
function Board({
  sessions,
  total,
  onOpen
}: {
  sessions: SessionMeta[]
  total: number
  onOpen: (s: SessionMeta) => void
}): JSX.Element {
  const busy = useBusyMap()
  // the elapsed column ticks only while something is actually flying
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (busy.size === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy.size])

  // flying first (longest airborne on top); idle keep their recency order
  const flying = sessions
    .filter((s) => busy.has(s.id))
    .sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))
  const ground = sessions.filter((s) => !busy.has(s.id))
  const groundTotal = Math.max(total - flying.length, ground.length)

  return (
    <section className="board" aria-label="Session board">
      <div className="board-head">
        {/* h2, not h3: the board renders above the hero's h2, and a heading that
            outranks nothing above it would read as a skipped level.
            Polite live region — turn starts/completions announce the new counts */}
        <h2 className="board-eyebrow" aria-live="polite">
          {flying.length > 0 ? (
            <>
              <b>{flying.length} flying</b> · {groundTotal} on the ground
            </>
          ) : (
            <>all on the ground</>
          )}
        </h2>
      </div>
      <ul className="board-list">
        {[...flying, ...ground].map((s) => (
          <BoardRow key={s.id} s={s} startedAt={busy.get(s.id)} now={now} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  )
}

/**
 * Ongoing roundtables, in the board's visual grammar: identity dots, title, time.
 * A running round pulses accent — no single agent owns a multi-agent table.
 */
function RoundtableStrip({
  tables,
  onOpen
}: {
  tables: RoundtableMeta[]
  onOpen: (id: string) => void
}): JSX.Element {
  const timeFormat = useTimeFormat()
  return (
    <section className="board" aria-label="Roundtables">
      <div className="board-head">
        <h2 className="board-eyebrow">roundtables</h2>
      </div>
      <ul className="board-list">
        {tables.map((t) => (
          <li key={t.id}>
            <button
              className={`board-row ${t.running ? 'flying' : ''}`}
              title={`${t.providers.map((p) => PROVIDER_LABEL[p]).join(' + ')} — ${t.title}`}
              onClick={() => onOpen(t.id)}
            >
              {t.running ? (
                <span className="pulse" role="img" aria-label="round in progress" />
              ) : (
                <span className="board-dot-idle" aria-hidden="true" />
              )}
              <span className="rt-seats">
                {t.providers.map((p) => (
                  <span key={p} className={`rt-seat plogo-${p}`}>
                    <ProviderLogo p={p} size={12} />
                  </span>
                ))}
              </span>
              {t.branch && <BranchChip branch={t.branch} />}
              <span className="board-task">{t.title}</span>
              <time className="board-meta" dateTime={new Date(t.updatedAt).toISOString()}>
                {fmtTime(t.updatedAt, timeFormat)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function BoardRow({
  s,
  startedAt,
  now,
  onOpen
}: {
  s: SessionMeta
  /** Epoch ms the running turn started; undefined = on the ground */
  startedAt: number | undefined
  now: number
  onOpen: (s: SessionMeta) => void
}): JSX.Element {
  const timeFormat = useTimeFormat()
  const flying = startedAt !== undefined
  return (
    <li>
      <button
        className={`board-row ${flying ? 'flying' : ''}`}
        title={`${PROVIDER_LABEL[s.provider]} — ${s.title}${s.gitBranch ? `\n⎇ ${s.gitBranch}` : ''}`}
        onClick={() => onOpen(s)}
      >
        {flying ? (
          <LiveDot p={s.provider} />
        ) : (
          <span className="board-dot-idle" aria-hidden="true" />
        )}
        <span className={`board-agent board-agent-${s.provider}`}>
          {PROVIDER_LABEL[s.provider]}
        </span>
        {s.gitBranch && <BranchChip branch={s.gitBranch} />}
        <span className="board-task">{s.title}</span>
        {s.repo && <span className="board-repo">{s.repo.name}</span>}
        {flying ? (
          <span className="board-meta">{fmtElapsed(now - startedAt)}</span>
        ) : (
          <time className="board-meta" dateTime={new Date(s.updatedAt).toISOString()}>
            {fmtTime(s.updatedAt, timeFormat)}
          </time>
        )}
      </button>
    </li>
  )
}
