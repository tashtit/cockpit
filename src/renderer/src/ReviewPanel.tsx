import { useEffect, useState, type JSX } from 'react'
import type { DiffFile, DiffHunk, DiffHunkLine, DiffScope, Provider, WorkspaceDiff } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './attachments'
import { useDiffLayout, type DiffLayout } from './diff-layout'
import { DiffLayoutToggle, DiffStat } from './InstructionDiff'
import { PROVIDER_LABEL } from './logos'

/**
 * Review before landing: the worktree's changes, in the transcript's place, read
 * the way a PR reads — file by file, GitHub's line grammar, both line numbers.
 * Notes pinned to lines go back to the agent through the composer, so the
 * reviewer's words and the agent's next turn share one conversation.
 */

export const SCOPES: ReadonlyArray<{ readonly v: DiffScope; readonly label: string; readonly hint: string }> = [
  { v: 'branch', label: 'Branch', hint: 'Everything since the base branch — what a PR would carry' },
  { v: 'staged', label: 'Staged', hint: 'What is in the index, ready to commit' },
  { v: 'unstaged', label: 'Unstaged', hint: 'Working-tree edits not staged yet, plus untracked files' }
]

const KIND_LABEL: Record<DiffFile['status'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed'
}

const GUTTER: Record<DiffHunkLine['op'], string> = { same: ' ', add: '+', del: '−' }
const SAID: Record<DiffHunkLine['op'], string> = { same: '', add: 'added: ', del: 'removed: ' }

export type ReviewNote = {
  readonly path: string
  readonly line: DiffHunkLine
  readonly text: string
}

/** A removed line is addressed on the old side, everything else on the new. */
export function noteKey(path: string, line: DiffHunkLine): string {
  return line.op === 'del' ? `${path}#L${line.oldNo}` : `${path}#R${line.newNo}`
}

/** The notes as one message: where, what is there, what the reviewer wants. */
export function formatNotes(
  notes: readonly ReviewNote[],
  diff: Pick<WorkspaceDiff, 'branch' | 'base'>
): string {
  const where = diff.branch ? ` on ${diff.branch}${diff.base ? ` (vs ${diff.base})` : ''}` : ''
  const out = [`Review notes on the changes in this worktree${where}:`, '']
  notes.forEach((n, i) => {
    const no = n.line.op === 'del' ? `${n.line.oldNo} (removed line)` : String(n.line.newNo)
    out.push(`${i + 1}. ${n.path}:${no}`)
    out.push(`   > ${n.line.text}`)
    out.push(`   ${n.text.trim().split('\n').join('\n   ')}`)
    out.push('')
  })
  return out.join('\n').trimEnd()
}

export function ReviewPanel({
  cwd,
  provider,
  busy,
  onNotes
}: {
  cwd: string
  provider: Provider
  /** A turn is running: the tree is changing under the reader — reload when it settles */
  busy: boolean
  /** Hands the composed notes to the composer; absent when the session takes no input */
  onNotes?: (text: string) => void
}): JSX.Element {
  const [scope, setScope] = useState<DiffScope>('branch')
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const [notes, setNotes] = useState<ReadonlyMap<string, ReviewNote>>(new Map())
  const [editing, setEditing] = useState<string | null>(null)
  const layout = useDiffLayout()
  const agent = PROVIDER_LABEL[provider]

  useEffect(() => {
    if (busy) return
    let dead = false
    setLoading(true)
    api.getWorkspaceDiff(cwd, scope).then(
      (d) => {
        if (dead) return
        setDiff(d)
        setError(null)
        setLoading(false)
      },
      (err) => {
        if (dead) return
        setError(ipcErrorText(err))
        setLoading(false)
      }
    )
    return () => {
      dead = true
    }
  }, [cwd, scope, busy, version])

  // notes belong to the worktree they were written on
  useEffect(() => {
    setNotes(new Map())
    setEditing(null)
  }, [cwd])

  const keep = (note: ReviewNote): void => {
    setNotes(new Map(notes).set(noteKey(note.path, note.line), note))
    setEditing(null)
  }
  const drop = (key: string): void => {
    const next = new Map(notes)
    next.delete(key)
    setNotes(next)
  }
  const send = (): void => {
    if (!onNotes || !diff || notes.size === 0) return
    onNotes(formatNotes([...notes.values()], diff))
    setNotes(new Map())
  }

  const scopeWord = scope === 'branch' ? 'on this branch' : scope
  return (
    <section className="review" aria-label="Changes to review">
      <div className="review-bar">
        <span className="idiff-layout" role="group" aria-label="Diff scope">
          {SCOPES.map((s) => (
            <button
              key={s.v}
              className={scope === s.v ? 'active' : ''}
              aria-pressed={scope === s.v}
              title={s.hint}
              onClick={() => setScope(s.v)}
            >
              {s.label}
            </button>
          ))}
        </span>
        <span className="review-sum">
          {diff && <Summary diff={diff} />}
          {loading && (
            <span className="review-loading">
              <span className="pulse" /> reading changes…
            </span>
          )}
        </span>
        <span className="review-right">
          {onNotes && notes.size > 0 && (
            <button className="btn-ghost small" onClick={send} title="Put the notes in the composer, ready to send">
              Send {notes.size} {notes.size === 1 ? 'note' : 'notes'} to {agent}
            </button>
          )}
          <button
            className="icon-btn small"
            aria-label="Refresh changes"
            title="Refresh"
            disabled={loading}
            onClick={() => setVersion((v) => v + 1)}
          >
            <span aria-hidden="true">↻︎</span>
          </button>
          <DiffLayoutToggle />
        </span>
      </div>
      {error && (
        <div className="review-error" role="alert">
          {error}
        </div>
      )}
      {diff && !error && diff.files.length === 0 && !loading && (
        <div className="empty-chat small">
          No changes {scopeWord} — {agent} hasn't touched anything here yet.
        </div>
      )}
      {diff && diff.files.length > 0 && (
        <div className="idiff-list">
          {diff.files.map((f) => (
            <FileBlock
              key={f.path}
              file={f}
              layout={layout}
              notes={notes}
              editing={editing}
              onEdit={onNotes ? setEditing : undefined}
              onKeep={keep}
              onDrop={drop}
            />
          ))}
        </div>
      )}
      {diff && diff.droppedFiles > 0 && (
        <div className="idiff-band">
          <span aria-hidden="true">⋯</span>
          {diff.droppedFiles} more {diff.droppedFiles === 1 ? 'file' : 'files'} not shown
        </div>
      )}
    </section>
  )
}

function Summary({ diff }: { diff: WorkspaceDiff }): JSX.Element {
  const n = diff.files.length
  return (
    <>
      <DiffStat added={diff.added} removed={diff.removed} />
      <span>
        {n} {n === 1 ? 'file' : 'files'}
      </span>
      {diff.scope === 'branch' && diff.base && (
        <span title={`Commits on ${diff.branch ?? 'this branch'} the base doesn't have, and the other way round`}>
          {diff.ahead} ahead, {diff.behind} behind {diff.base}
        </span>
      )}
      {diff.scope === 'branch' && !diff.base && <span>no base branch found — comparing against HEAD</span>}
      {diff.dirty && (
        <span className="review-dirty" title="Create PR needs a clean worktree — ask the agent to commit first">
          uncommitted changes
        </span>
      )}
    </>
  )
}

type LineProps = {
  readonly file: DiffFile
  readonly notes: ReadonlyMap<string, ReviewNote>
  readonly editing: string | null
  readonly onEdit?: (key: string | null) => void
  readonly onKeep: (note: ReviewNote) => void
  readonly onDrop: (key: string) => void
}

function FileBlock({ file, layout, ...line }: LineProps & { layout: DiffLayout }): JSX.Element {
  const shown = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
  const kind = file.untracked ? 'untracked' : file.status
  return (
    <details className="idiff review-file" open={!file.binary}>
      <summary className="idiff-head plain" aria-label={`${shown}, ${kind}`}>
        <span className="idiff-path">{shown}</span>
        {(kind !== 'modified' || file.binary) && (
          <span className={`review-kind ${kind}`}>{file.binary ? 'binary' : file.untracked ? 'untracked' : KIND_LABEL[file.status]}</span>
        )}
        {!file.binary && <DiffStat added={file.added} removed={file.removed} />}
      </summary>
      {!file.binary && (
        <div className="idiff-body">
          {file.hunks.map((h, i) => (
            <Hunk key={i} hunk={h} layout={layout} file={file} {...line} />
          ))}
          {file.truncated && (
            <div className="idiff-band">
              <span aria-hidden="true">⋯</span>
              the rest of this file's changes are not shown — {file.added + file.removed} lines changed in all
            </div>
          )}
        </div>
      )}
    </details>
  )
}

function Hunk({ hunk, layout, ...line }: LineProps & { hunk: DiffHunk; layout: DiffLayout }): JSX.Element {
  const range = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
  return (
    <>
      <div className="idiff-rail review-hunk">
        {range}
        {hunk.header && ` ${hunk.header}`}
      </div>
      {layout === 'split'
        ? pairLines(hunk.lines).map(([l, r], k) => (
            <PairRow key={k} left={l} right={r} {...line} />
          ))
        : hunk.lines.map((l, k) => <LineRow key={k} line={l} {...line} />)}
    </>
  )
}

/** Side by side: the n-th removed line across from the n-th added one, as the instructions diff does. */
export function pairLines(lines: readonly DiffHunkLine[]): Array<[DiffHunkLine | null, DiffHunkLine | null]> {
  const out: Array<[DiffHunkLine | null, DiffHunkLine | null]> = []
  let dels: DiffHunkLine[] = []
  let adds: DiffHunkLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push([dels[i] ?? null, adds[i] ?? null])
    dels = []
    adds = []
  }
  for (const l of lines) {
    if (l.op === 'del') dels.push(l)
    else if (l.op === 'add') adds.push(l)
    else {
      flush()
      out.push([l, l])
    }
  }
  flush()
  return out
}

function PairRow({ left, right, ...line }: LineProps & { left: DiffHunkLine | null; right: DiffHunkLine | null }): JSX.Element {
  // a context line sits on both sides but is one line: address it once, on the right
  const cells: Array<{ l: DiffHunkLine | null; side: 'old' | 'new' }> = [
    { l: left, side: 'old' },
    { l: right, side: 'new' }
  ]
  const own = (l: DiffHunkLine | null, side: 'old' | 'new'): boolean => !!l && (l.op !== 'same' || side === 'new')
  return (
    <>
      <div className="idiff-pair">
        {cells.map(({ l, side }) =>
          l ? (
            <Line key={side} line={l} side={side} {...line} addressable={own(l, side)} />
          ) : (
            <div key={side} className="idiff-line empty" aria-hidden="true" />
          )
        )}
      </div>
      {cells.map(
        ({ l, side }) =>
          own(l, side) && l && addressed(l, line) && <NoteRow key={`n-${side}`} line={l} {...line} />
      )}
    </>
  )
}

function LineRow({ line: l, ...line }: LineProps & { line: DiffHunkLine }): JSX.Element {
  return (
    <>
      <Line line={l} side="both" addressable {...line} />
      {addressed(l, line) && <NoteRow line={l} {...line} />}
    </>
  )
}

function Line({
  line: l,
  side,
  addressable,
  file,
  editing,
  onEdit,
  notes
}: LineProps & { line: DiffHunkLine; side: 'old' | 'new' | 'both'; addressable: boolean }): JSX.Element {
  const key = noteKey(file.path, l)
  // a removed line and an added one can share a number — say which side
  const where = l.op === 'del' ? `removed line ${l.oldNo}` : `line ${l.newNo}`
  const open = editing === key
  return (
    <div className={`idiff-line ${l.op} ${notes.has(key) ? 'noted' : ''}`}>
      {onEdit && addressable ? (
        <button
          className="review-note-btn"
          aria-label={`Note on ${file.path} ${where}`}
          aria-expanded={open}
          title="Add a note for the agent"
          onClick={() => onEdit(open ? null : key)}
        >
          +
        </button>
      ) : (
        <span className="review-note-btn" aria-hidden="true" />
      )}
      {side !== 'new' && (
        <span className="idiff-no" aria-hidden="true">
          {l.oldNo ?? ''}
        </span>
      )}
      {side !== 'old' && (
        <span className="idiff-no" aria-hidden="true">
          {l.newNo ?? ''}
        </span>
      )}
      <span className="idiff-gut" aria-hidden="true">
        {GUTTER[l.op]}
      </span>
      {l.op !== 'same' && <span className="sr-only">{SAID[l.op]}</span>}
      <span className="idiff-text">{l.text}</span>
      {notes.has(key) && <span className="sr-only"> (has a note)</span>}
    </div>
  )
}

/** Only lines with a note, or the one being written, carry a note row at all. */
function addressed(l: DiffHunkLine, { file, editing, notes }: LineProps): boolean {
  const key = noteKey(file.path, l)
  return editing === key || notes.has(key)
}

/** Under an addressed line: the editor while it is open, the kept note after. */
function NoteRow({ line: l, file, notes, editing, onEdit, onKeep, onDrop }: LineProps & { line: DiffHunkLine }): JSX.Element | null {
  const key = noteKey(file.path, l)
  const kept = notes.get(key)
  const [draft, setDraft] = useState(kept?.text ?? '')
  if (editing === key && onEdit) {
    const commit = (): void => {
      if (draft.trim()) onKeep({ path: file.path, line: l, text: draft })
      else onEdit(null)
    }
    return (
      <div className="review-note">
        <textarea
          aria-label={`Note for the agent on ${file.path} ${l.op === 'del' ? `removed line ${l.oldNo}` : `line ${l.newNo}`}`}
          placeholder="What should change here?  (Enter to keep, Esc to discard)"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              setDraft(kept?.text ?? '')
              onEdit(null)
            }
          }}
        />
        <span className="review-note-actions">
          <button className="btn-ghost small" onClick={commit}>
            Keep
          </button>
          <button
            className="btn-ghost small"
            onClick={() => {
              setDraft(kept?.text ?? '')
              onEdit(null)
            }}
          >
            Discard
          </button>
        </span>
      </div>
    )
  }
  if (!kept) return null
  return (
    <div className="review-note" role="note">
      <span className="review-note-text">{kept.text}</span>
      <span className="review-note-actions">
        {onEdit && (
          <button className="btn-ghost small" onClick={() => onEdit(key)}>
            Edit
          </button>
        )}
        <button className="icon-btn small" aria-label="Remove note" title="Remove note" onClick={() => onDrop(key)}>
          ×
        </button>
      </span>
    </div>
  )
}
