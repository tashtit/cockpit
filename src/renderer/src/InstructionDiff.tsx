import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import type { FileChange } from '../../shared/instruction-changes'
import { END, START } from '../../shared/instruction-markers'
import { shortPath } from '../../shared/library'
import {
  foldUnchanged,
  splitRows,
  type DiffFold,
  type DiffLine,
  type DiffRow
} from '../../shared/line-diff'
import type { InstructionFile, InstructionStatus } from '../../shared/types'
import {
  DIFF_LAYOUTS,
  DIFF_LAYOUT_LABEL,
  setDiffLayout,
  useDiffLayout,
  type DiffLayout
} from './diff-layout'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

/**
 * One agent file, drawn the way the contract reads: the agent's own lines folded
 * into counted bands outside two marker rails, and the shared block diffed between
 * them. The block itself uses GitHub's line grammar — green in, red out, a +/−
 * gutter — because that is the diff everyone here already reads. The rails and the
 * bands are the part that is Cockpit's: they show, rather than promise, that nothing
 * outside the markers moves.
 */

/** What an apply does to this file — the pill beside the path. */
const CHANGE_LABEL: Record<InstructionStatus, string> = {
  synced: 'no changes',
  drifted: 'rewrites block',
  unmanaged: 'adds block',
  missing: 'creates file'
}

/** The apply button's verb, by what the file needs. Shared with the file rows. */
export const APPLY_LABEL: Record<Exclude<InstructionStatus, 'synced'>, string> = {
  missing: 'Create & apply',
  unmanaged: 'Apply',
  drifted: 'Re-apply'
}

const GUTTER: Record<DiffLine['op'], string> = { same: ' ', add: '+', del: '−' }
const SAID: Record<DiffLine['op'], string> = { same: '', add: 'added: ', del: 'removed: ' }

function bandText(n: number): string {
  return n === 1
    ? '1 line outside the markers stays as it is'
    : `${n} lines outside the markers stay as they are`
}

/** A sibling's bare name; the shortened path when it lives elsewhere. */
function nameBeside(path: string, sibling: string): string {
  const dir = (p: string): string => p.slice(0, p.lastIndexOf('/'))
  return dir(path) === dir(sibling) ? path.slice(path.lastIndexOf('/') + 1) : shortPath(path)
}

/**
 * Who reads this file on Claude's behalf — a `CLAUDE.md` that imports it or links
 * to it, which is why Claude's logo sits on this row and that file has no row of
 * its own. Shared with the file rows.
 */
export function ReadByNote({ file }: { file: InstructionFile }): JSX.Element | null {
  if (file.readBy.length === 0) return null
  return (
    <span className="inst-via">
      {file.readBy
        .map((r) => `${nameBeside(r.path, file.path)} ${r.how === 'link' ? 'links here' : 'imports this file'}`)
        .join(' · ')}
    </span>
  )
}

export function DiffStat({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="idiff-stat">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">−{removed}</span>}
    </span>
  )
}

/**
 * Unified or side by side — one switch for every diff in the app, remembered. A
 * segmented pair in the placard voice, the scope switch's grammar at row size.
 */
export function DiffLayoutToggle(): JSX.Element {
  const layout = useDiffLayout()
  return (
    <span className="idiff-layout" role="group" aria-label="Diff layout">
      {DIFF_LAYOUTS.map((l) => (
        <button
          key={l}
          className={layout === l ? 'active' : ''}
          aria-pressed={layout === l}
          onClick={() => setDiffLayout(l)}
        >
          {DIFF_LAYOUT_LABEL[l]}
        </button>
      ))}
    </span>
  )
}

export function InstructionDiff({
  file,
  change,
  layout,
  action,
  headRef
}: {
  file: InstructionFile
  change: FileChange
  layout: DiffLayout
  /** the row's own action (an apply button), right-aligned in the head */
  action?: ReactNode
  /** the head is the jump target for "see changes" — focusable, never in tab order */
  headRef?: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const path = shortPath(file.path)
  const tint = file.agents.length === 1 ? `tint-${file.agents[0]}` : 'plain'
  const readers = file.agents.map((a) => PROVIDER_LABEL[a]).join(' and ')
  return (
    <section className="idiff" aria-label={`Changes to ${path}`}>
      <div className={`idiff-head ${tint}`} ref={headRef} tabIndex={headRef ? -1 : undefined}>
        <span className="ext-agents" aria-label={`Read by ${readers}`}>
          {file.agents.map((a) => (
            <span key={a} className={`plogo plogo-${a}`} title={PROVIDER_LABEL[a]}>
              <ProviderLogo p={a} size={13} />
            </span>
          ))}
        </span>
        <span className="idiff-path">{path}</span>
        {change.status !== 'synced' && <DiffStat added={change.added} removed={change.removed} />}
        <span className={`inst-status ${change.status}`}>{CHANGE_LABEL[change.status]}</span>
        <ReadByNote file={file} />
        {action}
      </div>
      {change.status !== 'synced' && (
        <div className="idiff-body">
          {file.own.above > 0 && <Band n={file.own.above} />}
          <div className="idiff-rail">{START}</div>
          <Lines lines={change.lines} layout={layout} />
          <div className="idiff-rail">{END}</div>
          {file.duplicates > 0 && <Dropped n={file.duplicates} />}
          {file.own.below > 0 && <Band n={file.own.below} />}
        </div>
      )}
    </section>
  )
}

function Band({ n }: { n: number }): JSX.Element {
  return (
    <div className="idiff-band">
      <span aria-hidden="true">⋯</span>
      {bandText(n)}
    </div>
  )
}

/**
 * The file carries the block again further down — the other spelling of the
 * markers, usually, each tool having written its own — and the apply folds that
 * copy into the one above. Said in the band's voice: it is a fact about the write,
 * not a line of the diff.
 */
function Dropped({ n }: { n: number }): JSX.Element {
  return (
    <div className="idiff-band">
      <span aria-hidden="true">⋯</span>
      {n === 1
        ? 'a second copy of the block is dropped'
        : `${n} further copies of the block are dropped`}
    </div>
  )
}

function Lines({ lines, layout }: { lines: readonly DiffLine[]; layout: DiffLayout }): JSX.Element {
  const rows = useMemo(() => foldUnchanged(lines), [lines])
  // fold rows are addressed by position: the rows are rebuilt whole whenever the
  // text changes, so an expansion only ever means "this row, in this diff"
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => setOpened(new Set()), [lines])

  // what is on screen: opened folds become their lines, closed ones keep their
  // position so the button knows which fold it opens
  const foldAt = new Map<DiffFold, number>()
  const shown: DiffRow[] = []
  rows.forEach((row, i) => {
    if (row.op !== 'fold') shown.push(row)
    else if (opened.has(i)) shown.push(...row.lines)
    else {
      foldAt.set(row, i)
      shown.push(row)
    }
  })
  const open = (fold: DiffFold): void => setOpened(new Set([...opened, foldAt.get(fold) ?? -1]))

  if (layout === 'split') {
    return (
      <>
        {splitRows(shown).map((row, k) =>
          row.op === 'fold' ? (
            <FoldRow key={k} row={row} onOpen={() => open(row)} />
          ) : (
            <div key={k} className="idiff-pair">
              <Cell line={row.left} />
              <Cell line={row.right} />
            </div>
          )
        )}
      </>
    )
  }
  return (
    <>
      {shown.map((row, k) =>
        row.op === 'fold' ? (
          <FoldRow key={k} row={row} onOpen={() => open(row)} />
        ) : (
          <Line key={k} line={row} />
        )
      )}
    </>
  )
}

/** One side of a pair: the line, or the blank the other side's change leaves. */
function Cell({ line }: { line: DiffLine | null }): JSX.Element {
  return line ? <Line line={line} /> : <div className="idiff-line empty" aria-hidden="true" />
}

function FoldRow({ row, onOpen }: { row: DiffFold; onOpen: () => void }): JSX.Element {
  return (
    <button className="idiff-fold" aria-expanded={false} onClick={onOpen}>
      <span aria-hidden="true">⋯</span>
      {row.lines.length} unchanged lines
    </button>
  )
}

function Line({ line }: { line: DiffLine }): JSX.Element {
  return (
    <div className={`idiff-line ${line.op}`}>
      <span className="idiff-gut" aria-hidden="true">
        {GUTTER[line.op]}
      </span>
      {line.op !== 'same' && <span className="sr-only">{SAID[line.op]}</span>}
      <span className="idiff-text">{line.text}</span>
    </div>
  )
}
