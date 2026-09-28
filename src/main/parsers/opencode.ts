import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SessionMeta, SessionMessage, WorkArtifact } from '../../shared/types'
import { fileWriteArtifact, replaceArtifact, toolArtifact } from './artifacts'
import { checkArtifact, checkOutcome } from './checks'
import { dbMtime, queryAll, queryEach, sessionRef, snapshotCache, splitSessionRef } from './sqlite'
import { capText, fileTimes, jsonText, readJson, readSmallFile, toMs, TRANSCRIPT_TAIL_BYTES, truncate, usableCwd } from './util'

/**
 * opencode keeps its sessions in <home>/opencode.db (home: ~/.local/share/opencode):
 * `session` (id, directory, title, parent_id, time_created/updated/archived), `message`
 * (one row per turn, its JSON in `data`: role, time, model) and `part` (the pieces of a
 * turn: text, reasoning, tool calls with their input and output). Before the database,
 * the same records were one JSON file each under <home>/storage/: session/<project>/<id>.json,
 * message/<session>/<id>.json and part/<message>/<id>.json — still read, for sessions
 * the database does not hold. Database sessions are indexed as `<db>#<session id>`.
 */
export const OPENCODE_DB = 'opencode.db'

export function listOpencodeSessionRoots(home: string): string[] {
  // the database is watched on its own (see the indexer's database watches); only the
  // older file store is a tree of session files
  return [join(home, 'storage', 'session')]
}

type SessionRow = {
  readonly id: string
  readonly title: string
  readonly directory: string | null
  readonly parent: string | null
  readonly created: number | null
  readonly updated: number | null
  readonly archived: boolean
}

type DbSessions = { readonly sessions: Map<string, SessionRow>; readonly counts: Map<string, number> }

/** Every session in the database, and how many turns each holds — one read per change. */
const dbSessions = snapshotCache((file: string): DbSessions | null => {
  const rows = queryAll(
    file,
    'SELECT id, title, directory, parent_id, time_created, time_updated, time_archived FROM session'
  )
  const turns = queryAll(file, 'SELECT session_id, count(*) AS n FROM message GROUP BY session_id')
  // either read failing is no answer at all: a session counted without its turns is dropped
  if (!rows || !turns) return null
  const sessions = new Map<string, SessionRow>()
  for (const r of rows) {
    const id = typeof r['id'] === 'string' ? r['id'] : null
    if (!id) continue
    sessions.set(id, {
      id,
      title: typeof r['title'] === 'string' ? r['title'] : '',
      directory: usableCwd(r['directory']),
      parent: typeof r['parent_id'] === 'string' ? r['parent_id'] : null,
      created: toMs(r['time_created']),
      updated: toMs(r['time_updated']),
      archived: r['time_archived'] !== null && r['time_archived'] !== undefined
    })
  }
  const counts = new Map<string, number>()
  for (const r of turns) {
    if (typeof r['session_id'] === 'string') counts.set(r['session_id'], Number(r['n'] ?? 0))
  }
  return { sessions, counts }
}, { sessions: new Map(), counts: new Map() })

export function listOpencodeSessionFiles(home: string): string[] {
  const db = join(home, OPENCODE_DB)
  const { sessions } = dbSessions(db)
  const out: string[] = []
  // archived in opencode itself: out of every listing, as the other agents' are
  for (const s of sessions.values()) if (!s.archived) out.push(sessionRef(db, s.id))
  const store = join(home, 'storage', 'session')
  for (const project of subdirs(store)) {
    for (const name of files(join(store, project))) {
      if (name.endsWith('.json') && !sessions.has(basename(name, '.json'))) out.push(join(store, project, name))
    }
  }
  return out
}

export function listOpencodeSessions(home: string, sourceLabel: string): SessionMeta[] {
  return listOpencodeSessionFiles(home).flatMap((f) => parseOpencodeMeta(f, sourceLabel) ?? [])
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

function files(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}

/** opencode's placeholder title until it names a session: `New session - <ISO time>`. */
function realTitle(title: string): string {
  return /^(New session|Child session) - \d{4}-\d{2}-\d{2}T/.test(title) ? '' : title
}

export function parseOpencodeMeta(file: string, sourceLabel: string): SessionMeta | null {
  const ref = splitSessionRef(file)
  if (ref && basename(ref.file) === OPENCODE_DB) {
    const { sessions, counts } = dbSessions(ref.file)
    const s = sessions.get(ref.id)
    const messageCount = counts.get(ref.id) ?? 0
    if (!s || s.archived || messageCount === 0) return null
    return meta({ ...s, messageCount, sourcePath: file, sourceLabel, fallbackTime: dbMtime(ref.file), firstPrompt: () => firstDbPrompt(ref.file, ref.id) })
  }
  if (!file.endsWith('.json')) return null
  const s = readJson(file, 1024 * 1024)
  if (!s || typeof s !== 'object' || typeof s.id !== 'string') return null
  const home = dirname(dirname(dirname(dirname(file))))
  const messages = files(join(home, 'storage', 'message', s.id)).filter((n) => n.endsWith('.json'))
  if (messages.length === 0) return null
  const ft = fileTimes(file)
  return meta({
    id: s.id,
    title: typeof s.title === 'string' ? s.title : '',
    directory: usableCwd(s.directory),
    parent: typeof s.parentID === 'string' ? s.parentID : null,
    created: toMs(s.time?.created),
    updated: toMs(s.time?.updated),
    archived: false,
    messageCount: messages.length,
    sourcePath: file,
    sourceLabel,
    fallbackTime: ft.end,
    firstPrompt: () => legacyFirstPrompt(home, s.id)
  })
}

function meta(
  s: SessionRow & {
    readonly messageCount: number
    readonly sourcePath: string
    readonly sourceLabel: string
    readonly fallbackTime: number
    readonly firstPrompt: () => string
  }
): SessionMeta {
  return {
    id: `opencode:${s.id}`,
    provider: 'opencode',
    nativeId: s.id,
    source: s.sourceLabel,
    title: truncate(realTitle(s.title) || s.firstPrompt()) || '(untitled)',
    cwd: s.directory,
    logBranch: null,
    startedAt: s.created ?? s.fallbackTime,
    updatedAt: s.updated ?? s.fallbackTime,
    messageCount: s.messageCount,
    sourcePath: s.sourcePath,
    ...(s.parent ? { parentId: `opencode:${s.parent}` } : {})
  }
}

function firstDbPrompt(db: string, id: string): string {
  const rows = queryAll(
    db,
    `SELECT p.data AS data FROM part p JOIN message m ON m.id = p.message_id
     WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text'
     ORDER BY m.time_created, p.id LIMIT 1`,
    id
  )
  try {
    return String(JSON.parse(String(rows?.[0]?.['data'] ?? '{}')).text ?? '')
  } catch {
    return ''
  }
}

/** One turn: who spoke, when, and its parts in order. */
type Turn = { readonly role: string; readonly ts?: number; readonly parts: readonly any[] }

/** A part larger than this is not parsed — a tool's output can be a whole file. */
const MAX_PART_BYTES = 256 * 1024

function dbTurns(db: string, id: string): { turns: Turn[]; truncated: boolean } {
  const messages = queryAll(db, 'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id', id) ?? []
  // newest parts first, so a long session opens on its latest turns: their sizes, stepped
  // through until the budget is spent (octet_length reads none of a part's content), then
  // the content of those alone — never every part whole, only to throw most of them away
  const window: string[] = []
  let budget = TRANSCRIPT_TAIL_BYTES
  let truncated = false
  queryEach(
    db,
    { sql: 'SELECT id, octet_length(data) AS n FROM part WHERE session_id = ? ORDER BY message_id DESC, id DESC', params: [id] },
    (r) => {
      const n = Number(r['n'] ?? 0)
      // a part too big to parse is left out, and costs nothing
      if (n > MAX_PART_BYTES) return true
      budget -= n
      if (budget < 0) {
        truncated = true
        return false
      }
      window.push(String(r['id']))
      return true
    }
  )
  const read = new Map<string, Record<string, unknown>>()
  for (const r of queryAll(
    db,
    `SELECT id, message_id, data FROM part WHERE id IN (SELECT value FROM json_each(?)) AND octet_length(data) <= ${MAX_PART_BYTES}`,
    JSON.stringify(window)
  ) ?? []) {
    read.set(String(r['id']), r)
  }
  const parts = new Map<string, any[]>()
  for (const pid of window.reverse()) {
    const r = read.get(pid)
    if (typeof r?.['data'] !== 'string') continue
    try {
      const part = JSON.parse(r['data'])
      const mid = String(r['message_id'])
      const own = parts.get(mid)
      if (own) own.push(part)
      else parts.set(mid, [part])
    } catch {
      /* a malformed part is skipped */
    }
  }
  const turns: Turn[] = []
  for (const m of messages) {
    let data: any = {}
    try {
      data = JSON.parse(String(m['data'] ?? '{}'))
    } catch {
      /* a turn with an unreadable header still has its parts */
    }
    const own = parts.get(String(m['id']))
    if (!own) continue
    turns.push({ role: typeof data.role === 'string' ? data.role : 'assistant', ts: toMs(m['time_created']) ?? undefined, parts: own })
  }
  return { turns, truncated }
}

/**
 * The older file store: a directory of turns, a directory of parts per turn — read under
 * a budget of bytes and of files, each file whole or not at all. A transcript gets the
 * transcript budget; a meta read, the 256KB a log's head is read within.
 */
const MAX_LEGACY_FILES = 4000
const META_LEGACY_BYTES = 256 * 1024
const MAX_META_LEGACY_FILES = 64
/** One message's own file: its role and time, never large */
const MAX_LEGACY_MESSAGE_BYTES = 256 * 1024

/** What a read of the older store may still spend — mutable on purpose: spent as files are read. */
type LegacyBudget = { bytes: number; files: number }

const spent = (b: LegacyBudget): boolean => b.bytes <= 0 || b.files <= 0

/** One file of the older store as JSON, charged to the budget; null past it, or unreadable. */
function readLegacy(file: string, budget: LegacyBudget, maxBytes: number): any | null {
  if (spent(budget)) return null
  budget.files--
  const cap = Math.min(maxBytes, budget.bytes)
  const raw = readSmallFile(file, cap)
  if (raw === null) {
    // too big for what is left of the budget: nothing more fits
    if (cap < maxBytes) budget.bytes = 0
    return null
  }
  budget.bytes -= raw.length
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function messageNames(home: string, id: string): string[] {
  return files(join(home, 'storage', 'message', id))
    .filter((n) => n.endsWith('.json'))
    .sort()
}

/** A session's turns, the newest that fit the transcript budget — message ids sort by time. */
function legacyTurns(home: string, id: string): { turns: Turn[]; truncated: boolean } {
  const budget: LegacyBudget = { bytes: TRANSCRIPT_TAIL_BYTES, files: MAX_LEGACY_FILES }
  const names = messageNames(home, id)
  const turns: Turn[] = []
  let left = names.length
  while (left > 0 && !spent(budget)) {
    const m = readLegacy(join(home, 'storage', 'message', id, names[--left]!), budget, MAX_LEGACY_MESSAGE_BYTES)
    if (!m || typeof m.id !== 'string') continue
    const partDir = join(home, 'storage', 'part', m.id)
    const parts = files(partDir)
      .sort()
      .flatMap((p) => readLegacy(join(partDir, p), budget, MAX_PART_BYTES) ?? [])
    turns.push({ role: typeof m.role === 'string' ? m.role : 'assistant', ts: toMs(m.time?.created) ?? undefined, parts })
  }
  return { turns: turns.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)), truncated: left > 0 }
}

/** An untitled session's opening prompt: the first text of its first turn the person wrote, found within the meta budget. */
function legacyFirstPrompt(home: string, id: string): string {
  const budget: LegacyBudget = { bytes: META_LEGACY_BYTES, files: MAX_META_LEGACY_FILES }
  for (const name of messageNames(home, id)) {
    if (spent(budget)) break
    const m = readLegacy(join(home, 'storage', 'message', id, name), budget, MAX_LEGACY_MESSAGE_BYTES)
    if (m?.role !== 'user' || typeof m.id !== 'string') continue
    const partDir = join(home, 'storage', 'part', m.id)
    for (const p of files(partDir).sort()) {
      const part = readLegacy(join(partDir, p), budget, MAX_PART_BYTES)
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
    }
  }
  return ''
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** opencode's own tool names and what their input says. */
function toolPreviewOf(tool: string, input: Record<string, unknown>): string | null {
  return str(input['command']) ?? str(input['filePath']) ?? str(input['pattern']) ?? str(input['url']) ?? str(input['description']) ?? str(input['path']) ?? null
}

function toolArtifactOf(tool: string, input: Record<string, unknown>): WorkArtifact | undefined {
  switch (tool) {
    case 'bash':
      return checkArtifact(input['command'])
    case 'edit':
      return replaceArtifact(input['filePath'], [[input['oldString'], input['newString']]])
    case 'write':
      return fileWriteArtifact(input['filePath'], input['content'], 'write')
    case 'todowrite':
      return toolArtifact('TodoWrite', { todos: input['todos'] })
    default:
      return undefined
  }
}

function turnRows(turn: Turn): SessionMessage[] {
  const out: SessionMessage[] = []
  const role = turn.role === 'user' ? 'user' : 'assistant'
  for (const p of turn.parts) {
    const ts = toMs(p?.time?.start) ?? turn.ts
    if (p?.type === 'text' && !p.synthetic && str(p.text)) out.push({ role, kind: 'text', text: capText(p.text), ts })
    else if (p?.type === 'reasoning' && str(p.text)) out.push({ role: 'assistant', kind: 'reasoning', text: capText(p.text), ts })
    else if (p?.type === 'tool') {
      const tool = typeof p.tool === 'string' ? p.tool : 'tool'
      const state = p.state && typeof p.state === 'object' ? p.state : {}
      const input = state.input && typeof state.input === 'object' ? state.input : {}
      const output = typeof state.output === 'string' ? state.output : typeof state.error === 'string' ? state.error : ''
      let artifact = toolArtifactOf(tool, input)
      if (artifact?.kind === 'check' && output) {
        const exit = state.metadata?.exit
        artifact = checkOutcome(artifact, { text: output, exitCode: typeof exit === 'number' ? exit : null })
      }
      const preview = str(state.title) ?? toolPreviewOf(tool, input)
      out.push({
        role: 'assistant',
        kind: 'tool_call',
        toolName: tool,
        text: truncate(jsonText(input), 400),
        ...(preview ? { preview: truncate(preview, 200) } : {}),
        ...(artifact ? { artifact } : {}),
        ...(state.status === 'error' ? { failed: true } : {}),
        ts
      })
      if (output) out.push({ role: 'tool', kind: 'tool_result', text: truncate(output, 400), ts })
    }
  }
  return out
}

export function parseOpencodeMessages(file: string): SessionMessage[] {
  const ref = splitSessionRef(file)
  let read: { readonly turns: Turn[]; readonly truncated: boolean }
  if (ref && basename(ref.file) === OPENCODE_DB) read = dbTurns(ref.file, ref.id)
  else {
    const s = readJson(file, 1024 * 1024)
    if (!s || typeof s.id !== 'string') return []
    read = legacyTurns(dirname(dirname(dirname(dirname(file)))), s.id)
  }
  const rows = read.turns.flatMap(turnRows)
  return read.truncated
    ? [{ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' }, ...rows]
    : rows
}
