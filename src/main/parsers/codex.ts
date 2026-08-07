import { basename, join } from 'node:path'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import {
  capText,
  contentToText,
  fileTimes,
  parseJsonlText,
  readHead,
  readJsonlTail,
  toMs,
  truncate,
  walkFiles
} from './util'

/** session_meta and the first prompt live up front — never read the whole rollout. */
const META_HEAD_BYTES = 256 * 1024

/**
 * Codex CLI sessions: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Lines: { timestamp, type: "session_meta"|"response_item"|"event_msg"|..., payload }
 */
/** Only these dirs get walked/watched — never the whole config dir. */
export function listCodexSessionRoots(sourceDir: string): string[] {
  return [join(sourceDir, 'sessions')]
}

export function listCodexSessionFiles(sourceDir: string): string[] {
  return walkFiles(join(sourceDir, 'sessions'), 5).filter((f) => f.endsWith('.jsonl'))
}

export function listCodexSessions(sourceDir: string, sourceLabel: string): SessionMeta[] {
  const files = listCodexSessionFiles(sourceDir)
  const out: SessionMeta[] = []
  for (const file of files) {
    const meta = parseCodexMeta(file, sourceLabel)
    if (meta) out.push(meta)
  }
  return out
}

export function parseCodexMeta(file: string, sourceLabel: string): SessionMeta | null {
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  const lines = parseJsonlText(head.text, head.truncated)
  if (lines.length === 0) return null

  let nativeId = basename(file, '.jsonl')
  let cwd: string | null = null
  let gitBranch: string | null = null
  let title = ''
  let firstTs: number | null = null
  let lastTs: number | null = null
  let messageCount = 0

  for (const l of lines) {
    const ts = toMs(l.timestamp)
    if (ts) {
      if (!firstTs) firstTs = ts
      lastTs = ts
    }
    const p = l.payload ?? l
    if (l.type === 'session_meta' || p?.originator) {
      if (p.id) nativeId = String(p.id)
      if (p.cwd) cwd = p.cwd
      if (p.git?.branch) gitBranch = p.git.branch
    }
    const isMessage =
      (l.type === 'response_item' && p?.type === 'message') ||
      (l.type === 'event_msg' && (p?.type === 'user_message' || p?.type === 'agent_message'))
    if (isMessage) {
      messageCount++
      const role = p.role ?? (p.type === 'user_message' ? 'user' : 'assistant')
      if (!title && role === 'user') {
        const t = contentToText(p.content) || (typeof p.message === 'string' ? p.message : '')
        if (t && !t.startsWith('<')) title = truncate(t)
      }
    }
  }
  if (messageCount === 0) return null
  if (head.truncated) {
    messageCount = Math.max(messageCount, Math.round((messageCount * head.size) / META_HEAD_BYTES))
  }

  const ft = fileTimes(file)
  return {
    id: `codex:${nativeId}`,
    provider: 'codex',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd,
    gitBranch,
    startedAt: firstTs ?? ft.start,
    updatedAt: head.truncated ? ft.end : (lastTs ?? ft.end),
    messageCount,
    sourcePath: file
  }
}

export function parseCodexMessages(file: string): SessionMessage[] {
  const { lines, truncated } = readJsonlTail(file)
  const out: SessionMessage[] = []
  if (truncated) {
    out.push({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
  }
  for (const l of lines) {
    const ts = toMs(l.timestamp) ?? undefined
    const p = l.payload ?? l
    if (l.type === 'response_item') {
      switch (p?.type) {
        case 'message': {
          const text = contentToText(p.content)
          if (text)
            out.push({ role: p.role === 'user' ? 'user' : 'assistant', kind: 'text', text: capText(text), ts })
          break
        }
        case 'function_call':
          out.push({
            role: 'assistant',
            kind: 'tool_call',
            toolName: p.name ?? 'tool',
            text: truncate(String(p.arguments ?? ''), 400),
            ts
          })
          break
        case 'function_call_output':
          out.push({
            role: 'tool',
            kind: 'tool_result',
            text: truncate(typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? ''), 400),
            ts
          })
          break
        case 'reasoning': {
          const t = contentToText(p.summary) || contentToText(p.content)
          if (t) out.push({ role: 'assistant', kind: 'reasoning', text: truncate(t, 400), ts })
          break
        }
      }
    } else if (l.type === 'event_msg') {
      if (p?.type === 'user_message' && p.message)
        out.push({ role: 'user', kind: 'text', text: String(p.message), ts })
      if (p?.type === 'agent_message' && p.message)
        out.push({ role: 'assistant', kind: 'text', text: String(p.message), ts })
    }
  }
  return out
}
