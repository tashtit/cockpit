import { basename, join, sep } from 'node:path'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import {
  capText,
  contentToText,
  fileTimes,
  parseJsonlText,
  readHead,
  readJsonlTail,
  readTail,
  toMs,
  truncate,
  walkFiles
} from './util'

/** Meta lives in the first lines (summary/cwd/branch/first prompt) — never read the whole log. */
const META_HEAD_BYTES = 256 * 1024
/** Title lines are re-appended as the session grows — the newest ones live near the end. */
const TITLE_TAIL_BYTES = 64 * 1024

/**
 * Claude Code sessions: <configDir>/projects/<sanitized-cwd>/<session-uuid>.jsonl
 * Each line: { type: "user"|"assistant"|"summary"|"system"|..., message?, timestamp?, sessionId?, cwd?, gitBranch? }
 */
/** Only these dirs get walked/watched — never the whole config dir. */
export function listClaudeSessionRoots(sourceDir: string): string[] {
  return [join(sourceDir, 'projects')]
}

export function listClaudeSessionFiles(sourceDir: string): string[] {
  return walkFiles(join(sourceDir, 'projects'), 3).filter(
    // <proj>/<session-id>/subagents/**: sidechain transcripts (Task-tool agents,
    // workflow runs) — parts of a session, never sessions themselves
    (f) => f.endsWith('.jsonl') && !f.includes(`${sep}subagents${sep}`)
  )
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
  // Generated names: custom-title (user-set) beats ai-title beats legacy summary
  // beats first-prompt fallback. Later lines supersede earlier ones.
  let customTitle = ''
  let aiTitle = ''
  let summary = ''
  let firstPrompt = ''
  let firstTs: number | null = null
  let lastTs: number | null = null
  let messageCount = 0

  const scanTitles = (l: any): void => {
    if (l.type === 'custom-title' && typeof l.customTitle === 'string') customTitle = l.customTitle
    if (l.type === 'ai-title' && typeof l.aiTitle === 'string') aiTitle = l.aiTitle
    if (l.type === 'summary' && typeof l.summary === 'string') summary = l.summary
  }

  // Sidechain FILES (Task-tool/workflow agents) mark lines isSidechain from the
  // first entry; older CLIs also inlined sidechain lines into real sessions, so
  // only the first flag decides — a true after a false is an inline, not a file.
  let sidechain: boolean | null = null

  for (const l of lines) {
    if (sidechain === null && typeof l.isSidechain === 'boolean') sidechain = l.isSidechain
    if (l.cwd && !cwd) cwd = l.cwd
    if (l.gitBranch && !gitBranch) gitBranch = l.gitBranch
    const ts = toMs(l.timestamp)
    if (ts) {
      if (!firstTs) firstTs = ts
      lastTs = ts
    }
    scanTitles(l)
    if (l.type === 'user' || l.type === 'assistant') {
      messageCount++
      if (!firstPrompt && l.type === 'user') {
        const t = contentToText(l.message?.content)
        if (t && !t.startsWith('<')) firstPrompt = truncate(t)
      }
    }
  }
  if (sidechain || messageCount === 0) return null
  if (head.truncated) {
    messageCount = Math.max(messageCount, Math.round((messageCount * head.size) / META_HEAD_BYTES))
    // The current title may have been re-appended past the head window — check the tail.
    const tail = readTail(file, TITLE_TAIL_BYTES)
    if (tail.text) {
      const text = tail.truncated ? tail.text.slice(tail.text.indexOf('\n') + 1) : tail.text
      for (const l of parseJsonlText(text, false)) scanTitles(l)
    }
  }
  const title = truncate(customTitle || aiTitle || summary || firstPrompt)

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
