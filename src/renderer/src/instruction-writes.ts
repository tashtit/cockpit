import type { InstructionsState } from '../../shared/types'
import { api } from './api'

/**
 * One write to the instruction files, and the words it ends on. The two per-file ones —
 * write the baseline into a file, or take its block as the baseline — are offered on the
 * editor's file rows and on the panel's instructions row alike, so they are defined once.
 */
export type InstructionsWrite = {
  readonly op: () => Promise<InstructionsState>
  readonly ok: string
}

/** Write the saved baseline into one agent's file. */
export function applyFile(repoRoot: string | null, path: string): InstructionsWrite {
  return {
    op: () => api.applyInstructions(repoRoot, path),
    ok: 'Applied — restart that agent to pick it up.'
  }
}

/**
 * The other side of drift: the file is the newer one — a teammate's update that arrived
 * in the repo's own files with a pull.
 */
export function takeFile(repoRoot: string | null, path: string): InstructionsWrite {
  return {
    op: () => api.adoptInstructionsFrom(repoRoot, path),
    ok: "Taken as the baseline — it's yours now."
  }
}
