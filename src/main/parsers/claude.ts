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

/** Meta lives in the first lines (summary/cwd/branch/first prompt) — never read the whole log. */
const META_HEAD_BYTES = 256 * 1024

/**
 * Claude Code sessions: <configDir>/projects/<sanitized-cwd>/<session-uuid>.jsonl
 * Each line: { type: "user"|"assistant"|"summary"|"system"|..., message?, timestamp?, sessionId?, cwd?, gitBranch? }
 */
/** Only these dirs get walked/watched — never the whole config dir. */
export function listClaudeSessionRoots(sourceDir: string): string[] {
  return [join(sourceDir, 'projects')]
}

export function listClaudeSessionFiles(sourceDir: string): string[] {
  return walkFiles(join(sourceDir, 'projects'), 3).filter((f) => f.endsWith('.jsonl'))
}

export function listClaudeSessions(sourceDir: string, sourceLabel: string): SessionMeta[] {
  const files = listClaudeSessionFiles(sourceDir)
  const out: SessionMeta[] = []
  for (const file of files) {
    const meta = parseClaudeMeta(file, sourceLabel)
    if (meta) out.push(meta)
  }
  return out
}

export function parseClaudeMeta(file: string, sourceLabel: string): SessionMeta | null {
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  const lines = parseJsonlText(head.text, head.truncated)
  if (lines.length === 0) return null
  const nativeId = basename(file, '.jsonl')

  let cwd: string | null = null
  let gitBranch: string | null = null
  let title = ''
  let firstTs: number | null = null
  let lastTs: number | null = null
  let messageCount = 0

  for (const l of lines) {
    if (l.cwd && !cwd) cwd = l.cwd
    if (l.gitBranch && !gitBranch) gitBranch = l.gitBranch
    const ts = toMs(l.timestamp)
    if (ts) {
      if (!firstTs) firstTs = ts
      lastTs = ts
    }
    if (l.type === 'summary' && typeof l.summary === 'string') title = l.summary
    if (l.type === 'user' || l.type === 'assistant') {
      messageCount++
      if (!title && l.type === 'user') {
        const t = contentToText(l.message?.content)
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
    id: `claude:${nativeId}`,
    provider: 'claude',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd,
    gitBranch,
    startedAt: firstTs ?? ft.start,
    // truncated head can't see the last line's timestamp — mtime is the truth anyway
    updatedAt: head.truncated ? ft.end : (lastTs ?? ft.end),
    messageCount,
    sourcePath: file
  }
}

export function parseClaudeMessages(file: string): SessionMessage[] {
  const { lines, truncated } = readJsonlTail(file)
  const out: SessionMessage[] = []
  if (truncated) {
    out.push({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
  }
  for (const l of lines) {
    const ts = toMs(l.timestamp) ?? undefined
    if (l.type === 'user' || l.type === 'assistant') {
      const content = l.message?.content
      const text = contentToText(content)
      if (text) out.push({ role: l.type, kind: 'text', text: capText(text), ts })
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_use')
            out.push({
              role: 'assistant',
              kind: 'tool_call',
              toolName: b.name ?? 'tool',
              text: truncate(JSON.stringify(b.input ?? {}), 400),
              ts
            })
          if (b?.type === 'tool_result')
            out.push({
              role: 'tool',
              kind: 'tool_result',
              text: truncate(contentToText(b.content) || '(result)', 400),
              ts
            })
        }
      }
    } else if (l.type === 'system' && typeof l.content === 'string') {
      out.push({ role: 'system', kind: 'system', text: truncate(l.content, 200), ts })
    }
  }
  return out
}
