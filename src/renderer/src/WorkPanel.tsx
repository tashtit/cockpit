import { Fragment, useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import type { FileEdit, Provider, SessionFilePreview, TodoStatus } from '../../shared/types'
import { shortPath } from '../../shared/library'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { DiffLines, DiffStat } from './InstructionDiff'
import { PROVIDER_LABEL, TodoMark, XIcon } from './logos'
import { Markdown } from './Markdown'
import { TabList, type TabDef } from './Tabs'
import { fmtTime, useTimeFormat } from './time'
import {
  CHECK_LABEL,
  checkSummary,
  followUpSummary,
  type FollowUpEntry,
  sharedSummary,
  type SharedFileEntry,
  fileChange,
  needsLook,
  todoSummary,
  type CheckRun,
  type CheckWork,
  type EditEntry,
  type FileWork,
  type WorkModel,
  type WorkTab
} from '../../shared/work'

/**
 * The Work panel: what the agent handed you to look at, beside the conversation —
 * the plan it proposed, where its to-do list stands, every edit it made, file by
 * file, how the checks it ran ended, the files and pages it shared with you, and the
 * work it suggested for sessions of their own. Built from the agents' own tool calls (`work.ts`), so it is what the agent
 * *said*: the edits are each call's own description of its change, and **Changes**
 * (the worktree's diff, ⌘D) stays the word on what is actually on disk.
 *
 * Opened from the header's Work key or from any row that carries one of these; a row
 * opens the panel at itself — its plan version, or its file with the edit ringed.
 */

/** How long an edit a row opened the panel at stays ringed */
const RING_MS = 2_000
/** Up to this many files open expanded; past it they open on demand */
const OPEN_FILES = 3

const TODO_WORD: Record<TodoStatus, string> = {
  pending: 'not started',
  in_progress: 'in progress',
  completed: 'done',
  blocked: 'blocked'
}

/** A run's state as its word and tone — the word always, so the colour never carries it alone */
function verdict(run: CheckRun | null): { word: string; tone: string } {
  if (run?.status === 'passed') return { word: 'passed', tone: 'tone-ok' }
  if (run?.status === 'failed') return { word: 'failed', tone: 'tone-danger' }
  return { word: 'no result', tone: 'tone-dim' }
}

const CHANGE_WORD: Record<FileEdit['change'], string | null> = {
  add: 'added',
  write: 'written',
  delete: 'deleted',
  edit: null
}

/** A path under the session's directory reads relative to it, like the transcript's rows. */
function relative(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

export type WorkFocus = {
  readonly tab: WorkTab
  /** The transcript row that opened the panel, if one did */
  readonly key: number | null
  /** Bumped on every open, so opening the same row again scrolls to it again */
  readonly at: number
}

export function WorkPanel({
  model,
  focus,
  onTab,
  onClose,
  cwd,
  provider,
  pendingPlanKey,
  onOpenChanges,
  sessionId,
  onOpenUrl,
  onStartFollowUp
}: {
  model: WorkModel
  focus: WorkFocus
  onTab: (tab: WorkTab) => void
  onClose: () => void
  cwd: string
  provider: Provider
  /** The plan row still waiting for the person's approval, if one is */
  pendingPlanKey: number | null
  /** Swap the transcript for the worktree's diff — absent where there is none */
  onOpenChanges?: () => void
  /** The indexed session, which main reads a shared file for; null before it has an id */
  sessionId: string | null
  onOpenUrl: (url: string) => void
  /** Fill in the new-session form with a suggestion; absent where sessions can't start */
  onStartFollowUp?: (followUp: { readonly title: string; readonly prompt: string; readonly cwd?: string }) => void
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  // opening moves the reader in: the selected tab takes focus, so the keyboard is
  // where the eyes went (and Escape is one key away)
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus()
  }, [focus.at])

  // a tab is a fresh page: never entered half-scrolled because the one before was long
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [focus.tab])

  const openTodos = model.todos.filter((t) => t.status !== 'completed').length
  const tabs: readonly TabDef<WorkTab>[] = [
    { id: 'plan', label: 'Plan', dot: pendingPlanKey !== null },
    { id: 'todos', label: 'To-dos', count: openTodos },
    { id: 'edits', label: 'Edits', count: model.files.length },
    // the checks that want a look: failed, or out of date since an edit
    { id: 'checks', label: 'Checks', count: model.checks.filter(needsLook).length },
    { id: 'files', label: 'Files', count: model.shared.files.length + model.shared.links.length },
    { id: 'follow-ups', label: 'Follow-ups', count: model.followUps.filter((f) => !f.dismissed).length }
  ]

  return (
    <aside
      id="work-panel"
      className="work-panel"
      aria-label="Work"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onClose()
      }}
    >
      <div className="work-head" ref={tabsRef}>
        <TabList id="work" label="Work" tabs={tabs} selected={focus.tab} onSelect={onTab} />
        <button className="icon-btn small work-close" aria-label="Close the Work panel" title="Close (Esc)" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div
        className="work-body"
        ref={bodyRef}
        role="tabpanel"
        id={`work-panel-${focus.tab}`}
        aria-labelledby={`work-tab-${focus.tab}`}
        // the panel scrolls on its own: a keyboard reader must be able to reach it
        tabIndex={0}
      >
        {focus.tab === 'plan' ? (
          <PlanTab model={model} focus={focus} pendingPlanKey={pendingPlanKey} provider={provider} />
        ) : focus.tab === 'todos' ? (
          <TodosTab model={model} provider={provider} />
        ) : focus.tab === 'checks' ? (
          <ChecksTab model={model} focus={focus} provider={provider} scroller={bodyRef} />
        ) : focus.tab === 'follow-ups' ? (
          <FollowUpsTab
            model={model}
            focus={focus}
            provider={provider}
            sessionId={sessionId}
            scroller={bodyRef}
            onStart={onStartFollowUp}
          />
        ) : focus.tab === 'files' ? (
          <FilesTab
            model={model}
            focus={focus}
            cwd={cwd}
            provider={provider}
            sessionId={sessionId}
            onOpenUrl={onOpenUrl}
          />
        ) : (
          <EditsTab model={model} focus={focus} cwd={cwd} scroller={bodyRef} onOpenChanges={onOpenChanges} />
        )}
      </div>
    </aside>
  )
}

function PlanTab({
  model,
  focus,
  pendingPlanKey,
  provider
}: {
  model: WorkModel
  focus: WorkFocus
  pendingPlanKey: number | null
  provider: Provider
}): JSX.Element {
  const fmt = useTimeFormat()
  const { plans } = model
  // a row opens its own version of the plan; otherwise the latest is the one that counts
  const [at, setAt] = useState(() => indexFor(plans, focus.key))
  useEffect(() => setAt(indexFor(plans, focus.key)), [focus.at])
  if (plans.length === 0) {
    return (
      <p className="work-empty">
        No plan yet. When {PROVIDER_LABEL[provider]} proposes one in plan mode, it opens here to read before you
        approve it.
      </p>
    )
  }
  const i = Math.min(at ?? plans.length - 1, plans.length - 1)
  const plan = plans[i]!
  const latest = i === plans.length - 1
  return (
    <>
      <div className="work-meta">
        {plans.length > 1 && (
          <span className="work-versions" role="group" aria-label="Plan versions">
            <button className="btn-ghost small" disabled={i === 0} onClick={() => setAt(i - 1)}>
              Earlier
            </button>
            <span className="work-version">
              version {i + 1} of {plans.length}
            </span>
            <button className="btn-ghost small" disabled={latest} onClick={() => setAt(i + 1)}>
              Later
            </button>
          </span>
        )}
        {plan.ts && <span>proposed {fmtTime(plan.ts, fmt)}</span>}
        {plan.key === pendingPlanKey && <span className="work-flag">waiting for your approval</span>}
        {!latest && <span>a newer version follows</span>}
      </div>
      <div className="markdown work-plan">
        <Markdown text={plan.text} />
      </div>
    </>
  )
}

/** The plan a row points at, or null for "the latest". */
function indexFor(plans: WorkModel['plans'], key: number | null): number | null {
  const i = key === null ? -1 : plans.findIndex((p) => p.key === key)
  return i < 0 ? null : i
}

function TodosTab({ model, provider }: { model: WorkModel; provider: Provider }): JSX.Element {
  if (model.todosKey === null) {
    return (
      <p className="work-empty">
        No to-do list yet. When {PROVIDER_LABEL[provider]} breaks its work into steps, they are kept here as it ticks
        them off.
      </p>
    )
  }
  return (
    <>
      <div className="work-meta">
        <span>{todoSummary(model.todos)}</span>
      </div>
      {model.todos.length > 0 && (
        <ol className="work-todos">
          {model.todos.map((t) => (
            <li key={t.id} className={`work-todo ${t.status}`}>
              <span className="work-todo-mark">
                <TodoMark status={t.status} />
              </span>
              <span className="sr-only">{TODO_WORD[t.status]}: </span>
              <span className="work-todo-text">{t.text}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

function EditsTab({
  model,
  focus,
  cwd,
  scroller,
  onOpenChanges
}: {
  model: WorkModel
  focus: WorkFocus
  cwd: string
  scroller: RefObject<HTMLDivElement | null>
  onOpenChanges?: () => void
}): JSX.Element {
  const { files } = model
  const focusFile = focus.key === null ? undefined : files.find((f) => f.edits.some((e) => e.key === focus.key))
  // what the person opened or closed; every other file follows the default — open while
  // there are few enough to read at once, which holds for files that arrive mid-turn too
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(focusFile ? [[focusFile.path, true]] : [])
  )
  const isOpen = (path: string): boolean => toggled.get(path) ?? files.length <= OPEN_FILES
  const [ringed, setRinged] = useState<number | null>(null)

  // a row opened the panel at its edit: open that file, bring the edit into view, ring it
  useEffect(() => {
    if (!focusFile || focus.key === null) return
    setToggled((m) => (m.get(focusFile.path) ? m : new Map([...m, [focusFile.path, true]])))
    setRinged(focus.key)
  }, [focus.at])
  useLayoutEffect(() => {
    if (ringed === null) return
    scroller.current?.querySelector(`[data-work-key="${ringed}"]`)?.scrollIntoView({ block: 'nearest' })
    const t = setTimeout(() => setRinged(null), RING_MS)
    return () => clearTimeout(t)
  }, [ringed])

  if (files.length === 0) {
    return (
      <p className="work-empty">
        No edits yet. Each file the agent changes is listed here, with every change as its call described it.
      </p>
    )
  }
  const landed = files.reduce(
    (sum, f) => ({ added: sum.added + f.added, removed: sum.removed + f.removed }),
    { added: 0, removed: 0 }
  )
  return (
    <>
      <div className="work-meta">
        <span>
          {model.editCount === 1 ? '1 edit' : `${model.editCount} edits`} ·{' '}
          {files.length === 1 ? '1 file' : `${files.length} files`}
        </span>
        <DiffStat added={landed.added} removed={landed.removed} />
      </div>
      <p className="work-note">
        As the agent's calls described each change.
        {onOpenChanges && (
          <>
            {' '}
            <button className="link-btn" onClick={onOpenChanges}>
              Changes
            </button>{' '}
            shows what is on disk.
          </>
        )}
      </p>
      <div className="idiff-list">
        {files.map((f) => (
          <FileBlock
            key={f.path}
            file={f}
            cwd={cwd}
            open={isOpen(f.path)}
            ringed={ringed}
            onToggle={(on) => {
              // a details element reports its first paint too: only a change is a choice
              if (on !== isOpen(f.path)) setToggled((m) => new Map([...m, [f.path, on]]))
            }}
          />
        ))}
      </div>
    </>
  )
}

function FileBlock({
  file,
  cwd,
  open,
  ringed,
  onToggle
}: {
  file: FileWork
  cwd: string
  open: boolean
  ringed: number | null
  onToggle: (open: boolean) => void
}): JSX.Element {
  const shown = relative(file.path, cwd)
  const moved = [...file.edits].reverse().find((e) => e.edit.movedTo)?.edit.movedTo
  const kind = fileChange(file)
  const failed = file.edits.every((e) => e.failed)
  return (
    <details className="idiff review-file work-file" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
      <summary className="idiff-head plain">
        <span className="idiff-path">{moved ? `${shown} → ${relative(moved, cwd)}` : shown}</span>
        {CHANGE_WORD[kind] && (
          <span className={`review-kind ${kind === 'add' ? 'added' : kind === 'delete' ? 'deleted' : ''}`}>
            {CHANGE_WORD[kind]}
          </span>
        )}
        {failed && <span className="review-kind tone-warn">didn't apply</span>}
        {file.edits.length > 1 && <span className="work-count">{file.edits.length} edits</span>}
        <DiffStat added={file.added} removed={file.removed} />
      </summary>
      {open && (
        <div className="idiff-body">
          {file.edits.map((e, i) => (
            <EditBlock key={`${e.key}-${i}`} entry={e} ringed={ringed === e.key} />
          ))}
        </div>
      )}
    </details>
  )
}

/** What to say where a call named a file but carried no lines to draw. */
function noLines(edit: FileEdit): string {
  if (edit.change === 'delete') return 'the file was deleted'
  if (edit.truncated) return 'too large to show here'
  return 'the call named this file but not the lines it changed'
}

function EditBlock({ entry, ringed }: { entry: EditEntry; ringed: boolean }): JSX.Element {
  const fmt = useTimeFormat()
  const { edit } = entry
  return (
    <div className={`work-edit${entry.failed ? ' failed' : ''}${ringed ? ' ringed' : ''}`} data-work-key={entry.key}>
      <div className="idiff-rail">
        {entry.ts ? `${fmtTime(entry.ts, fmt)} · ` : ''}
        {entry.toolName}
        {entry.failed && <span className="work-failed">didn't apply</span>}
      </div>
      {edit.hunks.length === 0 ? (
        <div className="idiff-band">
          <span aria-hidden="true">⋯</span>
          {noLines(edit)}
        </div>
      ) : (
        edit.hunks.map((h, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <div className="idiff-band" aria-hidden="true">
                ⋯
              </div>
            )}
            <DiffLines lines={h} layout="unified" />
          </Fragment>
        ))
      )}
      {edit.truncated && edit.hunks.length > 0 && (
        <div className="idiff-band">
          <span aria-hidden="true">⋯</span>
          the rest of this change is not shown
        </div>
      )}
    </div>
  )
}

function ChecksTab({
  model,
  focus,
  provider,
  scroller
}: {
  model: WorkModel
  focus: WorkFocus
  provider: Provider
  scroller: RefObject<HTMLDivElement | null>
}): JSX.Element {
  const { checks } = model
  const [ringed, setRinged] = useState<number | null>(null)

  // a row opened the panel at its run: bring that run into view and ring it
  useEffect(() => {
    if (focus.key !== null && checks.some((c) => c.runs.some((r) => r.key === focus.key))) setRinged(focus.key)
  }, [focus.at])
  useLayoutEffect(() => {
    if (ringed === null) return
    scroller.current?.querySelector(`[data-work-key="${ringed}"]`)?.scrollIntoView({ block: 'nearest' })
    const t = setTimeout(() => setRinged(null), RING_MS)
    return () => clearTimeout(t)
  }, [ringed])

  if (checks.length === 0) {
    return (
      <p className="work-empty">
        No checks yet. When {PROVIDER_LABEL[provider]} runs its tests, a typecheck, a linter or a build, how each one
        last ended shows here.
      </p>
    )
  }
  return (
    <>
      <div className="work-meta">
        <span>{checkSummary(checks)}</span>
      </div>
      <p className="work-note">
        Read off each command's exit code and what it printed. A check is out of date once the agent edits files after
        it.
      </p>
      <ul className="work-checks">
        {checks.map((c) => (
          <CheckBlock key={c.kind} check={c} ringed={ringed} />
        ))}
      </ul>
    </>
  )
}

function CheckBlock({ check, ringed }: { check: CheckWork; ringed: number | null }): JSX.Element {
  const fmt = useTimeFormat()
  // the run that decides the state, else the newest, which has no verdict yet
  const shown = check.last ?? check.runs[check.runs.length - 1]!
  const state = verdict(check.last)
  const earlier = check.runs.filter((r) => r !== shown).reverse()
  const failedEarlier = earlier.filter((r) => r.status === 'failed').length
  // a row that opened the panel at an earlier run opens the fold; the ring clearing doesn't close it
  const ringsEarlier = earlier.some((r) => r.key === ringed)
  const [runsOpen, setRunsOpen] = useState(ringsEarlier)
  useEffect(() => {
    if (ringsEarlier) setRunsOpen(true)
  }, [ringsEarlier])
  return (
    <li className={`work-check${ringed === shown.key ? ' ringed' : ''}`} data-work-key={shown.key}>
      <div className="work-check-head">
        <span className={`review-kind ${state.tone}`}>{state.word}</span>
        <span className="work-check-name">{CHECK_LABEL[check.kind]}</span>
        {shown.exitCode !== undefined && shown.exitCode !== 0 && (
          <span className="work-check-meta">exit {shown.exitCode}</span>
        )}
        {check.editedSince > 0 && (
          <span className="work-flag">
            {check.editedSince === 1 ? '1 file' : `${check.editedSince} files`} edited since
          </span>
        )}
        {shown.ts && <span className="work-check-meta work-check-time">{fmtTime(shown.ts, fmt)}</span>}
      </div>
      <code className="work-check-cmd" title={shown.command}>
        {shown.command}
      </code>
      {shown.output && <pre className="work-check-out">{shown.output.join('\n')}</pre>}
      {earlier.length > 0 && (
        <details
          className="work-check-runs"
          open={runsOpen}
          onToggle={(e) => {
            // a details element reports its first paint too: only a change is a choice
            if (e.currentTarget.open !== runsOpen) setRunsOpen(e.currentTarget.open)
          }}
        >
          <summary>
            {earlier.length === 1 ? '1 earlier run' : `${earlier.length} earlier runs`}
            {failedEarlier > 0 && ` · ${failedEarlier} failed`}
          </summary>
          <ol className="work-check-list">
            {earlier.map((r, i) => {
              const v = verdict(r)
              return (
                <li
                  key={`${r.key}-${i}`}
                  className={`work-check-run${ringed === r.key ? ' ringed' : ''}`}
                  data-work-key={r.key}
                >
                  {r.ts && <span className="work-check-meta">{fmtTime(r.ts, fmt)}</span>}
                  <span className={`review-kind ${v.tone}`}>{v.word}</span>
                  <code className="work-check-cmd" title={r.command}>
                    {r.command}
                  </code>
                </li>
              )
            })}
          </ol>
        </details>
      )}
    </li>
  )
}

/** "4.2 MB" — a file's size in the words the readout uses */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `localhost:5173/guide` — a page as a person reads its address */
function pageLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function FilesTab({
  model,
  focus,
  cwd,
  provider,
  sessionId,
  onOpenUrl
}: {
  model: WorkModel
  focus: WorkFocus
  cwd: string
  provider: Provider
  sessionId: string | null
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const fmt = useTimeFormat()
  const { files, links } = model.shared
  if (files.length === 0 && links.length === 0) {
    return (
      <p className="work-empty">
        Nothing shared yet. When {PROVIDER_LABEL[provider]} sends you a file — a screenshot, a report — or opens a
        page for you, it is kept here.
      </p>
    )
  }
  // a panel of two groups names each; one group needs no name beyond its tab's
  const grouped = files.length > 0 && links.length > 0
  return (
    <>
      <div className="work-meta">
        <span>{sharedSummary(model.shared)}</span>
      </div>
      {files.length > 0 && (
        <>
          {grouped && <h3 className="ns-label">Sent to you</h3>}
          <ul className="work-shared">
            {files.map((f, i) => (
              <SharedFileBlock
                key={f.path}
                file={f}
                cwd={cwd}
                sessionId={sessionId}
                // few enough to look at at once open by default, as edits do; a row opens its own
                open={files.length <= 3 || (i === 0 && focus.key === null) || f.key === focus.key}
                focusAt={f.key === focus.key ? focus.at : null}
                captioned={files[i - 1]?.key !== f.key}
              />
            ))}
          </ul>
        </>
      )}
      {links.length > 0 && (
        <>
          {grouped && <h3 className="ns-label">Pages it opened</h3>}
          <ul className="work-links">
            {links.map((l) => (
              <li key={l.url} className="work-link">
                <button className="link-btn" title={l.url} onClick={() => onOpenUrl(l.url)}>
                  {l.title ?? pageLabel(l.url)}
                </button>
                {l.title && <span className="work-check-meta work-link-url">{pageLabel(l.url)}</span>}
                {l.ts && <span className="work-check-meta work-check-time">{fmtTime(l.ts, fmt)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function SharedFileBlock({
  file,
  cwd,
  sessionId,
  open: openByDefault,
  focusAt,
  captioned
}: {
  file: SharedFileEntry
  cwd: string
  sessionId: string | null
  open: boolean
  /** The first of its call's files: the call's caption is said once */
  captioned: boolean
  /** Set when a row opened the panel at this file: open it, bring it into view, ring it */
  focusAt: number | null
}): JSX.Element {
  const fmt = useTimeFormat()
  const [open, setOpen] = useState(openByDefault)
  const [preview, setPreview] = useState<SessionFilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ringed, setRinged] = useState(false)
  const ref = useRef<HTMLLIElement>(null)
  const name = file.path.split('/').pop() ?? file.path
  // where it is, as a person reads a path: under the session's directory relative to it,
  // anywhere else with the home folded to ~
  const parent = file.path.slice(0, file.path.length - name.length - 1) || '/'
  const dir = parent === cwd ? '.' : parent.startsWith(`${cwd}/`) ? relative(parent, cwd) : shortPath(parent)

  useEffect(() => {
    if (focusAt === null) return
    setOpen(true)
    setRinged(true)
    ref.current?.scrollIntoView({ block: 'nearest' })
    const t = setTimeout(() => setRinged(false), RING_MS)
    return () => clearTimeout(t)
  }, [focusAt])

  // read on opening, and again when the agent hands the same path over anew
  useEffect(() => {
    if (!open || !sessionId) return
    let live = true
    api
      .readSessionFile(sessionId, file.path)
      .then((p) => live && setPreview(p))
      .catch((err: unknown) => live && setError(ipcErrorText(err)))
    return () => {
      live = false
    }
  }, [open, sessionId, file.path, file.key])

  const act = (how: 'open' | 'reveal'): void => {
    if (!sessionId) return
    setError(null)
    api
      .openSessionFile(sessionId, file.path, how)
      .then((failure) => setError(failure))
      .catch((err: unknown) => setError(ipcErrorText(err)))
  }
  const missing = preview?.kind === 'missing'

  return (
    <li ref={ref} className={`work-shared-file${ringed ? ' ringed' : ''}`} data-work-key={file.key}>
      <details
        className="idiff review-file work-file"
        open={open}
        onToggle={(e) => {
          // a details element reports its first paint too: only a change is a choice
          if (e.currentTarget.open !== open) setOpen(e.currentTarget.open)
        }}
      >
        <summary className="idiff-head plain">
          <span className="idiff-path" title={file.path}>
            {name}
          </span>
          {missing && <span className="review-kind tone-dim">gone</span>}
          {preview && preview.kind !== 'missing' && <span className="work-count">{fileSize(preview.size)}</span>}
          {file.ts && <span className="work-count">{fmtTime(file.ts, fmt)}</span>}
        </summary>
        {open && (
          <div className="work-shared-body">
            <div className="work-shared-where">
              <span className="work-check-meta work-shared-dir" title={file.path}>
                {dir}
              </span>
              <span className="work-check-meta">· {file.toolName}</span>
            </div>
            {captioned && file.caption && <p className="work-note">{file.caption}</p>}
            <FilePreview preview={preview} name={name} waiting={!!sessionId && preview === null && !error} />
            {error && (
              <p className="review-error" role="alert">
                {error}
              </p>
            )}
            {sessionId && preview && !missing && (
              <div className="work-shared-actions">
                {preview.openable && (
                  <button className="btn-ghost small" onClick={() => act('open')}>
                    Open
                  </button>
                )}
                <button className="btn-ghost small" onClick={() => act('reveal')}>
                  Show in Finder
                </button>
              </div>
            )}
          </div>
        )}
      </details>
    </li>
  )
}

/** A shared file drawn in the panel: the image itself, the head of the text, or why not. */
function FilePreview({
  preview,
  name,
  waiting
}: {
  preview: SessionFilePreview | null
  name: string
  waiting: boolean
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  // the renderer may load blob: images, never file: — main sends the bytes
  useEffect(() => {
    if (preview?.kind !== 'image' || typeof URL.createObjectURL !== 'function') return
    const u = URL.createObjectURL(new Blob([preview.data as BlobPart], { type: preview.mime }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [preview])

  if (waiting) return <p className="work-note">Reading the file…</p>
  if (!preview) return null
  switch (preview.kind) {
    case 'missing':
      return <p className="work-note">The file is no longer on disk. Agents often share files from a temporary folder.</p>
    case 'image':
      return url ? <img className="work-shared-image" src={url} alt={name} /> : null
    case 'text':
      return (
        <>
          {preview.markdown ? (
            <div className="markdown work-shared-md">
              <Markdown text={preview.text} />
            </div>
          ) : (
            <pre className="work-check-out work-shared-text">{preview.text}</pre>
          )}
          {preview.truncated && <p className="work-note">The rest of the file is not shown here.</p>}
        </>
      )
    case 'other':
      return (
        <p className="work-note">
          {preview.reason === 'size' ? 'Too large to preview here.' : 'No preview for this kind of file.'}
        </p>
      )
  }
}

/** Where the person started a suggestion, per machine: a convenience, so a lost one only
 *  offers Start again */
const STARTED_KEY = 'cockpit:follow-ups-started'

function startedAt(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(STARTED_KEY) ?? '{}')
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function markStarted(id: string): void {
  try {
    window.localStorage.setItem(STARTED_KEY, JSON.stringify({ ...startedAt(), [id]: Date.now() }))
  } catch {
    /* a private window or full storage: the mark is only a convenience */
  }
}

function FollowUpsTab({
  model,
  focus,
  provider,
  sessionId,
  scroller,
  onStart
}: {
  model: WorkModel
  focus: WorkFocus
  provider: Provider
  sessionId: string | null
  scroller: RefObject<HTMLDivElement | null>
  onStart?: (followUp: { readonly title: string; readonly prompt: string; readonly cwd?: string }) => void
}): JSX.Element {
  const fmt = useTimeFormat()
  const { followUps } = model
  const [started, setStarted] = useState(startedAt)
  const [ringed, setRinged] = useState<number | null>(null)
  useEffect(() => {
    if (focus.key !== null && followUps.some((f) => f.key === focus.key)) setRinged(focus.key)
  }, [focus.at])
  useLayoutEffect(() => {
    if (ringed === null) return
    scroller.current?.querySelector(`[data-work-key="${ringed}"]`)?.scrollIntoView({ block: 'nearest' })
    const t = setTimeout(() => setRinged(null), RING_MS)
    return () => clearTimeout(t)
  }, [ringed])

  if (followUps.length === 0) {
    return (
      <p className="work-empty">
        No follow-ups yet. When {PROVIDER_LABEL[provider]} spots work outside this task, it suggests it here as a
        session of its own.
      </p>
    )
  }
  const idOf = (f: FollowUpEntry): string => `${sessionId ?? ''}:${f.taskId ?? `row-${f.key}`}`
  return (
    <>
      <div className="work-meta">
        <span>{followUpSummary(followUps)}</span>
      </div>
      <p className="work-note">
        Work the agent spotted outside this task. Starting one fills in a new session with its prompt, with any agent.
      </p>
      <ul className="work-follows">
        {followUps.map((f) => {
          const at = started[idOf(f)]
          return (
            <li
              key={f.key}
              className={`work-follow${f.dismissed ? ' dismissed' : ''}${ringed === f.key ? ' ringed' : ''}`}
              data-work-key={f.key}
            >
              <div className="work-follow-head">
                <span className="work-follow-title">{f.title}</span>
                {f.dismissed && <span className="review-kind tone-dim">withdrawn</span>}
                {f.ts && <span className="work-check-meta">{fmtTime(f.ts, fmt)}</span>}
              </div>
              {f.summary && <p className="work-note">{f.summary}</p>}
              {f.dismissed && f.dismissed !== 'withdrawn' && <p className="work-note">Withdrawn: {f.dismissed}</p>}
              {f.cwd && (
                <span className="work-check-meta" title={f.cwd}>
                  in {shortPath(f.cwd)}
                </span>
              )}
              <details className="work-follow-prompt">
                <summary>the prompt it starts with</summary>
                <pre className="work-check-out">{f.prompt}</pre>
              </details>
              {!f.dismissed && onStart && (
                <div className="work-follow-actions">
                  <button
                    className="btn-ghost small"
                    onClick={() => {
                      markStarted(idOf(f))
                      setStarted(startedAt())
                      onStart({ title: f.title, prompt: f.prompt, ...(f.cwd ? { cwd: f.cwd } : {}) })
                    }}
                  >
                    {at ? 'Start another session…' : 'Start a session…'}
                  </button>
                  {at && <span className="work-check-meta">started {fmtTime(at, fmt)}</span>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
