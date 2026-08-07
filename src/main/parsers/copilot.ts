import { basename, dirname, join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import {
  capText,
  readJson,
  readJsonlTail,
  readHead,
  parseJsonlText,
  fileTimes,
  toMs,
  contentToText,
  truncate,
  walkFiles
} from './util'

/**
 * Copilot CLI sessions (current layout): <configDir>/session-state/<uuid>/events.jsonl
 * events.jsonl lines: { type: "session.start"|"user.message"|"assistant.message"|"tool.execution_start"|..., data, timestamp }
 * session.start carries full context: cwd, repository (owner/repo), branch.
 *
 * Legacy layouts (history-session-state/*.json, sessions/*.json) are still parsed best-effort.
 *
 * IMPORTANT: ~/.copilot also holds multi-GB non-session data (pkg/, repos/, logs/, data.db).
 * Only the roots below may ever be walked or watched.
 */
export function listCopilotSessionRoots(sourceDir: string): string[] {
  return [
    join(sourceDir, 'session-state'),
    join(sourceDir, 'history-session-state'),
    join(sourceDir, 'sessions')
  ]
}

/** Meta parsing reads at most this much of an events.jsonl (metadata lives up front). */
const META_HEAD_BYTES = 256 * 1024

export function listCopilotSessionFiles(sourceDir: string): string[] {
  const out: string[] = []
  const stateRoot = join(sourceDir, 'session-state')
  if (existsSync(stateRoot)) {
    let dirs: string[] = []
    try {
      dirs = readdirSync(stateRoot)
    } catch {
      /* ignore */
    }
    for (const d of dirs) {
      const ev = join(stateRoot, d, 'events.jsonl')
      if (existsSync(ev)) out.push(ev)
    }
  }
  for (const legacy of [join(sourceDir, 'history-session-state'), join(sourceDir, 'sessions')]) {
    out.push(...walkFiles(legacy, 3).filter((f) => f.endsWith('.json')))
  }
  return out
}

export function listCopilotSessions(sourceDir: string, sourceLabel: string): SessionMeta[] {
  const out: SessionMeta[] = []
  const seen = new Set<string>()
  for (const file of listCopilotSessionFiles(sourceDir)) {
    const meta = parseCopilotMeta(file, sourceLabel)
    if (meta && !seen.has(meta.id)) {
      seen.add(meta.id)
      out.push(meta)
    }
  }
  return out
}

export function parseCopilotMeta(file: string, sourceLabel: string): SessionMeta | null {
  if (file.endsWith('events.jsonl')) return parseEventsMeta(file, sourceLabel)
  return parseLegacyMeta(file, sourceLabel)
}

/**
 * The generated session name lives in workspace.yaml next to events.jsonl
 * (`name: Instructions access inquiry`). Line-based extraction — no YAML dep.
 */
export function copilotWorkspaceFile(eventsFile: string): string {
  return join(dirname(eventsFile), 'workspace.yaml')
}

function workspaceName(eventsFile: string): string {
  let raw: string
  try {
    raw = readFileSync(copilotWorkspaceFile(eventsFile), 'utf8')
  } catch {
    return ''
  }
  const m = raw.match(/^name:[ \t]*(.+)$/m)
  if (!m) return ''
  let v = m[1].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  return v
}

function parseEventsMeta(file: string, sourceLabel: string): SessionMeta | null {
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  const events = parseJsonlText(head.text, head.truncated)
  if (events.length === 0) return null

  let nativeId = basename(dirname(file))
  let cwd: string | null = null
  let gitBranch: string | null = null
  let repoFullName: string | null = null
  let title = ''
  let firstTs: number | null = null
  let messageCount = 0
  let sawStart = false

  for (const ev of events) {
    const ts = toMs(ev.timestamp)
    if (ts && !firstTs) firstTs = ts
    if (ev.type === 'session.start' && ev.data) {
      sawStart = true
      if (ev.data.sessionId) nativeId = String(ev.data.sessionId)
      const ctx = ev.data.context ?? {}
      if (typeof ctx.cwd === 'string') cwd = ctx.cwd
      if (typeof ctx.branch === 'string') gitBranch = ctx.branch
      if (typeof ctx.repository === 'string' && ctx.repository.includes('/'))
        repoFullName = ctx.repository
      if (!firstTs) firstTs = toMs(ev.data.startTime)
    } else if (ev.type === 'user.message' || ev.type === 'assistant.message') {
      messageCount++
      if (!title && ev.type === 'user.message') {
        const t = typeof ev.data?.content === 'string' ? ev.data.content : contentToText(ev.data?.content)
        if (t) title = truncate(t)
      }
    }
  }
  // Truncated head: extrapolate the count so big sessions don't show "2 msgs"
  if (head.truncated && messageCount > 0) {
    messageCount = Math.max(messageCount, Math.round((messageCount * head.size) / META_HEAD_BYTES))
  }
  // A session whose first user message falls past the head cap is still a session —
  // session.start alone (cwd/repo/branch known) is enough to index it.
  if (!sawStart && messageCount === 0 && !title) return null

  const generated = workspaceName(file)
  if (generated) title = truncate(generated)

  const ft = fileTimes(file)
  return {
    id: `copilot:${nativeId}`,
    provider: 'copilot',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd,
    gitBranch,
    repoFullName,
    startedAt: firstTs ?? ft.start,
    updatedAt: ft.end,
    messageCount,
    sourcePath: file
  }
}

function extractTimeline(j: any): any[] {
  for (const key of ['timeline', 'messages', 'chatMessages', 'events', 'history']) {
    if (Array.isArray(j?.[key])) return j[key]
  }
  return []
}

function itemRole(m: any): 'user' | 'assistant' | 'tool' {
  const r = (m?.role ?? m?.sender ?? m?.type ?? '').toString().toLowerCase()
  if (r.includes('user')) return 'user'
  if (r.includes('tool')) return 'tool'
  return 'assistant'
}

function itemText(m: any): string {
  if (typeof m?.content === 'string') return m.content
  const c = contentToText(m?.content)
  if (c) return c
  for (const k of ['text', 'message', 'body']) {
    if (typeof m?.[k] === 'string') return m[k]
  }
  return ''
}

function parseLegacyMeta(file: string, sourceLabel: string): SessionMeta | null {
  const j = readJson(file)
  if (!j || typeof j !== 'object') return null
  const timeline = extractTimeline(j)
  const nativeId = String(
    j.sessionId ?? j.id ?? basename(dirname(file)) ?? basename(file, '.json')
  )
  if (!j.sessionId && !j.id && timeline.length === 0) return null

  let title = typeof j.title === 'string' ? j.title : typeof j.summary === 'string' ? j.summary : ''
  let messageCount = 0
  for (const m of timeline) {
    const role = itemRole(m)
    if (role === 'user' || role === 'assistant') {
      messageCount++
      if (!title && role === 'user') {
        const t = itemText(m)
        if (t) title = truncate(t)
      }
    }
  }
  if (messageCount === 0 && !j.sessionId) return null

  const ft = fileTimes(file)
  return {
    id: `copilot:${nativeId}`,
    provider: 'copilot',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd: typeof j.cwd === 'string' ? j.cwd : typeof j.workingDirectory === 'string' ? j.workingDirectory : null,
    gitBranch: typeof j.branch === 'string' ? j.branch : null,
    startedAt: toMs(j.startTime ?? j.createdAt) ?? ft.start,
    updatedAt: toMs(j.updatedAt ?? j.endTime) ?? ft.end,
    messageCount,
    sourcePath: file
  }
}

export function parseCopilotMessages(file: string): SessionMessage[] {
  if (file.endsWith('events.jsonl')) {
    const { lines, truncated } = readJsonlTail(file)
    const out: SessionMessage[] = []
    if (truncated) {
      out.push({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
    }
    for (const ev of lines) {
      const ts = toMs(ev.timestamp) ?? undefined
      if (ev.type === 'user.message' || ev.type === 'assistant.message') {
        const text =
          typeof ev.data?.content === 'string' ? ev.data.content : contentToText(ev.data?.content)
        if (text)
          out.push({ role: ev.type === 'user.message' ? 'user' : 'assistant', kind: 'text', text: capText(text), ts })
      } else if (ev.type === 'tool.execution_start') {
        out.push({
          role: 'assistant',
          kind: 'tool_call',
          toolName: String(ev.data?.toolName ?? ev.data?.name ?? 'tool'),
          text: truncate(JSON.stringify(ev.data?.arguments ?? ev.data?.input ?? ''), 400),
          ts
        })
      } else if (ev.type === 'system.message') {
        const text = typeof ev.data?.content === 'string' ? ev.data.content : ''
        if (text) out.push({ role: 'system', kind: 'system', text: truncate(text, 200), ts })
      }
    }
    return out
  }

  const j = readJson(file)
  if (!j) return []
  const out: SessionMessage[] = []
  for (const m of extractTimeline(j)) {
    const text = itemText(m)
    const role = itemRole(m)
    const ts = toMs(m?.timestamp ?? m?.ts) ?? undefined
    const toolName = typeof m?.toolName === 'string' ? m.toolName : typeof m?.tool === 'string' ? m.tool : undefined
    if (toolName) {
      out.push({ role: 'assistant', kind: 'tool_call', toolName, text: truncate(text || '(tool)', 400), ts })
    } else if (text) {
      out.push({ role, kind: 'text', text, ts })
    }
  }
  return out
}
