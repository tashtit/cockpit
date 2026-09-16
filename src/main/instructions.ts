import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { InstructionFile, InstructionsState } from '../shared/types'
import {
  adoptableBlock,
  extractSharedBlock,
  fileStatus,
  instructionTargets,
  lineCount,
  normalizeBaseline,
  removeSharedBlock,
  splitSharedBlock,
  upsertSharedBlock
} from './instructions-core'
import { loadConfig, saveConfig } from './config'

/* IO around instructions-core: baseline storage (cockpit config) + file fan-out. */

function storedBaseline(repoRoot: string | null): string | undefined {
  const cfg = loadConfig()
  return repoRoot === null ? cfg.sharedInstructions?.global : cfg.sharedInstructions?.repos?.[repoRoot]
}

function getBaseline(repoRoot: string | null): string {
  // a baseline saved before normalization existed may still carry its markers;
  // every reader gets the clean form so the status, the review and what apply
  // writes can never disagree
  return normalizeBaseline(storedBaseline(repoRoot) ?? '')
}

/**
 * A repo scope Cockpit has never had a baseline for, whose files already carry a
 * managed block, adopts it — that block is how a teammate receives the repo's
 * shared instructions, and without this it would read as somebody else's drift.
 * Only for repos, and only when nothing is stored at all: an empty string is a
 * baseline the user cleared, and re-adopting it would undo that on the next read.
 * Global scopes are left alone; a stale `~/.claude/CLAUDE.md` block is not an
 * instruction anyone shared.
 */
function adoptFromFiles(repoRoot: string | null): void {
  if (repoRoot === null || storedBaseline(repoRoot) !== undefined) return
  const block = adoptableBlock(instructionTargets(repoRoot).map((t) => readTarget(t.path)))
  if (block !== null) setBaseline(repoRoot, block)
}

function setBaseline(repoRoot: string | null, baseline: string): void {
  const cfg = loadConfig()
  const shared = cfg.sharedInstructions ?? {}
  const sharedInstructions =
    repoRoot === null
      ? { ...shared, global: baseline }
      : { ...shared, repos: { ...shared.repos, [repoRoot]: baseline } }
  saveConfig({ ...cfg, sharedInstructions })
}

const MAX_INSTRUCTION_BYTES = 1024 * 1024

/** Full contents, or null when unreadable. Never truncates — callers write this back. */
function readTarget(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Display copy for the renderer: bounded, since the UI never writes it back whole. */
function readTargetForDisplay(path: string): string | null {
  const raw = readTarget(path)
  return raw === null ? null : raw.slice(0, MAX_INSTRUCTION_BYTES)
}

export function getInstructions(repoRoot: string | null): InstructionsState {
  adoptFromFiles(repoRoot)
  const baseline = getBaseline(repoRoot)
  const files: InstructionFile[] = instructionTargets(repoRoot).map(({ agents, path }) => {
    const raw = readTargetForDisplay(path)
    // the block and the counts around it come from the same read as the status,
    // so the diff the renderer draws can never disagree with the pill beside it
    const split = splitSharedBlock(raw ?? '')
    return {
      agents,
      path,
      exists: raw !== null,
      content: raw ?? '',
      block: split.block,
      own: { above: lineCount(split.above), below: lineCount(split.below) },
      status: fileStatus(raw, baseline)
    }
  })
  return { repoRoot, baseline, files }
}

export function saveBaseline(repoRoot: string | null, baseline: string): InstructionsState {
  // the editor's text verbatim would keep the markers of a pasted whole file
  setBaseline(repoRoot, normalizeBaseline(baseline))
  return getInstructions(repoRoot)
}

/** Fan the baseline out into the targets (all of them, or just `onlyPath`). */
export function applyInstructions(repoRoot: string | null, onlyPath?: string): InstructionsState {
  const baseline = getBaseline(repoRoot)
  if (baseline.trim() === '') throw new Error('shared instructions are empty — nothing to apply')
  const targets = instructionTargets(repoRoot)
  if (onlyPath && !targets.some((t) => t.path === onlyPath)) {
    throw new Error(`not an instruction file for this scope: ${onlyPath}`)
  }
  for (const { path } of targets) {
    if (onlyPath && path !== onlyPath) continue
    const raw = readTarget(path) ?? ''
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, upsertSharedBlock(raw, baseline))
  }
  return getInstructions(repoRoot)
}

/** Take the shared block out of one agent's file, leaving the rest untouched. */
export function unapplyInstructions(repoRoot: string | null, path: string): InstructionsState {
  const target = instructionTargets(repoRoot).find((t) => t.path === path)
  if (!target) throw new Error(`not an instruction file for this scope: ${path}`)
  const raw = readTarget(path)
  if (raw !== null) writeFileSync(path, removeSharedBlock(raw))
  return getInstructions(repoRoot)
}

/**
 * Take one file's managed block as the baseline. The other side of drift: a
 * teammate's update arrives in the repo's own files through `git pull`, and this
 * is how it becomes Cockpit's baseline rather than something to overwrite.
 */
export function adoptInstructionsFrom(repoRoot: string | null, path: string): InstructionsState {
  const target = instructionTargets(repoRoot).find((t) => t.path === path)
  if (!target) throw new Error(`not an instruction file for this scope: ${path}`)
  const block = extractSharedBlock(readTarget(path) ?? '')
  if (block === null || block.trim() === '') {
    throw new Error(`${path} has no shared block to take`)
  }
  setBaseline(repoRoot, normalizeBaseline(block))
  return getInstructions(repoRoot)
}

/** Direct edit of one agent file — path must be a target of the given scope. */
export function saveInstructionFile(
  repoRoot: string | null,
  path: string,
  content: string
): InstructionsState {
  const target = instructionTargets(repoRoot).find((t) => t.path === path)
  if (!target) throw new Error(`not an instruction file for this scope: ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return getInstructions(repoRoot)
}
