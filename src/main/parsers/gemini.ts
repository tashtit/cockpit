import { readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import { toolArtifact } from './artifacts'
import { checkOutcome } from './checks'
import {
  capText,
  fileTimes,
  jsonText,
  parseJsonlText,
  readHead,
  readJson,
  readJsonlTail,
  readSmallFile,
  toMs,
  toolPreview,
  TRANSCRIPT_TAIL_BYTES,
  truncate,
  usableCwd
} from './util'

/** Meta lives in the first records (header, the opening prompt) — never read the whole log. */
const META_HEAD_BYTES = 256 * 1024

/**
 * Gemini CLI sessions: <home>/tmp/<project>/chats/session-<time>-<short-id>.jsonl, where
 * <project> is a short name the CLI keeps in <home>/projects.json (older CLIs: a hash of
 * the directory) and <project>/.project_root names the directory itself. The log is a
 * record stream: a header ({sessionId, projectHash, startTime, …}), message records keyed
 * by `id` (a later record with the same id replaces the earlier one — a reply gains its
 * tool calls that way), `{$set: {…}}` metadata updates (`summary` is the generated title,
 * `messages` a checkpoint that replaces the whole list) and `{$rewindTo: id}`, which drops
 * that message and everything after it. Older CLIs wrote one JSON document per session
 * (`session-*.json`) holding the same fields. Subagent logs live one directory deeper
 * (chats/<parent-id>/) and are never sessions of their own.
 */
export function listGeminiSessionRoots(home: string): string[] {
  return [join(home, 'tmp')]
}

export function listGeminiSessionFiles(home: string): string[] {
  const out: string[] = []
  for (const project of dirNames(join(home, 'tmp'))) {
    const chats = join(home, 'tmp', project, 'chats')
    let names: string[]
    try {
      names = readdirSync(chats)
    } catch {
      continue
    }
    for (const name of names) if (isSessionName(name)) out.push(join(chats, name))
  }
  return out
}

export function listGeminiSessions(home: string, sourceLabel: string): SessionMeta[] {
  return listGeminiSessionFiles(home).flatMap((f) => parseGeminiMeta(f, sourceLabel) ?? [])
}

function dirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function isSessionName(name: string): boolean {
  return name.startsWith('session-') && (name.endsWith('.jsonl') || name.endsWith('.json'))
}

type GeminiLog = {
  /** The header and every `$set` after it, merged */
  readonly meta: Record<string, unknown>
  /** Message records by id, in the order they were first written */
  readonly messages: Map<string, any>
}

/**
 * Replay a log's records into what the CLI itself would load. `partial` says the read
 * began mid-file: a rewind to a message the read never saw then says nothing about the
 * messages it did see, where in a whole file it clears them all (as the CLI does).
 */
export function foldGeminiRecords(records: readonly unknown[], partial: boolean): GeminiLog {
  const meta: Record<string, unknown> = {}
  let messages = new Map<string, any>()
  const checkpoint = (list: unknown[]): void => {
    messages = new Map()
    for (const m of list) if (typeof (m as any)?.id === 'string') messages.set((m as any).id, m)
  }
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue
    const r = rec as Record<string, any>
    if (typeof r.$rewindTo === 'string') {
      const ids = [...messages.keys()]
      const at = ids.indexOf(r.$rewindTo)
      if (at >= 0) for (const id of ids.slice(at)) messages.delete(id)
      else if (!partial) messages.clear()
    } else if (typeof r.id === 'string') {
      messages.set(r.id, r)
    } else if (r.$set && typeof r.$set === 'object') {
      const { messages: list, ...rest } = r.$set
      Object.assign(meta, rest)
      if (Array.isArray(list)) checkpoint(list)
    } else if (typeof r.sessionId === 'string') {
      // the header — or, in an older CLI's one-document log, the whole session
      const { messages: list, ...rest } = r
      Object.assign(meta, rest)
      if (Array.isArray(list)) checkpoint(list)
    }
  }
  return { meta, messages }
}

/** Text of a Gemini `PartListUnion`: a string, one part or a list, thoughts left out. */
export function partsText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts = Array.isArray(content) ? content : content && typeof content === 'object' ? [content] : []
  return parts
    .map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' && p.thought !== true ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** What the person typed: `displayContent` when the prompt was expanded (an @file inlined). */
function userText(m: any): string {
  return partsText(m.displayContent ?? m.content).trim()
}

/** The CLI's own rule for a user record that is not a prompt: its context preamble, slash commands. */
function isIgnoredUserText(text: string): boolean {
  return (
    text === '' ||
    text.startsWith('/') ||
    text.startsWith('?') ||
    text.startsWith('<session_context>') ||
    text.startsWith('<hook_context>')
  )
}

function isConversation(m: any): boolean {
  return m?.type === 'gemini' || (m?.type === 'user' && !isIgnoredUserText(userText(m)))
}

/**
 * The directory a session ran in. The CLI names it beside the chats (`.project_root`)
 * and in its project map; the oldest logs say it only in the opening context message.
 */
function projectDir(file: string, messages: Iterable<any>): string | null {
  const project = dirname(dirname(file))
  const root = readSmallFile(join(project, '.project_root'), 4096)?.trim()
  if (root) return usableCwd(root)
  const home = dirname(dirname(project))
  const map = readJson(join(home, 'projects.json'), 256 * 1024)?.projects
  if (map && typeof map === 'object') {
    const name = basename(project)
    for (const [path, short] of Object.entries(map)) if (short === name) return usableCwd(path)
  }
  for (const m of messages) {
    if (m?.type !== 'user') continue
    const text = partsText(m.content)
    const listed = /Workspace Directories:\*{0,2}\s*\n\s*-\s+(\S.*)/.exec(text)
    const single = /working in the directory:?\s+(\S.*)/.exec(text)
    const dir = (listed ?? single)?.[1]?.trim()
    if (dir) return usableCwd(dir)
  }
  return null
}

/** A log's records from a bounded read: JSONL line by line, or an older CLI's one document. */
function recordsOf(file: string, text: string, truncated: boolean): unknown[] {
  if (file.endsWith('.jsonl')) return parseJsonlText(text, truncated)
  if (truncated) return []
  try {
    return [JSON.parse(text)]
  } catch {
    return []
  }
}

export function parseGeminiMeta(file: string, sourceLabel: string): SessionMeta | null {
  if (!isSessionName(basename(file))) return null
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  // an older one-document log too big for the head is read whole-or-not-at-all below
  const records = recordsOf(file, head.text, head.truncated)
  if (records.length === 0 && !(head.truncated && file.endsWith('.json'))) return null
  const { meta, messages } = foldGeminiRecords(records, false)
  const nativeId = typeof meta.sessionId === 'string' ? meta.sessionId : null
  if (!nativeId || meta.kind === 'subagent') return null

  let firstPrompt = ''
  let messageCount = 0
  let lastTs: number | null = null
  for (const m of messages.values()) {
    if (!isConversation(m)) continue
    messageCount++
    if (!firstPrompt && m.type === 'user') firstPrompt = userText(m)
    lastTs = toMs(m.timestamp) ?? lastTs
  }
  if (head.truncated) {
    // messages past the head window are counted by the bytes they span, as the other
    // parsers extrapolate
    messageCount = Math.max(messageCount, Math.round((messageCount * head.size) / META_HEAD_BYTES))
  }
  if (messageCount === 0) return null
  const summary = typeof meta.summary === 'string' ? meta.summary.trim() : ''
  const ft = fileTimes(file)
  return {
    id: `gemini:${nativeId}`,
    provider: 'gemini',
    nativeId,
    source: sourceLabel,
    title: truncate(summary || firstPrompt) || '(untitled)',
    cwd: projectDir(file, messages.values()),
    logBranch: null,
    startedAt: toMs(meta.startTime) ?? ft.start,
    // a truncated head cannot see the last update — the file's own mtime is the truth
    updatedAt: head.truncated ? ft.end : (toMs(meta.lastUpdated) ?? lastTs ?? ft.end),
    messageCount,
    sourcePath: file
  }
}

/** A tool call's result as text: what it showed the person, else what it told the model. */
function resultText(call: any): string {
  if (typeof call.resultDisplay === 'string' && call.resultDisplay.trim()) return call.resultDisplay
  const parts = Array.isArray(call.result) ? call.result : call.result ? [call.result] : []
  const out: string[] = []
  for (const p of parts) {
    const response = p?.functionResponse?.response
    if (response && typeof response === 'object') {
      const v = response.output ?? response.error ?? response.content
      out.push(typeof v === 'string' ? v : jsonText(response))
    } else if (typeof p?.text === 'string') out.push(p.text)
  }
  return out.join('\n')
}

/** `run_shell_command` reports how the command ended in its output: `Exit Code: 1`. */
function shellExit(text: string): number | null {
  const m = /Exit Code:\s*(-?\d+)/i.exec(text)
  return m ? Number(m[1]) : null
}

function callRows(call: any, ts: number | undefined): SessionMessage[] {
  const name = typeof call?.name === 'string' ? call.name : 'tool'
  const args = call?.args ?? {}
  const preview = toolPreview(name, args)
  const failed = call?.status === 'error'
  const result = resultText(call)
  let artifact = toolArtifact(name, args)
  if (artifact?.kind === 'check' && result) {
    artifact = checkOutcome(artifact, { text: result, exitCode: shellExit(result) })
  }
  const row: SessionMessage = {
    role: 'assistant',
    kind: 'tool_call',
    toolName: name,
    text: truncate(jsonText(args), 400),
    ...(preview ? { preview: truncate(preview, 200) } : {}),
    ...(artifact ? { artifact } : {}),
    ...(failed ? { failed: true } : {}),
    ts
  }
  if (!result && call?.status !== 'success' && !failed) return [row]
  return [row, { role: 'tool', kind: 'tool_result', text: truncate(result || '(result)', 400), ts }]
}

/** One message record as transcript rows, in the order the turn happened. */
function messageRows(m: any): SessionMessage[] {
  const ts = toMs(m?.timestamp) ?? undefined
  if (m?.type === 'user') {
    const text = userText(m)
    return isIgnoredUserText(text) ? [] : [{ role: 'user', kind: 'text', text: capText(text), ts }]
  }
  if (m?.type === 'gemini') {
    const out: SessionMessage[] = []
    for (const t of Array.isArray(m.thoughts) ? m.thoughts : []) {
      const text = [t?.subject, t?.description].filter((s) => typeof s === 'string' && s.trim()).join(': ')
      if (text) out.push({ role: 'assistant', kind: 'reasoning', text: capText(text), ts: toMs(t?.timestamp) ?? ts })
    }
    const text = partsText(m.content).trim()
    if (text) out.push({ role: 'assistant', kind: 'text', text: capText(text), ts })
    for (const call of Array.isArray(m.toolCalls) ? m.toolCalls : []) out.push(...callRows(call, toMs(call?.timestamp) ?? ts))
    return out
  }
  if (m?.type === 'info' || m?.type === 'error' || m?.type === 'warning') {
    const text = partsText(m.content).trim()
    return text ? [{ role: 'system', kind: 'system', text: truncate(text, 200), ts }] : []
  }
  return []
}

export function parseGeminiMessages(file: string): SessionMessage[] {
  let records: unknown[]
  let truncated = false
  if (file.endsWith('.jsonl')) {
    const tail = readJsonlTail(file)
    records = tail.lines
    truncated = tail.truncated
  } else {
    const raw = readSmallFile(file, TRANSCRIPT_TAIL_BYTES)
    if (raw === null) {
      return [{ role: 'system', kind: 'system', text: '(transcript is too large to show)' }]
    }
    records = recordsOf(file, raw, false)
  }
  const { messages } = foldGeminiRecords(records, truncated)
  const out = [...messages.values()].flatMap(messageRows)
  return truncated
    ? [{ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' }, ...out]
    : out
}
