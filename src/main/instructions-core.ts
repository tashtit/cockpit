import { homedir } from 'node:os'
import { join } from 'node:path'
import { END, START } from '../shared/instruction-markers'
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
 */

export { END, START }

export type SharedSplit = {
  /** the agent's own content before the block (the whole file when there is none) */
  readonly above: string
  /** content between the markers, or null when the file has no (complete) block */
  readonly block: string | null
  /** the agent's own content after the block ('' when there is none) */
  readonly below: string
}

/**
 * The file as the contract reads it: the agent's own lines, the managed block, the
 * agent's own lines. A file with no complete block is all "above" — that is where an
 * apply would append the block.
 */
export function splitSharedBlock(raw: string): SharedSplit {
  const s = raw.indexOf(START)
  const e = s === -1 ? -1 : raw.indexOf(END, s + START.length)
  if (s === -1 || e === -1) return { above: raw, block: null, below: '' }
  return {
    above: raw.slice(0, s),
    block: raw.slice(s + START.length, e).replace(/^\n/, '').replace(/\n[ \t]*$/, ''),
    below: raw.slice(e + END.length)
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

/** Replace the managed block in-place, or append one at the end of the file. */
export function upsertSharedBlock(raw: string, baseline: string): string {
  const block = `${START}\n${baseline.trim()}\n${END}`
  const s = raw.indexOf(START)
  const e = s === -1 ? -1 : raw.indexOf(END, s + START.length)
  if (s !== -1 && e !== -1) {
    return raw.slice(0, s) + block + raw.slice(e + END.length)
  }
  if (s !== -1) {
    // orphaned START (hand-edited or truncated file): repair it in place rather
    // than appending a second block — a later upsert would otherwise treat the
    // span from this START to the appended END as managed and eat what's between
    return raw.slice(0, s) + block + raw.slice(s + START.length)
  }
  if (raw.trim() === '') return block + '\n'
  return raw.replace(/\n*$/, '\n\n') + block + '\n'
}

/**
 * Take the managed block back out, leaving the agent's own content exactly as it
 * was. Switching an agent off must not touch a line the user wrote themselves.
 */
export function removeSharedBlock(raw: string): string {
  const s = raw.indexOf(START)
  if (s === -1) return raw
  const e = raw.indexOf(END, s + START.length)
  const rest = e === -1 ? raw.slice(s + START.length) : raw.slice(e + END.length)
  return (raw.slice(0, s) + rest).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

export function fileStatus(raw: string | null, baseline: string): InstructionStatus {
  if (raw === null) return 'missing'
  const block = extractSharedBlock(raw)
  if (block === null) return 'unmanaged'
  return block.trim() === baseline.trim() ? 'synced' : 'drifted'
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
