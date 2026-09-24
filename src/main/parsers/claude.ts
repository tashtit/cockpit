import { basename, join, sep } from 'node:path'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import { parseAsks } from '../../shared/asks'
import { toolArtifact } from './artifacts'
import {
  capText,
  contentToText,
  fileTimes,
  parseJsonlText,
  readHead,
  readJsonlTail,
  readTail,
  toMs,
  toolPreview,
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
  // a truncated head can legitimately yield nothing (one preamble line larger than
  // the window) — the tail pass below still gets a chance to identify the session
  if (lines.length === 0 && !head.truncated) return null
  const nativeId = basename(file, '.jsonl')

  let cwd: string | null = null
  let logBranch: string | null = null
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

  const scan = (l: any): void => {
    if (sidechain === null && typeof l.isSidechain === 'boolean') sidechain = l.isSidechain
    // strings only: a cwd of another type reached the repo resolver and threw there,
    // outside the parser's own failure tolerance, on every scan
    if (typeof l.cwd === 'string' && l.cwd && !cwd) cwd = l.cwd
    if (typeof l.gitBranch === 'string' && l.gitBranch && !logBranch) logBranch = l.gitBranch
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

  for (const l of lines) scan(l)

  if (head.truncated) {
    const tail = readTail(file, TITLE_TAIL_BYTES)
    const tailLines = tail.text
      ? parseJsonlText(tail.truncated ? tail.text.slice(tail.text.indexOf('\n') + 1) : tail.text, false)
      : []
    // Messages can sit entirely past the head window when the file opens with a
    // large preamble (summary / file-history-snapshot entries). The tail is then
    // the only evidence this is a session at all, so count and extrapolate there.
    const fromTail = messageCount === 0
    // the tail is the wrong place to learn when a session STARTED — a head made
    // only of summary/snapshot lines carries no timestamps, so adopting the
    // tail's would collapse startedAt onto updatedAt. Keep the head's verdict.
    const headFirstTs = firstTs
    if (fromTail) for (const l of tailLines) scan(l)
    // otherwise just the titles: the current one may have been re-appended late
    else for (const l of tailLines) scanTitles(l)
    firstTs = headFirstTs
    // scale by the window the count actually came from, over the region that
    // window represents — the head covers the file from byte 0, while the tail
    // only speaks for the part the head already proved holds no messages
    const window = fromTail ? TITLE_TAIL_BYTES : META_HEAD_BYTES
    const span = fromTail ? Math.max(0, head.size - META_HEAD_BYTES) : head.size
    messageCount = Math.max(messageCount, Math.round((messageCount * span) / window))
  }
  if (sidechain || messageCount === 0) return null
  const title = truncate(customTitle || aiTitle || summary || firstPrompt)

  const ft = fileTimes(file)
  return {
    id: `claude:${nativeId}`,
    provider: 'claude',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd,
    logBranch,
    startedAt: firstTs ?? ft.start,
    // truncated head can't see the last line's timestamp — mtime is the truth anyway
    updatedAt: head.truncated ? ft.end : (lastTs ?? ft.end),
    messageCount,
    sourcePath: file
  }
}

/**
 * What a call's result says about the call itself: a refused or failed call is marked
 * (an edit that never landed must not read as one), and a created task learns the
 * number Claude gave it — `Task #3 created successfully` — which is what later
 * TaskUpdate calls name it by.
 */
function answered(call: SessionMessage, result: string, isError: boolean): SessionMessage {
  if (isError) return { ...call, failed: true }
  const a = call.artifact
  if (a?.kind !== 'task-add') return call
  const ids = [...result.matchAll(/Task #(\w+)/g)].map((m) => m[1]!)
  return ids.length === a.items.length ? { ...call, artifact: { ...a, ids } } : call
}

export function parseClaudeMessages(file: string): SessionMessage[] {
  const { lines, truncated } = readJsonlTail(file)
  const out: SessionMessage[] = []
  if (truncated) {
    out.push({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
  }
  // where each call's row sits: a result answers its call by id, and parallel calls
  // put several results after several calls, so adjacency would pair them wrong
  const callRows = new Map<string, number>()
  for (const l of lines) {
    const ts = toMs(l.timestamp) ?? undefined
    if (l.type === 'user' || l.type === 'assistant') {
      const content = l.message?.content
      const text = contentToText(content)
      if (text) out.push({ role: l.type, kind: 'text', text: capText(text), ts })
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_use') {
            const preview = toolPreview(b.name ?? 'tool', b.input)
            const asks = parseAsks(b.name ?? '', b.input)
            const artifact = toolArtifact(b.name ?? '', b.input)
            if (typeof b.id === 'string') callRows.set(b.id, out.length)
            out.push({
              role: 'assistant',
              kind: 'tool_call',
              toolName: b.name ?? 'tool',
              text: truncate(JSON.stringify(b.input ?? {}), 400),
              ...(preview ? { preview: truncate(preview, 200) } : {}),
              ...(asks ? { asks } : {}),
              ...(artifact ? { artifact } : {}),
              ts
            })
          }
          if (b?.type === 'tool_result') {
            const text = contentToText(b.content)
            const at = typeof b.tool_use_id === 'string' ? callRows.get(b.tool_use_id) : undefined
            if (at !== undefined) out[at] = answered(out[at]!, text, b.is_error === true)
            out.push({ role: 'tool', kind: 'tool_result', text: truncate(text || '(result)', 400), ts })
          }
        }
      }
    } else if (l.type === 'system' && typeof l.content === 'string') {
      out.push({ role: 'system', kind: 'system', text: truncate(l.content, 200), ts })
    }
  }
  return out
}
