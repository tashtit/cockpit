import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A Codex thread paginated into a second rollout, the shape Codex Desktop writes:
 * the new file is named `<thread>_<page>`, carries the same session id, and its
 * `session_meta.history_base` says the thread's history is the first file up to
 * `end_byte_offset`. The first file holds a turn past that byte — one the thread
 * abandoned — which no reader may show as part of the thread.
 */
export type PagedThread = {
  readonly threadId: string
  readonly page1: string
  readonly page2: string
  /** Where the thread's history in page 1 ends */
  readonly endByte: number
}

const line = (o: unknown): string => JSON.stringify(o) + '\n'

function message(ts: string, role: 'user' | 'assistant', text: string): string {
  const type = role === 'user' ? 'input_text' : 'output_text'
  return line({ timestamp: ts, type: 'response_item', payload: { type: 'message', role, content: [{ type, text }] } })
}

export function writePagedThread(codexDir: string, cwd: string, threadId = 'thr-paged'): PagedThread {
  const day1 = join(codexDir, 'sessions', '2026', '09', '01')
  const day2 = join(codexDir, 'sessions', '2026', '09', '02')
  mkdirSync(day1, { recursive: true })
  mkdirSync(day2, { recursive: true })

  const kept =
    line({
      timestamp: '2026-09-01T10:00:00Z',
      type: 'session_meta',
      payload: { id: threadId, session_id: threadId, cwd, history_mode: 'paginated', thread_source: 'user' }
    }) +
    message('2026-09-01T10:00:01Z', 'user', 'first question about pagination') +
    message('2026-09-01T10:00:05Z', 'assistant', 'first answer')
  const abandoned =
    message('2026-09-01T10:05:00Z', 'user', 'abandoned turn') +
    line({ timestamp: '2026-09-01T10:05:01Z', type: 'event_msg', payload: { type: 'turn_aborted' } })
  const page1 = join(day1, `rollout-2026-09-01T10-00-00-${threadId}.jsonl`)
  writeFileSync(page1, kept + abandoned)
  const endByte = Buffer.byteLength(kept)

  const page2 = join(day2, `rollout-2026-09-02T09-00-00-${threadId}_page-2.jsonl`)
  writeFileSync(
    page2,
    line({
      timestamp: '2026-09-02T09:00:00Z',
      type: 'session_meta',
      payload: {
        id: threadId,
        session_id: threadId,
        cwd,
        history_mode: 'paginated',
        history_base: { thread_id: threadId, end_ordinal_exclusive: 3, end_byte_offset: endByte }
      }
    }) +
      message('2026-09-02T09:00:01Z', 'user', 'second question') +
      message('2026-09-02T09:00:05Z', 'assistant', 'second answer')
  )
  return { threadId, page1, page2, endByte }
}
