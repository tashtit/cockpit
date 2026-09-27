import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import { toolArtifact } from './artifacts'
import {
  capText,
  fileTimes,
  jsonText,
  parseJsonlText,
  readHead,
  readJsonlTail,
  toolPreview,
  truncate,
  usableCwd
} from './util'

/** Meta lives in the first lines (the opening query, the first tool calls' paths). */
const META_HEAD_BYTES = 256 * 1024
/** Directories one slug lookup may list before it gives up — the walk is a fallback. */
const MAX_SLUG_LISTINGS = 256
const MAX_SLUG_DEPTH = 16

/**
 * Cursor's agent transcripts: <home>/projects/<slug>/agent-transcripts/<id>/<id>.jsonl,
 * where <slug> is the workspace path with every run of non-alphanumerics turned into
 * `-` (`/Users/me/.cursor/wt` → `Users-me-cursor-wt`) and subagents write beside the
 * parent under `subagents/`. Each line is `{role: user|assistant, message: {content}}`
 * with Anthropic-style blocks (`text`, `tool_use` — no ids, no results), or
 * `{type: "turn_ended", status, error?}`. The opening query carries its own time:
 * `<timestamp>Wednesday, Aug 19, 2026, 12:56 AM (UTC+3)</timestamp>`.
 */
export function listCursorSessionRoots(home: string): string[] {
  return [join(home, 'projects')]
}

export function listCursorSessionFiles(home: string): string[] {
  const projects = join(home, 'projects')
  const out: string[] = []
  for (const project of dirEntries(projects)) {
    if (!project.isDirectory()) continue
    const dir = join(projects, project.name, 'agent-transcripts')
    for (const e of dirEntries(dir)) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(join(dir, e.name))
      else if (e.isDirectory()) {
        const file = join(dir, e.name, `${e.name}.jsonl`)
        if (existsSync(file)) out.push(file)
      }
    }
  }
  return out
}

export function listCursorSessions(home: string, sourceLabel: string): SessionMeta[] {
  return listCursorSessionFiles(home).flatMap((f) => parseCursorMeta(f, sourceLabel) ?? [])
}

function dirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** A path as Cursor names its project folder. */
export function cursorSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** The project folder a transcript sits in: `<slug>/agent-transcripts/[<id>/]<id>.jsonl`. */
function projectSlug(file: string): string | null {
  const parts = file.split(sep)
  const at = parts.lastIndexOf('agent-transcripts')
  return at > 0 ? parts[at - 1]! : null
}

/** Slugs resolved (or found unresolvable) by walking the disk — the walk is not cheap. */
const walked = new Map<string, string | null>()

/**
 * The directory a slug was made from. The slug is lossy (`titan.ron` and `titan-ron`
 * look alike), so the paths the agent itself used are asked first — any ancestor of one
 * whose slug matches is the workspace — and only then the disk, one directory level at
 * a time, following the entries whose slug is a prefix of what is left.
 */
export function resolveCursorSlug(slug: string, hints: readonly string[] = []): string | null {
  for (const hint of hints) {
    for (let p = hint; p !== dirname(p); p = dirname(p)) {
      if (cursorSlug(p) === slug) return p
    }
  }
  if (walked.has(slug)) return walked.get(slug)!
  let budget = MAX_SLUG_LISTINGS
  const walk = (dir: string, rest: string, depth: number): string | null => {
    if (depth > MAX_SLUG_DEPTH || budget-- <= 0) return null
    for (const e of dirEntries(dir)) {
      if (!isDirectory(dir, e)) continue
      const s = cursorSlug(e.name)
      if (!s) continue
      if (s === rest) return join(dir, e.name)
      if (rest.startsWith(`${s}-`)) {
        const found = walk(join(dir, e.name), rest.slice(s.length + 1), depth + 1)
        if (found) return found
      }
    }
    return null
  }
  const found = walk(sep, slug, 0)
  walked.set(slug, found)
  return found
}

/** A directory, or a link to one — macOS's `/var` and `/tmp` are links, and a slug is made
 *  from the path as the editor opened it. */
function isDirectory(parent: string, e: Dirent): boolean {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return statSync(join(parent, e.name)).isDirectory()
  } catch {
    return false
  }
}

/** Absolute paths the agent's tool calls named — the best evidence of where it worked. */
function pathHints(lines: readonly any[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    for (const b of Array.isArray(l?.message?.content) ? l.message.content : []) {
      if (b?.type !== 'tool_use' || !b.input || typeof b.input !== 'object') continue
      for (const key of ['path', 'file_path', 'target_directory', 'working_directory', 'cwd']) {
        const v = b.input[key]
        if (typeof v === 'string' && isAbsolute(v)) out.push(v)
      }
      if (out.length >= 8) return out
    }
  }
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** `Aug 19, 2026, 12:56 AM (UTC+3)` → epoch ms; null for anything else. */
export function cursorQueryTime(text: string): number | null {
  const m =
    /<timestamp>[^<]*?([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})\s*(AM|PM)?\s*\((?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\)/.exec(
      text
    )
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!.toLowerCase())
  if (month < 0) return null
  let hour = Number(m[4]) % 12
  if (m[6] === 'PM') hour += 12
  if (!m[6]) hour = Number(m[4])
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8] ?? 0) * 60 + Number(m[9] ?? 0))
  return Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offset * 60_000
}

/** What the person asked: the `<user_query>` inside the wrapper Cursor sends, else the text. */
function queryText(content: unknown): string {
  const text = blocksText(content)
  const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)
  return (q ? q[1]! : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')).trim()
}

/** Text blocks, without the `[REDACTED]` Cursor leaves where hidden reasoning was. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text.replace(/\s*\[REDACTED\]\s*$/, '').replace(/^\[REDACTED\]$/, '') : ''))
    .filter((t: string) => t.trim() !== '')
    .join('\n')
}

export function parseCursorMeta(file: string, sourceLabel: string): SessionMeta | null {
  const slug = projectSlug(file)
  if (!slug || file.includes(`${sep}subagents${sep}`)) return null
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  const lines = parseJsonlText(head.text, head.truncated)
  let firstPrompt = ''
  let startedAt: number | null = null
  let messageCount = 0
  for (const l of lines) {
    if (l?.role !== 'user' && l?.role !== 'assistant') continue
    messageCount++
    if (l.role === 'user' && !firstPrompt) {
      firstPrompt = queryText(l.message?.content)
      startedAt = cursorQueryTime(blocksText(l.message?.content))
    }
  }
  if (head.truncated) {
    messageCount = Math.max(messageCount, Math.round((messageCount * head.size) / META_HEAD_BYTES))
  }
  if (messageCount === 0 || !firstPrompt) return null
  const nativeId = basename(file, '.jsonl')
  const ft = fileTimes(file)
  return {
    id: `cursor:${nativeId}`,
    provider: 'cursor',
    nativeId,
    source: sourceLabel,
    title: truncate(firstPrompt) || '(untitled)',
    cwd: usableCwd(resolveCursorSlug(slug, pathHints(lines))),
    logBranch: null,
    startedAt: startedAt ?? ft.start,
    updatedAt: ft.end,
    messageCount,
    sourcePath: file
  }
}

export function parseCursorMessages(file: string): SessionMessage[] {
  const { lines, truncated } = readJsonlTail(file)
  const out: SessionMessage[] = []
  for (const l of lines) {
    if (l?.role === 'user') {
      const text = queryText(l.message?.content)
      const ts = cursorQueryTime(blocksText(l.message?.content)) ?? undefined
      if (text) out.push({ role: 'user', kind: 'text', text: capText(text), ts })
    } else if (l?.role === 'assistant') {
      const content = l.message?.content
      const text = blocksText(content)
      if (text) out.push({ role: 'assistant', kind: 'text', text: capText(text) })
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type !== 'tool_use') continue
        const name = typeof b.name === 'string' ? b.name : 'tool'
        const preview = toolPreview(name, b.input)
        const artifact = toolArtifact(name, b.input)
        out.push({
          role: 'assistant',
          kind: 'tool_call',
          toolName: name,
          text: truncate(jsonText(b.input ?? {}), 400),
          ...(preview ? { preview: truncate(preview, 200) } : {}),
          ...(artifact ? { artifact } : {})
        })
      }
    } else if (l?.type === 'turn_ended' && l.status !== 'success') {
      const why = typeof l.error === 'string' && l.error.trim() ? l.error : String(l.status ?? 'ended')
      out.push({ role: 'system', kind: 'system', text: truncate(`Turn ended: ${why}`, 200) })
    }
  }
  return truncated
    ? [{ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' }, ...out]
    : out
}
