import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { InstructionFile, InstructionsState } from '../shared/types'
import { fileStatus, instructionTargets, upsertSharedBlock } from './instructions-core'
import { loadConfig, saveConfig } from './config'

/* IO around instructions-core: baseline storage (cockpit config) + file fan-out. */

function getBaseline(repoRoot: string | null): string {
  const cfg = loadConfig()
  if (repoRoot === null) return cfg.sharedInstructions?.global ?? ''
  return cfg.sharedInstructions?.repos?.[repoRoot] ?? ''
}

function setBaseline(repoRoot: string | null, baseline: string): void {
  const cfg = loadConfig()
  cfg.sharedInstructions = cfg.sharedInstructions ?? {}
  if (repoRoot === null) {
    cfg.sharedInstructions.global = baseline
  } else {
    cfg.sharedInstructions.repos = cfg.sharedInstructions.repos ?? {}
    cfg.sharedInstructions.repos[repoRoot] = baseline
  }
  saveConfig(cfg)
}

const MAX_INSTRUCTION_BYTES = 1024 * 1024

function readTarget(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').slice(0, MAX_INSTRUCTION_BYTES)
  } catch {
    return null
  }
}

export function getInstructions(repoRoot: string | null): InstructionsState {
  const baseline = getBaseline(repoRoot)
  const files: InstructionFile[] = instructionTargets(repoRoot).map(({ agents, path }) => {
    const raw = readTarget(path)
    return {
      agents,
      path,
      exists: raw !== null,
      content: raw ?? '',
      status: fileStatus(raw, baseline)
    }
  })
  return { repoRoot, baseline, files }
}

export function saveBaseline(repoRoot: string | null, baseline: string): InstructionsState {
  setBaseline(repoRoot, baseline)
  return getInstructions(repoRoot)
}

/** Fan the baseline out into the targets (all of them, or just `onlyPath`). */
export function applyInstructions(repoRoot: string | null, onlyPath?: string): InstructionsState {
  const baseline = getBaseline(repoRoot)
  if (baseline.trim() === '') throw new Error('shared instructions are empty — nothing to apply')
  for (const { path } of instructionTargets(repoRoot)) {
    if (onlyPath && path !== onlyPath) continue
    const raw = readTarget(path) ?? ''
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, upsertSharedBlock(raw, baseline))
  }
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
