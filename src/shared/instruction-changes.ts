import type { InstructionFile, InstructionStatus } from './types'
import { normalizeBaseline } from './instruction-markers'
import { diffLines, diffStat, splitLines, type DiffLine } from './line-diff'

/*
 * What applying a given baseline would do to one agent file — the pre-apply review.
 * Pure: the renderer draws it, the tests pin it. Only the managed block is ever
 * compared, because only the managed block is ever written.
 */

export type FileChange = {
  /**
   * Relative to the incoming text, not the saved baseline: synced = nothing to
   * write, drifted = the block is rewritten, unmanaged = a block is appended,
   * missing = the file is created.
   */
  readonly status: InstructionStatus
  readonly lines: readonly DiffLine[]
  readonly added: number
  readonly removed: number
}

export function fileChange(file: InstructionFile, incoming: string): FileChange {
  // the writer strips marker lines from the baseline, so the review must too — or a
  // pasted whole file would show two lines per target that apply never writes
  const next = normalizeBaseline(incoming)
  const lines = diffLines(file.block === null ? [] : splitLines(file.block), splitLines(next))
  const { added, removed } = diffStat(lines)
  const status: InstructionStatus = !file.exists
    ? 'missing'
    : file.block === null
      ? 'unmanaged'
      : added + removed === 0
        ? 'synced'
        : 'drifted'
  return { status, lines, added, removed }
}
