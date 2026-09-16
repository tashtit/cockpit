import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  END,
  END_MARKERS,
  LEGACY_END,
  LEGACY_START,
  START,
  START_MARKERS,
  normalizeBaseline
} from '../shared/instruction-markers'
import type { InstructionFile, InstructionStatus } from '../shared/types'

/*
 * Pure logic for the shared-instructions feature (no electron, unit-testable).
 *
 * Every agent reads free-form markdown instructions, each from its own place:
 *
 *   global   claude  ~/.claude/CLAUDE.md
 *            codex   ~/.codex/AGENTS.md
 *            copilot ~/.copilot/copilot-instructions.md
 *   repo     claude  <root>/CLAUDE.md
 *            codex + copilot  <root>/AGENTS.md   (both read AGENTS.md natively)
 *
 * Cockpit keeps ONE shared baseline per scope and fans it out into each file
 * inside managed markers. Content outside the markers is the agent's own and
 * is never touched.
 *
 * The markers come in two spellings — the `agent-parity` pair the plugin of that
 * name writes, and the `cockpit` pair Cockpit wrote before it adopted the plugin's.
 * Either opens or closes a block, in any combination, and a file that carries the
 * block under both names (each tool having appended its own before it could read
 * the other's) is folded back into one block on the next apply. Everything written
 * is the canonical pair; the legacy one is only ever read.
 */

export { END, LEGACY_END, LEGACY_START, START, normalizeBaseline }

/** Where one marker sits in the file: `[at, end)`. */
type Span = {
  readonly at: number
  readonly end: number
}

/** A complete block: its START and its END marker. */
type Block = {
  readonly start: Span
  readonly close: Span
}

/** The earliest of the given markers at or after `from`, in either spelling. */
function findMarker(raw: string, markers: readonly string[], from: number): Span | null {
  let first: Span | null = null
  for (const marker of markers) {
    const at = raw.indexOf(marker, from)
    if (at !== -1 && (first === null || at < first.at)) first = { at, end: at + marker.length }
  }
  return first
}

/**
 * The first complete block at or after `from`: the first START, then the first END
 * after it. An END of the other spelling closes it too — the plugin reads the two
 * "in any combination", and a file half-renamed by hand is still one block.
 */
function findBlock(raw: string, from: number): Block | null {
  const start = findMarker(raw, START_MARKERS, from)
  if (start === null) return null
  const close = findMarker(raw, END_MARKERS, start.end)
  return close === null ? null : { start, close }
}

/** The text between a block's markers, without the newline after START or the blank tail. */
function blockText(raw: string, block: Block): string {
  return raw.slice(block.start.end, block.close.at).replace(/^\n/, '').replace(/\n[ \t]*$/, '')
}

/**
 * The agent's own text on either side of a dropped block, joined. The END marker's
 * own line ending goes with it, and the blank line that set the block apart was
 * the block's padding rather than the agent's prose: at most one blank line is
 * left between what remains, and none at the end of the file. Every other byte
 * outside the markers is kept as it was.
 */
function joinAround(before: string, after: string): string {
  const rest = after.replace(/^\r?\n/, '')
  const padded = rest === '' || /^\r?\n/.test(rest)
  return (padded ? before.replace(/(\r?\n)(?:\r?\n)+$/, '$1') : before) + rest
}

export type SharedSplit = {
  /** the agent's own content before the block (the whole file when there is none) */
  readonly above: string
  /** content between the markers, or null when the file has no (complete) block */
  readonly block: string | null
  /** the agent's own content after the block ('' when there is none) */
  readonly below: string
  /**
   * Further blocks after the first — the same text under the other spelling of the
   * markers, typically. An apply folds them into the one block; the agent's own
   * lines between them are already in `below`, as they will be once it has.
   */
  readonly duplicates: number
}

/**
 * The file as the contract reads it: the agent's own lines, the managed block, the
 * agent's own lines. A file with no complete block is all "above" — that is where an
 * apply would append the block. A file with more than one block reads as the first,
 * with the others already taken out of "below": the first is where the block was
 * put on purpose, and a later one is a tool's second copy, never the agent's text.
 */
export function splitSharedBlock(raw: string): SharedSplit {
  const first = findBlock(raw, 0)
  if (first === null) return { above: raw, block: null, below: '', duplicates: 0 }
  const later: Block[] = []
  for (let b = findBlock(raw, first.close.end); b !== null; b = findBlock(raw, b.close.end)) {
    later.push(b)
  }
  // drop the later blocks back to front, so each one's offsets still hold when its turn comes
  const offset = first.close.end
  let below = raw.slice(offset)
  for (const b of [...later].reverse()) {
    below = joinAround(below.slice(0, b.start.at - offset), below.slice(b.close.end - offset))
  }
  return {
    above: raw.slice(0, first.start.at),
    block: blockText(raw, first),
    below,
    duplicates: later.length
  }
}

/** Content between the managed markers, or null when the file has no block. */
export function extractSharedBlock(raw: string): string | null {
  return splitSharedBlock(raw).block
}

/** Lines in a piece of text, ignoring the blank padding around it. */
export function lineCount(text: string): number {
  const t = text.trim()
  return t === '' ? 0 : t.split('\n').length
}

/**
 * Replace the managed block in-place, or append one at the end of the file. The
 * baseline is normalized here as well as where it is saved, so one stored with
 * its markers still applies as a single block. The block is always written in the
 * canonical spelling: a legacy pair is renamed where it stands, and a second copy
 * of the block, under either name, is folded into this one.
 */
export function upsertSharedBlock(raw: string, baseline: string): string {
  const block = `${START}\n${normalizeBaseline(baseline)}\n${END}`
  const split = splitSharedBlock(raw)
  if (split.block !== null) return split.above + block + split.below
  const orphan = findMarker(raw, START_MARKERS, 0)
  if (orphan !== null) {
    // orphaned START (hand-edited or truncated file): repair it in place rather
    // than appending a second block — a later upsert would otherwise treat the
    // span from this START to the appended END as managed and eat what's between
    return raw.slice(0, orphan.at) + block + raw.slice(orphan.end)
  }
  if (raw.trim() === '') return block + '\n'
  return raw.replace(/\n*$/, '\n\n') + block + '\n'
}

/**
 * Take the managed block back out — every copy of it — leaving the agent's own
 * content exactly as it was. Switching an agent off must not touch a line the
 * user wrote themselves.
 */
export function removeSharedBlock(raw: string): string {
  const split = splitSharedBlock(raw)
  let rest: string
  if (split.block !== null) {
    rest = split.above + split.below
  } else {
    // an orphaned START of either spelling: the marker goes, what followed it stays
    const orphan = findMarker(raw, START_MARKERS, 0)
    if (orphan === null) return raw
    rest = raw.slice(0, orphan.at) + raw.slice(orphan.end)
  }
  return rest.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

export function fileStatus(raw: string | null, baseline: string): InstructionStatus {
  if (raw === null) return 'missing'
  const split = splitSharedBlock(raw)
  if (split.block === null) return 'unmanaged'
  // a second copy of the block is never in sync, whatever either copy says: the
  // file needs an apply to fold the two back into one
  if (split.duplicates > 0) return 'drifted'
  // normalized on this side too: a baseline stored with its markers must not read
  // every file as drifted until it happens to be saved again
  return split.block.trim() === normalizeBaseline(baseline) ? 'synced' : 'drifted'
}

/**
 * The block to adopt as a scope's baseline when Cockpit has none of its own.
 *
 * A repo's shared instructions live in the repo, so a teammate who clones it —
 * or pulls a merged instructions PR — already has the text on disk before
 * Cockpit has ever heard of it. Taking it is the same move the library makes
 * with whatever the agents already have. First block in target order wins, so
 * two files that disagree resolve to `CLAUDE.md` and the other reads as drifted.
 */
export function adoptableBlock(raws: readonly (string | null)[]): string | null {
  for (const raw of raws) {
    const block = raw === null ? null : extractSharedBlock(raw)
    if (block !== null && block.trim() !== '') return normalizeBaseline(block)
  }
  return null
}

export type InstructionTarget = {
  readonly agents: InstructionFile['agents']
  readonly path: string
}

export function instructionTargets(
  repoRoot: string | null,
  home = homedir()
): InstructionTarget[] {
  if (repoRoot === null) {
    return [
      { agents: ['claude'], path: join(home, '.claude', 'CLAUDE.md') },
      { agents: ['codex'], path: join(home, '.codex', 'AGENTS.md') },
      { agents: ['copilot'], path: join(home, '.copilot', 'copilot-instructions.md') }
    ]
  }
  return [
    { agents: ['claude'], path: join(repoRoot, 'CLAUDE.md') },
    { agents: ['codex', 'copilot'], path: join(repoRoot, 'AGENTS.md') }
  ]
}
