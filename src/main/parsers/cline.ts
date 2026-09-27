import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SessionMeta, SessionMessage, WorkArtifact } from '../../shared/types'
import {
  checklistArtifact,
  fileWriteArtifact,
  searchReplaceArtifact,
  toolArtifact
} from './artifacts'
import { checkArtifact, checkOutcome } from './checks'
import {
  capText,
  fileTimes,
  jsonArrayItems,
  readHead,
  readJson,
  readJsonArrayTail,
  toMs,
  truncate,
  usableCwd
} from './util'

/** Meta lives in the first messages (the task, the first request's environment) — never read the whole log. */
const META_HEAD_BYTES = 256 * 1024
/** A shared history index larger than this is not read (Cline's holds one line per task). */
const MAX_HISTORY_BYTES = 16 * 1024 * 1024

/**
 * Cline and Roo Code, which began as a fork of it, keep every task the same way, under
 * the extension's storage in whichever editor runs it (<editor>/User/globalStorage/<ext>/)
 * or under the Cline CLI's own home:
 *
 *   tasks/<task-id>/ui_messages.json            — the conversation as the panel shows it:
 *                                                 one JSON array of {ts, type: say|ask, say|ask, text}
 *   tasks/<task-id>/api_conversation_history.json — what the model was sent (not read)
 *   state/taskHistory.json                       — Cline: every task's {id, task, ts, cwdOnTaskInitialization}
 *   tasks/<task-id>/history_item.json            — Roo Code: the same for one task, plus its workspace
 *
 * The first `say: text` is the person's task; every later one is the agent speaking.
 */
export type ClineFamily = 'cline' | 'roo'

export function listClineSessionRoots(home: string): string[] {
  return [join(home, 'tasks')]
}

export function listClineSessionFiles(home: string): string[] {
  const tasks = join(home, 'tasks')
  let entries
  try {
    entries = readdirSync(tasks, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isDirectory()).map((e) => join(tasks, e.name, 'ui_messages.json'))
}

type HistoryEntry = {
  readonly task?: string
  readonly cwd?: string | null
  readonly ts?: number | null
  readonly parent?: string
}

/** A shared history file's entries by task id, kept while the file is unchanged. */
const historyCache = new Map<string, { readonly stamp: string; readonly byId: Map<string, HistoryEntry> }>()

function historyIndex(file: string, read: (list: unknown[]) => Map<string, HistoryEntry>): Map<string, HistoryEntry> {
  let stamp: string
  try {
    const st = statSync(file)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    return new Map()
  }
  const hit = historyCache.get(file)
  if (hit?.stamp === stamp) return hit.byId
  const raw = readJson(file, MAX_HISTORY_BYTES)
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : []
  const byId = read(list)
  historyCache.set(file, { stamp, byId })
  return byId
}

function entry(r: any): HistoryEntry {
  return {
    task: typeof r?.task === 'string' ? r.task : undefined,
    cwd: usableCwd(r?.cwdOnTaskInitialization ?? r?.workspace),
    ts: toMs(r?.ts),
    parent: typeof r?.parentTaskId === 'string' ? r.parentTaskId : undefined
  }
}

function byTaskId(list: unknown[]): Map<string, HistoryEntry> {
  const out = new Map<string, HistoryEntry>()
  for (const r of list) {
    const id = (r as any)?.id
    if (typeof id === 'string' || typeof id === 'number') out.set(String(id), entry(r))
  }
  return out
}

/** What the extension's own history says about one task, where it keeps one. */
function historyFor(provider: ClineFamily, home: string, taskDir: string, id: string): HistoryEntry | null {
  if (provider === 'roo') {
    const own = readJson(join(taskDir, 'history_item.json'), 1024 * 1024)
    if (own && typeof own === 'object') return entry(own)
    return historyIndex(join(home, 'tasks', '_index.json'), byTaskId).get(id) ?? null
  }
  return historyIndex(join(home, 'state', 'taskHistory.json'), byTaskId).get(id) ?? null
}

/** The first request names the directory in its environment block: `# Current Working Directory (/x) Files`. */
function environmentCwd(text: string): string | null {
  const m = /Current (?:Working|Workspace) Directory \(([^)\n\\]+)\)/.exec(text)
  return m ? usableCwd(m[1]!.trim()) : null
}

function kindOf(m: any): string {
  return typeof m?.say === 'string' ? m.say : typeof m?.ask === 'string' ? m.ask : ''
}

/** A message the person or the agent actually said, as opposed to the panel's bookkeeping. */
function isConversation(m: any): boolean {
  const k = kindOf(m)
  if (k === 'text' || k === 'user_feedback' || k === 'completion_result') return typeof m.text === 'string' && m.text.trim() !== ''
  return m?.type === 'ask' && (k === 'followup' || k === 'plan_mode_respond')
}

function parseTaskMeta(provider: ClineFamily, file: string, sourceLabel: string): SessionMeta | null {
  if (basename(file) !== 'ui_messages.json') return null
  const taskDir = dirname(file)
  const nativeId = basename(taskDir)
  const home = dirname(dirname(taskDir))
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  const items = jsonArrayItems(head.text)
  if (items.length === 0) return null

  let task = ''
  let firstTs: number | null = null
  let lastTs: number | null = null
  let messageCount = 0
  for (const m of items as any[]) {
    const ts = toMs(m?.ts)
    if (ts) {
      firstTs ??= ts
      lastTs = ts
    }
    if (!task && kindOf(m) === 'text' && typeof m.text === 'string') task = m.text
    if (isConversation(m)) messageCount++
  }
  if (head.truncated) {
    messageCount = Math.max(messageCount, Math.round((messageCount * head.size) / META_HEAD_BYTES))
  }
  if (messageCount === 0) return null
  const hist = historyFor(provider, home, taskDir, nativeId)
  const ft = fileTimes(file)
  return {
    id: `${provider}:${nativeId}`,
    provider,
    nativeId,
    source: sourceLabel,
    title: truncate(hist?.task || task) || '(untitled)',
    cwd: hist?.cwd ?? environmentCwd(head.text),
    logBranch: null,
    startedAt: firstTs ?? ft.start,
    // the panel rewrites the whole file on every message, so its mtime is the last one
    updatedAt: head.truncated ? ft.end : (lastTs ?? ft.end),
    messageCount,
    sourcePath: file,
    ...(hist?.parent ? { parentId: `${provider}:${hist.parent}` } : {})
  }
}

export function parseClineMeta(file: string, sourceLabel: string): SessionMeta | null {
  return parseTaskMeta('cline', file, sourceLabel)
}

export function parseRooMeta(file: string, sourceLabel: string): SessionMeta | null {
  return parseTaskMeta('roo', file, sourceLabel)
}

export function listClineSessions(home: string, sourceLabel: string, provider: ClineFamily = 'cline'): SessionMeta[] {
  return listClineSessionFiles(home).flatMap((f) => parseTaskMeta(provider, f, sourceLabel) ?? [])
}

function json(text: unknown): any {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** A file tool's headline and the work it did: the path, and for an edit the change itself. */
function fileTool(t: any): { readonly preview: string | null; readonly artifact?: WorkArtifact } {
  const batch = Array.isArray(t?.batchFiles) ? t.batchFiles : null
  const path =
    typeof t?.path === 'string' ? t.path : batch?.map((f: any) => f?.path).filter((p: unknown) => typeof p === 'string').join(', ')
  const preview = path || null
  switch (t?.tool) {
    case 'editedExistingFile':
    case 'appliedDiff':
    case 'searchAndReplace':
      return { preview, artifact: searchReplaceArtifact(t.path, t.diff ?? t.content) }
    case 'newFileCreated':
      return { preview, artifact: fileWriteArtifact(t.path, t.content, 'add') }
    case 'updateTodoList':
      return { preview: null, artifact: toolArtifact('TodoWrite', { todos: t.todos }) }
    case 'searchFiles':
      return { preview: [t.regex, path].filter(Boolean).join(' in ') || null }
    case 'webFetch':
      return { preview: t.url ?? path ?? null }
    default:
      return { preview }
  }
}

/** A command as the panel records it; `REQ_APP` marks one that asked for approval. */
function commandText(text: unknown): string {
  return typeof text === 'string' ? text.replace(/REQ_APP$/, '').trim() : ''
}

/**
 * The panel's messages as transcript rows. Tool results ride in the tool message itself
 * (`content`), so a call and its result are one message; a command's output streams in
 * as separate messages after it, and is gathered onto one result row.
 */
export function clineRows(items: readonly unknown[], opts: { readonly fromStart: boolean }): SessionMessage[] {
  const out: SessionMessage[] = []
  let taskSeen = !opts.fromStart
  /** the open command's call row and its result row, while output is still arriving */
  let command: { call: number; result: number | null; output: string } | null = null
  const closeCommand = (): void => {
    if (!command) return
    const call = out[command.call]!
    if (call.artifact?.kind === 'check' && command.output) {
      out[command.call] = { ...call, artifact: checkOutcome(call.artifact, { text: command.output, exitCode: null }) }
    }
    command = null
  }
  for (const m of items as any[]) {
    const k = kindOf(m)
    const ts = toMs(m?.ts) ?? undefined
    const text = typeof m?.text === 'string' ? m.text : ''
    if (k === 'command_output') {
      if (!text.trim()) continue
      if (command && command.result !== null) {
        command.output += text
        out[command.result] = { ...out[command.result]!, text: truncate(command.output, 400) }
      } else if (command) {
        command.output = text
        command.result = out.length
        out.push({ role: 'tool', kind: 'tool_result', text: truncate(text, 400), ts })
      } else {
        out.push({ role: 'tool', kind: 'tool_result', text: truncate(text, 400), ts })
      }
      continue
    }
    // anything else ends a command's output — except the bookkeeping the panel
    // interleaves (checkpoints, request markers), which says nothing about it
    if (!['api_req_started', 'checkpoint_created', 'checkpoint_saved', 'shell_integration_warning'].includes(k)) closeCommand()
    switch (k) {
      case 'text':
        if (!text.trim()) break
        out.push({ role: taskSeen ? 'assistant' : 'user', kind: 'text', text: capText(text), ts })
        taskSeen = true
        break
      case 'user_feedback':
        if (text.trim()) out.push({ role: 'user', kind: 'text', text: capText(text), ts })
        break
      case 'completion_result':
        if (text.trim()) out.push({ role: 'assistant', kind: 'text', text: capText(text), ts })
        break
      case 'reasoning':
        if (text.trim()) out.push({ role: 'assistant', kind: 'reasoning', text: capText(text), ts })
        break
      case 'followup':
      case 'plan_mode_respond': {
        const j = json(text)
        const said = typeof j?.question === 'string' ? j.question : typeof j?.response === 'string' ? j.response : text
        const options = Array.isArray(j?.options) ? j.options.filter((o: unknown) => typeof o === 'string') : []
        const body = options.length > 0 ? `${said}\n\n${options.map((o: string) => `- ${o}`).join('\n')}` : said
        if (body.trim()) out.push({ role: 'assistant', kind: 'text', text: capText(body), ts })
        break
      }
      case 'task_progress': {
        const artifact = checklistArtifact(text)
        if (artifact) out.push({ role: 'assistant', kind: 'tool_call', toolName: 'task_progress', text: truncate(text, 400), artifact, ts })
        break
      }
      case 'tool': {
        const t = json(text)
        if (!t) break
        if (t.tool === 'summarizeTask') {
          out.push({ role: 'system', kind: 'system', text: '(earlier conversation summarized to free context)', ts })
          break
        }
        const { preview, artifact } = fileTool(t)
        out.push({
          role: 'assistant',
          kind: 'tool_call',
          toolName: typeof t.tool === 'string' ? t.tool : 'tool',
          text: truncate(text, 400),
          ...(preview ? { preview: truncate(preview, 200) } : {}),
          ...(artifact ? { artifact } : {}),
          ts
        })
        // what a read, a listing or a search found rides in the same message; an edit's
        // `content` is the edit itself, already on the call
        const edit = artifact?.kind === 'edits' || artifact?.kind === 'todos'
        const result = typeof t.content === 'string' && !edit && t.tool !== 'readFile' ? t.content : ''
        if (result.trim()) out.push({ role: 'tool', kind: 'tool_result', text: truncate(result, 400), ts })
        break
      }
      case 'command': {
        const cmd = commandText(text)
        if (!cmd) break
        const artifact = checkArtifact(cmd)
        command = { call: out.length, result: null, output: '' }
        out.push({
          role: 'assistant',
          kind: 'tool_call',
          toolName: 'execute_command',
          text: truncate(cmd, 400),
          preview: truncate(cmd, 200),
          ...(artifact ? { artifact } : {}),
          ts
        })
        break
      }
      case 'use_mcp_server': {
        const j = json(text)
        const name = [j?.serverName, j?.toolName ?? j?.uri].filter((s) => typeof s === 'string').join(' · ')
        out.push({ role: 'assistant', kind: 'tool_call', toolName: 'mcp', text: truncate(text, 400), ...(name ? { preview: truncate(name, 200) } : {}), ts })
        break
      }
      case 'mcp_server_response':
      case 'browser_action_result':
        if (text.trim()) out.push({ role: 'tool', kind: 'tool_result', text: truncate(text, 400), ts })
        break
      case 'browser_action_launch':
      case 'browser_action': {
        const j = json(text)
        const preview = typeof j?.action === 'string' ? j.action : text
        out.push({ role: 'assistant', kind: 'tool_call', toolName: 'browser', text: truncate(text, 400), ...(preview ? { preview: truncate(preview, 200) } : {}), ts })
        break
      }
      case 'diff_error': {
        // an edit that did not apply names its file: the edit's own row says it failed
        for (let i = out.length - 1; i >= 0; i--) {
          const row = out[i]!
          if (row.kind === 'tool_call' && row.artifact?.kind === 'edits' && row.preview === text.trim()) {
            out[i] = { ...row, failed: true }
            break
          }
        }
        if (text.trim()) out.push({ role: 'system', kind: 'system', text: truncate(`Edit did not apply: ${text}`, 200), ts })
        break
      }
      case 'error':
      case 'api_req_failed':
      case 'mistake_limit_reached':
        if (text.trim()) out.push({ role: 'system', kind: 'system', text: truncate(text, 200), ts })
        break
      default:
        // request markers, checkpoints, resume prompts, approval counters: the panel's
        // bookkeeping, not the conversation
        break
    }
  }
  closeCommand()
  return out
}

/** The panel's bookkeeping, which a transcript never shows — skipped even when huge. */
const BOOKKEEPING = new Set(['api_req_started', 'checkpoint_created', 'checkpoint_saved', 'deleted_api_reqs'])

/**
 * What stands for a message too large to read (Cline keeps each whole request inline):
 * nothing for bookkeeping, a note for anything the transcript would have shown. A tool
 * message's note is not JSON, so its row is left out as any unreadable tool message is.
 */
function oversized(head: string): unknown {
  const type = /"type":"(say|ask)"/.exec(head)?.[1]
  const kind = /"(?:say|ask)":"([a-z_]+)"/.exec(head)?.[1]
  if (!type || !kind || BOOKKEEPING.has(kind)) return null
  const ts = Number(/"ts":(\d+)/.exec(head)?.[1] ?? 0)
  return { ts, type, [type]: kind, text: '(message too large to show)' }
}

export function parseClineMessages(file: string): SessionMessage[] {
  const { items, truncated } = readJsonArrayTail(file, { key: 'ts', oversized })
  const rows = clineRows(items, { fromStart: !truncated })
  return truncated
    ? [{ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' }, ...rows]
    : rows
}
