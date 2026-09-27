import type { SessionMessage } from '../../shared/types'

/** A transcript row: a message under the key chat-log.ts minted for it. */
export type Row = {
  readonly m: SessionMessage
  readonly key: number
  /** The tool_result answering this tool_call — mutable: `transcriptRows` folds it in
   *  after the row is pushed */
  result?: SessionMessage
}

/**
 * The newest `limit` rows as the transcript draws them. Providers repeat identical
 * system notices; consecutive duplicates add nothing. Each row renders under the key
 * chat-log.ts minted for it — stable across a re-read of the log, even one that starts
 * further in, and when the dedup filter drops rows in the middle. A tool call and the
 * result that answers it are one event: the result folds into the call's row (its key
 * stays the call's) instead of a second ↳ row.
 */
export function transcriptRows(
  log: readonly SessionMessage[],
  keys: readonly number[],
  limit: number
): { readonly shown: number; readonly visible: readonly Row[] } {
  const sliced = log.length > limit ? log.slice(-limit) : log
  const base = log.length - sliced.length
  const visible: Row[] = []
  sliced.forEach((m, i) => {
    if (m.kind === 'system' && sliced[i - 1]?.kind === 'system' && sliced[i - 1].text === m.text)
      return
    const prev = visible[visible.length - 1]
    if (m.kind === 'tool_result' && prev?.m.kind === 'tool_call' && !prev.result) {
      prev.result = m
      return
    }
    visible.push({ m, key: keys[base + i] ?? base + i })
  })
  return { shown: sliced.length, visible }
}

/** A transcript row, or a folded run of consecutive tool rows. */
export type Block = { readonly kind: 'row'; readonly row: Row } | { readonly kind: 'run'; readonly rows: readonly Row[] }

/** Four is where a run stops reading as "a couple of steps" and starts as a wall. */
const FOLD_AT = 4

/** A question the agent is still waiting on: never folded away, never a one-liner. */
export function isPendingAsk(row: Row): boolean {
  return row.m.kind === 'tool_call' && !!row.m.asks?.length && !row.result
}

export function foldToolRuns(rows: readonly Row[], busy: boolean): Block[] {
  const out: Block[] = []
  let run: Row[] = []
  const flush = (last: boolean): void => {
    // the tail run of a live turn stays open: that is the work you are watching
    if (run.length >= FOLD_AT && !(busy && last)) out.push({ kind: 'run', rows: run })
    else for (const row of run) out.push({ kind: 'row', row })
    run = []
  }
  for (const row of rows) {
    // a plan is a message of its own, like the agent's prose: it is never folded away
    const foldable = !isPendingAsk(row) && row.m.artifact?.kind !== 'plan'
    if ((row.m.kind === 'tool_call' || row.m.kind === 'tool_result') && foldable) run.push(row)
    else {
      flush(false)
      out.push({ kind: 'row', row })
    }
  }
  flush(true)
  return out
}

/** "6 steps · Bash ×3 · Edit ×2 · Read" — what the run did, in the order it did it. */
export function runSummary(rows: readonly Row[]): string {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const name = r.m.kind === 'tool_call' ? (r.m.toolName ?? 'tool') : 'result'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const tools = [...counts]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .slice(0, 4)
    .join(' · ')
  return `${rows.length} steps · ${tools}`
}
