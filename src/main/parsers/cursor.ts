import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import { toolArtifact } from './artifacts'
import { checkArtifact } from './checks'
import { dbMtime, queryAll, sessionRef, snapshotCache, splitSessionRef } from './sqlite'
import {
  capText,
  fileTimes,
  jsonText,
  parseJsonlText,
  readHead,
  readJsonlTail,
  toMs,
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

/**
 * The editor's own chats live elsewhere: one SQLite key-value store for every workspace,
 * <Cursor app data>/User/globalStorage/state.vscdb, its `cursorDiskKV` table holding a
 * `composerData:<id>` document per chat (its name, times, workspace and the order of its
 * messages) and a `bubbleId:<chat id>:<message id>` document per message. That folder is
 * a home of its own (label `cursor-ide`); a chat is indexed as `<db>#<chat id>`, and a
 * chat that also has an agent transcript shares its id, so the two are one session.
 */
export const CURSOR_IDE_DB = 'state.vscdb'

export function listCursorSessionFiles(home: string): string[] {
  const projects = join(home, 'projects')
  const out: string[] = []
  const db = join(home, CURSOR_IDE_DB)
  if (existsSync(db)) for (const id of composerChats(db).keys()) out.push(sessionRef(db, id))
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
  const ref = splitSessionRef(file)
  if (ref && basename(ref.file) === CURSOR_IDE_DB) return composerMeta(ref.file, ref.id, sourceLabel)
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
  const ref = splitSessionRef(file)
  if (ref && basename(ref.file) === CURSOR_IDE_DB) return composerMessages(ref.file, ref.id)
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

/* ---------- the editor's own chats (state.vscdb) ---------- */

type Composer = {
  readonly name: string | null
  readonly created: number | null
  readonly updated: number | null
  readonly cwd: string | null
  readonly messages: number
  /** the opening message's text, as the chat's own header previews it */
  readonly preview: string | null
  /** the chat that started this one as a subagent (its `subagentComposerIds` name it) */
  readonly parent: string | null
}

/** Every chat with messages in it, from its document's few fields that matter — one read per change. */
const composerChats = snapshotCache((db: string): Map<string, Composer> => {
  const out = new Map<string, Composer>()
  const parents = new Map<string, string>()
  const rows = queryAll(
    db,
    `SELECT key,
       json_extract(value, '$.name') AS name,
       json_extract(value, '$.createdAt') AS created,
       json_extract(value, '$.lastUpdatedAt') AS updated,
       json_extract(value, '$.fullConversationHeadersOnly[#-1].createdAt') AS last,
       json_extract(value, '$.subagentComposerIds') AS subagents,
       json_extract(value, '$.workspaceIdentifier.uri.fsPath') AS cwd,
       coalesce(json_array_length(value, '$.fullConversationHeadersOnly'), 0) AS headers,
       coalesce(json_array_length(value, '$.conversation'), 0) AS inline,
       coalesce(json_extract(value, '$.fullConversationHeadersOnly[0].grouping.textPreview'),
                json_extract(value, '$.conversation[0].text')) AS preview
     FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND json_valid(value)`
  ) ?? []
  for (const r of rows) {
    const id = String(r['key'] ?? '').slice('composerData:'.length)
    for (const child of parseJson(r['subagents']) ?? []) if (typeof child === 'string') parents.set(child, id)
  }
  for (const r of rows) {
    const id = String(r['key'] ?? '').slice('composerData:'.length)
    const messages = Math.max(Number(r['headers'] ?? 0), Number(r['inline'] ?? 0))
    // drafts: every chat Cursor opens starts as one, and most are never sent
    if (!id || messages === 0) continue
    out.set(id, {
      name: typeof r['name'] === 'string' && r['name'].trim() ? r['name'] : null,
      created: toMs(r['created']),
      // the chat's own stamp can lag its last message by minutes
      updated: Math.max(toMs(r['updated']) ?? 0, toMs(r['last']) ?? 0) || null,
      cwd: usableCwd(r['cwd']),
      messages,
      preview: typeof r['preview'] === 'string' && r['preview'].trim() ? r['preview'] : null,
      parent: parents.get(id) ?? null
    })
  }
  return out
})

function composerMeta(db: string, id: string, sourceLabel: string): SessionMeta | null {
  const c = composerChats(db).get(id)
  if (!c) return null
  const at = dbMtime(db)
  return {
    id: `cursor:${id}`,
    provider: 'cursor',
    nativeId: id,
    source: sourceLabel,
    title: truncate(c.name ?? c.preview ?? '') || '(untitled)',
    cwd: c.cwd,
    logBranch: null,
    startedAt: c.created ?? at,
    // never past the store's last write: a clock that ran ahead is not a newer chat
    updatedAt: Math.min(Math.max(c.updated ?? 0, c.created ?? 0) || at, at),
    messageCount: c.messages,
    sourcePath: sessionRef(db, id),
    ...(c.parent ? { parentId: `cursor:${c.parent}` } : {})
  }
}

/** A message document larger than this is not read — context attachments can be huge. */
const MAX_BUBBLE_BYTES = 512 * 1024

function parseJson(v: unknown): any {
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The headline of one of the editor's tool calls: whatever it names. */
function composerToolPreview(params: Record<string, unknown>): string | null {
  return (
    str(params['command']) ??
    str(params['targetFile']) ??
    str(params['relativeWorkspacePath']) ??
    str(params['path']) ??
    str(params['pattern']) ??
    str(params['globPattern']) ??
    str(params['query']) ??
    str(params['url']) ??
    str(params['description'])
  )
}

function composerMessages(db: string, id: string): SessionMessage[] {
  const doc = parseJson(queryAll(db, `SELECT value FROM cursorDiskKV WHERE key = ?`, `composerData:${id}`)?.[0]?.['value'])
  if (!doc) return []
  const headers: any[] = Array.isArray(doc.fullConversationHeadersOnly) ? doc.fullConversationHeadersOnly : []
  // older chats kept every message inside the chat's own document
  const inline: any[] = Array.isArray(doc.conversation) ? doc.conversation : []
  const bubbles = new Map<string, any>()
  if (headers.length > 0) {
    for (const r of queryAll(
      db,
      `SELECT key,
         json_extract(value, '$.type') AS type,
         json_extract(value, '$.text') AS text,
         json_extract(value, '$.createdAt') AS created,
         json_extract(value, '$.thinking.text') AS thinking,
         json_extract(value, '$.toolFormerData') AS tool
       FROM cursorDiskKV WHERE key LIKE ? AND length(value) <= ${MAX_BUBBLE_BYTES}`,
      `bubbleId:${id}:%`
    ) ?? []) {
      bubbles.set(String(r['key']).slice(`bubbleId:${id}:`.length), r)
    }
  }
  const order = headers.length > 0 ? headers.map((h) => bubbles.get(String(h?.bubbleId)) ?? null) : inline
  const out: SessionMessage[] = []
  for (const b of order) {
    if (!b) continue
    const ts = toMs(b.created ?? b.createdAt) ?? undefined
    const type = Number(b.type)
    const text = str(b.text)
    if (type === 1) {
      if (text) out.push({ role: 'user', kind: 'text', text: capText(text), ts })
      continue
    }
    const thinking = str(typeof b.thinking === 'string' ? b.thinking : b.thinking?.text)
    if (thinking) out.push({ role: 'assistant', kind: 'reasoning', text: capText(thinking), ts })
    if (text) out.push({ role: 'assistant', kind: 'text', text: capText(text), ts })
    const tool = typeof b.tool === 'string' ? parseJson(b.tool) : b.toolFormerData
    if (tool && typeof tool === 'object' && typeof tool.name === 'string') {
      const params = parseJson(tool.params) ?? parseJson(tool.rawArgs) ?? {}
      const preview = composerToolPreview(params)
      const artifact = /terminal_command/.test(tool.name) ? checkArtifact(params['command']) : undefined
      out.push({
        role: 'assistant',
        kind: 'tool_call',
        toolName: tool.name,
        text: truncate(jsonText(params), 400),
        ...(preview ? { preview: truncate(preview, 200) } : {}),
        ...(artifact ? { artifact } : {}),
        ...(tool.status === 'error' ? { failed: true } : {}),
        ts
      })
    }
  }
  return out
}
