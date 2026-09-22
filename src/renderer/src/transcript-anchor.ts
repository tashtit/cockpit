import type { SessionMessage } from '../../shared/types'
import type { TranscriptAnchor } from './chat-binding'

/**
 * Which message of an open transcript a transcript-search hit meant.
 *
 * The search names a message by what it said — a snippet windowed around the match,
 * whitespace collapsed, an ellipsis at whichever edge was cut — and by who said it and
 * when. It cannot name it by index: the searcher and the chat's parser count messages
 * differently (one collapses Codex's echoed items, the other folds tool results into
 * their calls), so an index would not survive the trip. The words survive it.
 *
 * Returns the message's index in `log`, or -1 when nothing in it says those words —
 * a transcript that changed since the search, or a hit on something the chat does not
 * render. The chat then opens at the bottom as it always did.
 */
export function findAnchor(log: readonly SessionMessage[], anchor: TranscriptAnchor): number {
  const core = collapse(anchor.snippet.replace(/^…/, '').replace(/…$/, ''))
  if (!core) return -1
  // exact words first, then any case, then any speaker: the search read the same file,
  // so an exact match is the normal case and the fallbacks are for a log that moved
  const passes: ReadonlyArray<{ readonly role: boolean; readonly exact: boolean }> = [
    { role: true, exact: true },
    { role: true, exact: false },
    { role: false, exact: false }
  ]
  const lowered = core.toLowerCase()
  for (const pass of passes) {
    const found: number[] = []
    log.forEach((m, i) => {
      if (pass.role && !speaks(m, anchor.role)) return
      const text = collapse(m.text)
      if (pass.exact ? text.includes(core) : text.toLowerCase().includes(lowered)) found.push(i)
    })
    if (found.length === 0) continue
    if (found.length === 1 || anchor.timestamp === null) return found[found.length - 1]
    // the same words said twice: the one said nearest the hit's own time
    let best = found[found.length - 1]
    let gap = Infinity
    for (const i of found) {
      const ts = log[i].ts
      const d = typeof ts === 'number' ? Math.abs(ts - anchor.timestamp) : Infinity
      if (d < gap) {
        gap = d
        best = i
      }
    }
    return best
  }
  return -1
}

/** The search's roles against the chat's: `tool` covers a call and its result alike. */
function speaks(m: SessionMessage, role: TranscriptAnchor['role']): boolean {
  if (role === 'tool') return m.kind === 'tool_call' || m.kind === 'tool_result' || m.role === 'tool'
  if (role === 'user') return m.role === 'user'
  return m.role === 'assistant' && m.kind !== 'tool_call' && m.kind !== 'tool_result'
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()
