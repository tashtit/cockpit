import { Fragment, memo, useCallback, useEffect, useState, type JSX, type RefObject } from 'react'
import type { FileEdit } from '../../shared/types'
import { fileChange, type EditEntry, type FileWork, type WorkModel } from '../../shared/work'
import { DiffLines, DiffStat } from './InstructionDiff'
import { samePlain } from './same'
import { fmtTime, plural } from './format'
import { useTimeFormat } from './time'
import { relative, useRing, type WorkFocus } from './work-tab'

/** The Work panel's Edits tab: every edit the agent made, file by file, as its calls described them. */

/** Up to this many files open expanded; past it they open on demand */
const OPEN_FILES = 3

const CHANGE_WORD: Record<FileEdit['change'], string | null> = {
  add: 'added',
  write: 'written',
  delete: 'deleted',
  edit: null
}

export function WorkEditsTab({
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
  const openByDefault = files.length <= OPEN_FILES
  const isOpen = (path: string): boolean => toggled.get(path) ?? openByDefault
  // one handler for every file, so a memoized block is not redrawn for a new closure
  const onToggle = useCallback(
    (path: string, on: boolean): void =>
      // a details element reports its first paint too: only a change is a choice
      setToggled((m) => (on === (m.get(path) ?? openByDefault) ? m : new Map([...m, [path, on]]))),
    [openByDefault]
  )

  // a row opened the panel at its edit: open that file, bring the edit into view, ring it
  const ringed = useRing(scroller, focus, () => focusFile !== undefined)
  useEffect(() => {
    if (!focusFile || focus.key === null) return
    setToggled((m) => (m.get(focusFile.path) ? m : new Map([...m, [focusFile.path, true]])))
  }, [focus.at])

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
          {plural(model.editCount, 'edit')} · {plural(files.length, 'file')}
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
            onToggle={onToggle}
          />
        ))}
      </div>
    </>
  )
}

type FileBlockProps = {
  readonly file: FileWork
  readonly cwd: string
  readonly open: boolean
  readonly ringed: number | null
  readonly onToggle: (path: string, open: boolean) => void
}

/**
 * Memoized by what the file says, not its object: every fold of the model builds fresh
 * entries, but an edit already on screen keeps its own lines — so a new edit arriving
 * mid-turn redraws only the file it touched.
 */
const FileBlock = memo(function FileBlock({ file, cwd, open, ringed, onToggle }: FileBlockProps): JSX.Element {
  const shown = relative(file.path, cwd)
  const moved = [...file.edits].reverse().find((e) => e.edit.movedTo)?.edit.movedTo
  const kind = fileChange(file)
  const failed = file.edits.every((e) => e.failed)
  return (
    <details className="idiff review-file work-file" open={open} onToggle={(e) => onToggle(file.path, e.currentTarget.open)}>
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
},
(a, b) =>
  a.cwd === b.cwd && a.open === b.open && a.ringed === b.ringed && a.onToggle === b.onToggle && samePlain(a.file, b.file))

/** What to say where a call named a file but carried no lines to draw. */
function noLines(edit: FileEdit): string {
  if (edit.change === 'delete') return 'the file was deleted'
  if (edit.truncated) return 'too large to show here'
  return 'the call named this file but not the lines it changed'
}

type EditBlockProps = { readonly entry: EditEntry; readonly ringed: boolean }

/** Memoized by what the edit says — see FileBlock */
const EditBlock = memo(function EditBlock({ entry, ringed }: EditBlockProps): JSX.Element {
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
},
(a, b) => a.ringed === b.ringed && samePlain(a.entry, b.entry))
