import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type { FileChange } from '../../shared/instruction-changes'
import { END, START } from '../../shared/instruction-markers'
import { shortPath } from '../../shared/library'
import { foldUnchanged, type DiffLine, type DiffRow } from '../../shared/line-diff'
import type { InstructionFile, InstructionStatus } from '../../shared/types'
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

export function DiffStat({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="idiff-stat">
      {added > 0 && <span className="add">+{added}</span>}
      {removed > 0 && <span className="del">−{removed}</span>}
    </span>
  )
}

export function InstructionDiff({
  file,
  change,
  action,
  headRef
}: {
  file: InstructionFile
  change: FileChange
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
        {action}
      </div>
      {change.status !== 'synced' && (
        <div className="idiff-body">
          {file.own.above > 0 && <Band n={file.own.above} />}
          <div className="idiff-rail">{START}</div>
          <Lines lines={change.lines} />
          <div className="idiff-rail">{END}</div>
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

function Lines({ lines }: { lines: readonly DiffLine[] }): JSX.Element {
  const rows = foldUnchanged(lines)
  // fold rows are addressed by position: the rows are rebuilt whole whenever the
  // text changes, so an expansion only ever means "this row, in this diff"
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  useEffect(() => setOpened(new Set()), [lines])
  return (
    <>
      {rows.map((row, i) =>
        row.op === 'fold' && !opened.has(i) ? (
          <FoldRow key={i} row={row} onOpen={() => setOpened(new Set([...opened, i]))} />
        ) : row.op === 'fold' ? (
          row.lines.map((line, k) => <Line key={`${i}.${k}`} line={line} />)
        ) : (
          <Line key={i} line={row} />
        )
      )}
    </>
  )
}

function FoldRow({ row, onOpen }: { row: Extract<DiffRow, { op: 'fold' }>; onOpen: () => void }): JSX.Element {
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
