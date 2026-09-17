import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  AttentionItem,
  AttentionReason,
  PermissionMode,
  Provider,
  RepoGroup,
  RoundtableMeta,
  SessionMeta
} from '../../shared/types'
import { api } from './api'
import { AttachRow, useImageAttachments, type ImageAttachment } from './attachments'
import { useBusyMap } from './busy'
import { useAttentionItems } from './attention'
import { accountOptions, MODES, savedAccount, type StartSessionRequest } from './NewSession'
import {
  BranchChip,
  CheckIcon,
  LiveDot,
  NEED_LABEL,
  NeedMark,
  PrMark,
  ProviderLogo,
  PROVIDER_LABEL,
  RepoIcon
} from './logos'
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
  indexed,
  indexVersion,
  busy,
  onStart,
  onOpenSession,
  onOpenFull,
  onNewRoundtable,
  onOpenRoundtable,
  onOpenSettings,
  onOpenUrl
}: {
  repos: RepoGroup[]
  /** The index has finished its first scan, so an empty `repos` means none */
  indexed: boolean
  indexVersion: number
  busy: boolean
  onStart: (req: StartSessionRequest) => Promise<string | null>
  onOpenSession: (s: SessionMeta) => void
  /** Open the full New session form (branch, model, custom provider), keeping the draft */
  onOpenFull: (repo: RepoGroup, draft: string, images?: readonly ImageAttachment[]) => void
  onNewRoundtable: () => void
  onOpenRoundtable: (id: string) => void
  /** First run sends people to Settings for the step that is missing */
  onOpenSettings: () => void
  /** A red PR with no session of its own opens on GitHub */
  onOpenUrl: (url: string) => void
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

  // Three states, and the first two only on evidence. The composer shows the moment
  // there is an account and a repo to run in; setup only once accounts have loaded and
  // the first scan has finished and one of them is still missing. Until either is
  // known the slot stays empty — a composer swapped for setup (a first run) or setup
  // swapped for a composer (a cold index) is a flash either way.
  const canStart = (accounts?.accounts.length ?? 0) > 0 && selectable.length > 0
  const needsSetup = !canStart && accounts !== null && indexed

  // focus lands in the composer when it first appears, not when the view mounts
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!canStart || focusedRef.current) return
    focusedRef.current = true
    promptRef.current?.focus()
  }, [canStart])

  // the fleet: sessions and roundtables on one board, placed by what is happening.
  // What needs you renders whole from main's list — a session waiting on you is on the
  // board even when it is not among the ten most recent rows
  const busyMap = useBusyMap()
  const needs = useAttentionItems()
  const fleetLeads =
    needs.length > 0 || recent.some((s) => busyMap.has(s.id)) || tables.some((t) => t.running)
  const fleet = (recent.length + tables.length > 0 || needs.length > 0) && (
    <Board
      sessions={recent}
      total={recentTotal}
      tables={tables}
      needs={needs}
      onOpen={onOpenSession}
      onOpenRoundtable={onOpenRoundtable}
      onOpenUrl={onOpenUrl}
    />
  )

  return (
    <main className="chat home-view">
      <div className="home-inner">
        {/* mission control leads with whatever is true right now: while the fleet is
            up (or something landed unseen) the board opens the view; when everything
            is quiet the composer does, and the board reads as recent activity below */}
        {fleetLeads && fleet}
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
            {canStart ? (
              <>Assign a task to an agent — it runs in an isolated worktree and lands as a PR.</>
            ) : needsSetup ? (
              <>Cockpit reads the sessions your agent CLIs already write. Three things and you fly.</>
            ) : null}
            <span className="home-kbd">⌘N new task · ⌘K jump anywhere</span>
          </p>
        </div>

        {needsSetup ? (
          <Setup
            signedIn={(accounts?.accounts.length ?? 0) > 0}
            indexed={selectable.length > 0}
            githubUser={accounts?.githubUser ?? null}
            onOpenSettings={onOpenSettings}
          />
        ) : canStart ? (
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
        ) : null}
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
        {!fleetLeads && fleet}
      </div>
    </main>
  )
}

/**
 * First run: an empty tree, "no repositories indexed yet" and a Start button that
 * is disabled without saying why is an accurate screen that helps nobody. This is
 * the same card shape, holding the three things Cockpit needs — and what to do
 * about each. Steps already satisfied stay, ticked: progress is the point.
 */
function Setup({
  signedIn,
  indexed,
  githubUser,
  onOpenSettings
}: {
  signedIn: boolean
  indexed: boolean
  githubUser: string | null
  onOpenSettings: () => void
}): JSX.Element {
  const steps = [
    {
      done: signedIn,
      title: 'Sign in to an agent',
      note: (
        <>
          Run <code>claude</code>, <code>codex</code> or <code>copilot</code> once in a terminal and
          sign in. Cockpit never asks for credentials — it reads each CLI&apos;s own config home.
        </>
      ),
      action: null
    },
    {
      done: indexed,
      title: 'Point Cockpit at your work',
      note: signedIn ? (
        <>
          Nothing indexed in <code>~/.claude</code>, <code>~/.codex</code> or{' '}
          <code>~/.copilot</code> yet. Start a session in any git repository, or add the config home
          yours lives in.
        </>
      ) : (
        <>
          Cockpit watches <code>~/.claude</code>, <code>~/.codex</code> and <code>~/.copilot</code>{' '}
          by default; add another config home if yours lives elsewhere.
        </>
      ),
      action: { label: 'Add a config home', onClick: onOpenSettings }
    },
    {
      done: !!githubUser,
      title: githubUser ? `Pull requests as @${githubUser}` : 'Connect GitHub for pull requests',
      note: githubUser ? (
        <>Branches push and PRs open as this user.</>
      ) : (
        <>
          Run <code>gh auth login</code> so finished work can ship as a PR. Sessions run fine
          without it.
        </>
      ),
      action: null
    }
  ]

  return (
    <section className="composer-card setup-card" aria-label="Set up Cockpit">
      <ol className="setup-steps">
        {steps.map((s) => (
          <li key={s.title} className={`setup-step ${s.done ? 'done' : ''}`}>
            <span className={`setup-mark ${s.done ? 'done' : ''}`} aria-hidden="true">
              {s.done ? <CheckIcon size={12} /> : <span className="setup-dot" />}
            </span>
            <div className="setup-body">
              <div className="setup-title">
                {s.title}
                {s.done && <span className="sr-only"> — done</span>}
              </div>
              {!s.done && <div className="setup-note">{s.note}</div>}
            </div>
            {!s.done && s.action && (
              <button className="btn-ghost small" onClick={s.action.onClick}>
                {s.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * The board — the home view's opening move and the app's signature element:
 * a departure-board of sessions. What needs you comes first, as its own group; then
 * what is flying — livery-colored pulse + placard agent label + branch + elapsed
 * time; idle sessions keep their timestamp on the ground. Replaces the old "Recent
 * activity" list (the sidebar remains the exhaustive one).
 */
function Board({
  sessions,
  total,
  tables,
  needs,
  onOpen,
  onOpenRoundtable,
  onOpenUrl
}: {
  sessions: SessionMeta[]
  total: number
  /** Roundtables are rows on the same board — a table is work in flight like a session */
  tables: RoundtableMeta[]
  /** Main's list of what waits on the user, newest first */
  needs: readonly AttentionItem[]
  onOpen: (s: SessionMeta) => void
  onOpenRoundtable: (id: string) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const busy = useBusyMap()
  // the elapsed column ticks only while something is actually flying
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (busy.size === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy.size])

  // one board, three states: needs you (whole, newest first — a session on that list
  // stays there even while its turn is live, because it is waiting on you), flying
  // (longest airborne first, then any table mid-round), then the ground — sessions
  // and tables by recency
  const needSessions = new Set(needs.flatMap((it) => (it.kind === 'session' ? [it.id] : [])))
  const needTables = new Set(needs.flatMap((it) => (it.kind === 'roundtable' ? [it.id] : [])))
  const flyingSessions = sessions
    .filter((s) => busy.has(s.id) && !needSessions.has(s.id))
    .sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))
  const flyingTables = tables
    .filter((t) => t.running && !needTables.has(t.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const ground: Array<{ kind: 'session'; s: SessionMeta } | { kind: 'table'; t: RoundtableMeta }> = [
    ...sessions
      .filter((s) => !busy.has(s.id) && !needSessions.has(s.id))
      .map((s) => ({ kind: 'session' as const, s })),
    ...tables.filter((t) => !t.running && !needTables.has(t.id)).map((t) => ({ kind: 'table' as const, t }))
  ].sort((a, b) => (b.kind === 'session' ? b.s.updatedAt : b.t.updatedAt) - (a.kind === 'session' ? a.s.updatedAt : a.t.updatedAt))
  const flyingCount = flyingSessions.length + flyingTables.length
  // the board is a taste, not the list: what needs you and what is happening always
  // show, the ground fills what is left of ten rows (the sidebar stays the exhaustive one)
  const shownGround = ground.slice(0, Math.max(0, BOARD_ROWS - needs.length - flyingCount))
  const onPage = sessions.filter((s) => needSessions.has(s.id)).length
  const tablesUp = flyingTables.length + tables.filter((t) => needTables.has(t.id)).length
  const groundTotal = Math.max(
    total - flyingSessions.length - onPage + (tables.length - tablesUp),
    ground.length
  )

  return (
    <section className="board" aria-label="Session board">
      <div className="board-head">
        {/* h2, not h3: the board renders above the hero's h2, and a heading that
            outranks nothing above it would read as a skipped level.
            Polite live region — turn starts/completions announce the new counts */}
        <h2 className="board-eyebrow" aria-live="polite">
          {flyingCount === 0 && needs.length === 0 ? (
            <>all on the ground</>
          ) : (
            <>
              {needs.length > 0 && (
                <b>
                  {needs.length} need{needs.length === 1 ? 's' : ''} you
                </b>
              )}
              {needs.length > 0 && flyingCount > 0 && ' · '}
              {flyingCount > 0 && <b>{flyingCount} flying</b>}
              {' · '}
              {groundTotal} on the ground
            </>
          )}
        </h2>
      </div>
      {needs.length > 0 && (
        <>
          <h3 className="board-group-label">needs you</h3>
          <ul className="board-list board-needs" aria-label="Needs you">
            {needs.map((it) => (
              <NeedRow
                key={it.key}
                it={it}
                tables={tables}
                onOpen={onOpen}
                onOpenRoundtable={onOpenRoundtable}
                onOpenUrl={onOpenUrl}
              />
            ))}
          </ul>
        </>
      )}
      <ul className="board-list">
        {flyingSessions.map((s) => (
          <BoardRow key={s.id} s={s} startedAt={busy.get(s.id)} now={now} onOpen={onOpen} />
        ))}
        {flyingTables.map((t) => (
          <TableRow key={t.id} t={t} onOpen={onOpenRoundtable} />
        ))}
        {shownGround.map((g) =>
          g.kind === 'session' ? (
            <BoardRow key={g.s.id} s={g.s} startedAt={undefined} now={now} onOpen={onOpen} />
          ) : (
            <TableRow key={g.t.id} t={g.t} onOpen={onOpenRoundtable} />
          )
        )}
      </ul>
    </section>
  )
}

/** The meta slot's word for each reason — what carries the state, so colour never does alone. */
const NEED_WORD: Record<AttentionReason, string> = {
  landed: 'landed',
  failed: 'failed',
  question: 'asking',
  permission: 'needs approval',
  checks: 'checks failing',
  review: 'changes requested'
}

/**
 * One row of the needs-you group, in the board's grammar. A session row opens the
 * session; a PR row opens the session on its branch, or the PR itself when no
 * session claims the branch; a table row opens the table. The mark in the dot slot
 * and the word in the meta slot both say why — a landed row keeps the solid livery
 * dot and "landed <time>" it always had, an ending's detail rides in the title.
 */
function NeedRow({
  it,
  tables,
  onOpen,
  onOpenRoundtable,
  onOpenUrl
}: {
  it: AttentionItem
  tables: RoundtableMeta[]
  onOpen: (s: SessionMeta) => void
  onOpenRoundtable: (id: string) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const timeFormat = useTimeFormat()
  const when = fmtTime(it.at, timeFormat)
  const openSession = (id: string): void => {
    void api.getSession(id).then((s) => s && onOpen(s))
  }
  if (it.kind === 'session') {
    const landed = it.reason === 'landed'
    const ended = landed || it.reason === 'failed'
    return (
      <li>
        <button
          className={`board-row needs needs-${it.reason} ${landed ? 'landed' : ''}`}
          title={`${PROVIDER_LABEL[it.provider]} — ${it.title}${it.branch ? `\n⎇ ${it.branch}` : ''}\n${
            NEED_LABEL[it.reason]
          }${it.detail ? `: ${it.detail}` : ''}`}
          onClick={() => openSession(it.id)}
        >
          {landed ? (
            // solid, unpulsing, in the agent's livery: arrived, not working
            <span className={`board-dot-landed plogo-${it.provider}`} aria-hidden="true" />
          ) : (
            <NeedMark reason={it.reason} />
          )}
          <span className={`board-agent board-lead board-agent-${it.provider}`}>
            {PROVIDER_LABEL[it.provider]}
          </span>
          <span className="board-branch">{it.branch && <BranchChip branch={it.branch} />}</span>
          <span className="board-task">
            {it.title}
            {it.detail && <span className="board-detail"> — {it.detail}</span>}
          </span>
          {it.repo && <span className="board-repo">{it.repo}</span>}
          <span className="board-meta board-meta-needs">
            {NEED_WORD[it.reason]}
            {ended ? ` ${when}` : ''}
          </span>
        </button>
      </li>
    )
  }
  if (it.kind === 'roundtable') {
    const t = tables.find((x) => x.id === it.id)
    const failed = it.reason === 'failed'
    return (
      <li>
        <button
          className={`board-row board-row-table needs needs-${it.reason} ${failed ? '' : 'landed'}`}
          title={`Roundtable — ${it.title}\n${failed ? 'failed' : 'concluded'}${it.detail ? `: ${it.detail}` : ''}`}
          onClick={() => onOpenRoundtable(it.id)}
        >
          {failed ? <NeedMark reason="failed" /> : <span className="board-dot-landed" aria-hidden="true" />}
          {t ? (
            <span className="rt-seats board-lead" role="img" aria-label={`Roundtable: ${t.providers.map((p) => PROVIDER_LABEL[p]).join(', ')}`}>
              {t.providers.map((p, i) => (
                <span key={`${p}-${i}`} className={`rt-seat plogo-${p}`}>
                  <ProviderLogo p={p} size={12} />
                </span>
              ))}
            </span>
          ) : (
            <span className="board-agent board-lead">Table</span>
          )}
          <span className="board-branch">{t?.branch && <BranchChip branch={t.branch} />}</span>
          <span className="board-task">
            {it.title}
            {it.detail && <span className="board-detail"> — {it.detail}</span>}
          </span>
          <span className="board-meta board-meta-needs">
            {failed ? 'failed' : 'concluded'} {when}
          </span>
        </button>
      </li>
    )
  }
  const { pr } = it
  return (
    <li>
      <button
        className={`board-row needs needs-${it.reason}`}
        title={`${NEED_LABEL[it.reason]} — #${pr.number} ${pr.title}\n⎇ ${pr.headRefName}\n${
          it.sessionId ? 'opens the session on this branch' : 'opens the pull request on GitHub'
        }`}
        onClick={() => (it.sessionId ? openSession(it.sessionId) : onOpenUrl(pr.url))}
      >
        <NeedMark reason={it.reason} />
        <span className="board-lead">
          <PrMark pr={pr} />
          <span className="sr-only">pull request #{pr.number}</span>
        </span>
        <span className="board-branch">{pr.headRefName && <BranchChip branch={pr.headRefName} />}</span>
        <span className="board-task">{pr.title}</span>
        <span className="board-repo">{it.repo}</span>
        <span className="board-meta board-meta-needs">{NEED_WORD[it.reason]}</span>
      </button>
    </li>
  )
}

/** Rows the board shows when nothing is happening — the page fetch's own size. */
const BOARD_ROWS = 10

/**
 * A roundtable on the board: the seat cluster in the lead column, where a session has
 * its agent's placard. A running round pulses accent — no single agent owns a
 * multi-agent table — and "in round" holds the meta slot the way elapsed time does.
 */
function TableRow({ t, onOpen }: { t: RoundtableMeta; onOpen: (id: string) => void }): JSX.Element {
  const timeFormat = useTimeFormat()
  return (
    <li>
      <button
        className={`board-row board-row-table ${t.running ? 'flying' : ''}`}
        title={`Roundtable · ${t.providers.map((p) => PROVIDER_LABEL[p]).join(' + ')} — ${t.title}`}
        onClick={() => onOpen(t.id)}
      >
        {t.running ? (
          <span className="pulse" role="img" aria-label="round in progress" />
        ) : (
          <span className="board-dot-idle" aria-hidden="true" />
        )}
        <span className="rt-seats board-lead" role="img" aria-label={`Roundtable: ${t.providers.map((p) => PROVIDER_LABEL[p]).join(', ')}`}>
          {t.providers.map((p, i) => (
            <span key={`${p}-${i}`} className={`rt-seat plogo-${p}`}>
              <ProviderLogo p={p} size={12} />
            </span>
          ))}
        </span>
        <span className="board-branch">{t.branch && <BranchChip branch={t.branch} />}</span>
        <span className="board-task">{t.title}</span>
        {t.running ? (
          <span className="board-meta">in round</span>
        ) : (
          <time className="board-meta" dateTime={new Date(t.updatedAt).toISOString()}>
            {fmtTime(t.updatedAt, timeFormat)}
          </time>
        )}
      </button>
    </li>
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
        {flying ? <LiveDot p={s.provider} /> : <span className="board-dot-idle" aria-hidden="true" />}
        <span className={`board-agent board-lead board-agent-${s.provider}`}>
          {PROVIDER_LABEL[s.provider]}
        </span>
        {/* the slot renders even without a branch, so every task starts on one grid line */}
        <span className="board-branch">{s.gitBranch && <BranchChip branch={s.gitBranch} />}</span>
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
