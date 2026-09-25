import { basename, dirname, join } from 'node:path'
import { statSync } from 'node:fs'
import type { SessionMeta, SessionMessage, SessionSegment } from '../../shared/types'
import { parseAsks } from '../../shared/asks'
import { fileChangeArtifact, toolArtifact } from './artifacts'
import { checkOutcome, commandItemCheck, exitCodeIn } from './checks'
import { cellToolCalls } from './code-mode'
import {
  capText,
  contentToText,
  fileTimes,
  jsonText,
  parseJsonlText,
  readHead,
  readJsonlTail,
  TRANSCRIPT_TAIL_BYTES,
  toMs,
  toolPreview,
  patchPreview,
  shellPreview,
  shellScript,
  truncate,
  usableCwd,
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

/** Codex keeps generated thread names out-of-band: { id, thread_name, updated_at } per line. */
export function codexIndexFile(sourceDir: string): string {
  return join(sourceDir, 'session_index.jsonl')
}

/** thread_name index, cached on the file's mtime so rescans don't re-read it per session. */
const indexCache = new Map<string, { mtimeMs: number; names: Map<string, string> }>()
/**
 * The name index only grows (~130 bytes a line, a later line renaming an earlier
 * thread), so a read is bounded to its newest lines — tens of thousands of names; a
 * thread named before those falls back to its first prompt.
 */
const INDEX_TAIL_BYTES = 8 * 1024 * 1024

function threadNames(sourceDir: string): Map<string, string> {
  const file = codexIndexFile(sourceDir)
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    /* no index yet */
  }
  const cached = indexCache.get(file)
  if (cached && cached.mtimeMs === mtimeMs) return cached.names
  const names = new Map<string, string>()
  if (mtimeMs) {
    for (const l of readJsonlTail(file, { maxBytes: INDEX_TAIL_BYTES }).lines) {
      if (l?.id && typeof l.thread_name === 'string' && l.thread_name) {
        names.set(String(l.id), l.thread_name)
      }
    }
  }
  indexCache.set(file, { mtimeMs, names })
  return names
}

/** Rollouts live at <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl — walk up to the home dir. */
function codexHomeOf(file: string): string | null {
  let d = dirname(file)
  for (let i = 0; i < 6; i++) {
    if (basename(d) === 'sessions') return dirname(d)
    d = dirname(d)
  }
  return null
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

/**
 * Which envelope a rollout line uses. Modern codex-rs wraps every item as
 * `{timestamp, type, payload}`; older rollouts wrote bare ResponseItems with no
 * envelope, which `payload ?? line` unwrapping already anticipated.
 */
function lineKind(l: any): 'response_item' | 'event_msg' | 'session_meta' {
  if (l?.type === 'event_msg' || l?.type === 'session_meta') return l.type
  return 'response_item'
}

/** Is this a canonical (ResponseItem) message line, as opposed to its event_msg echo? */
function isItemMessage(l: any): boolean {
  return lineKind(l) === 'response_item' && (l?.payload ?? l)?.type === 'message'
}

/**
 * A turn can be persisted twice — once as a ResponseItem and once as its
 * event_msg echo. Counting or rendering both duplicates every message, so the
 * echoes are only used for rollouts that carry no ResponseItem messages at all.
 */
function usesEventEchoes(lines: readonly any[]): boolean {
  return !lines.some(isItemMessage)
}

/** A patch applied as its own tool call, rather than from inside a code-mode `exec` script. */
function isPatchCall(l: any): boolean {
  const p = l?.payload ?? l
  return (
    lineKind(l) === 'response_item' &&
    (p?.type === 'function_call' || p?.type === 'custom_tool_call') &&
    p?.name === 'apply_patch'
  )
}

/**
 * Newer Codex applies patches from inside a code-mode `exec` script, so the only
 * record of what a patch changed is the typed `FileChange` item it completes with —
 * paths, and the content or a unified diff. A rollout that applies patches as calls
 * of their own renders those instead, so the one change is never shown twice.
 */
function usesFileChangeItems(lines: readonly any[]): boolean {
  return !lines.some(isPatchCall)
}

/** One `FileChange` item as the tool row a patch call would have been. */
function fileChangeRow(item: any, ts: number | undefined): SessionMessage | null {
  const artifact = fileChangeArtifact(item?.changes)
  if (!artifact || artifact.kind !== 'edits') return null
  // the headline a patch call gets (`patchPreview`): the files it touches
  const preview = `apply_patch ${artifact.files.map((f) => f.path).join(', ')}`
  // a patch that failed or was declined still names the files; it didn't change them
  const failed = typeof item?.status === 'string' && item.status !== 'completed'
  const stdout = typeof item?.stdout === 'string' ? item.stdout : ''
  return {
    role: 'assistant',
    kind: 'tool_call',
    toolName: 'apply_patch',
    text: truncate(stdout || preview, 400),
    preview: truncate(preview, 200),
    artifact,
    ...(failed ? { failed: true } : {}),
    ts
  }
}

/**
 * The typed items Codex persists as each tool run completes (nothing is written as one
 * starts). A code-mode `exec` cell's runs arrive this way — one item per command, MCP
 * call or search — between the cell and its output.
 */
const TOOL_ITEMS: ReadonlySet<string> = new Set([
  'CommandExecution',
  'McpToolCall',
  'DynamicToolCall',
  'WebSearch',
  'ImageView',
  'Extension',
  'FileChange'
])

/** Response items the model calls a tool with directly, each under its own `call_id`. */
const DIRECT_CALLS: ReadonlySet<string> = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'])

function toolItemOf(l: any): any | null {
  if (lineKind(l) !== 'event_msg') return null
  const p = l.payload ?? l
  return p?.type === 'item_completed' && TOOL_ITEMS.has(p.item?.type) ? p.item : null
}

/**
 * A tool called directly completes with an item carrying the call's own id (a `js` call
 * as an McpToolCall, a `sleep` as an Extension), which is that call said again.
 */
function directCallIds(lines: readonly any[]): Set<string> {
  const ids = new Set<string>()
  for (const l of lines) {
    const p = l?.payload ?? l
    if (lineKind(l) === 'response_item' && DIRECT_CALLS.has(p?.type) && typeof p.call_id === 'string') ids.add(p.call_id)
  }
  return ids
}

function echoesDirectCall(item: any, direct: ReadonlySet<string>): boolean {
  return typeof item?.id === 'string' && direct.has(item.id)
}

/**
 * A code-mode cell and the items its tool runs complete with describe the same work —
 * the cell once, as a script, and each run on its own, typed: the command it ran, its
 * exit status and output. Where a rollout carries the items they are the rows, named as
 * the live stream names them (`shell`), so a rejoined turn matches; the cells then add
 * nothing but the few runs that never complete as items (a `write_stdin` poll, a cell
 * that threw before calling anything). A cell renders as a row of its own only in a
 * rollout with no tool items at all.
 */
function usesToolItems(lines: readonly any[], direct: ReadonlySet<string>): boolean {
  return lines.some((l) => {
    const item = toolItemOf(l)
    return item !== null && !echoesDirectCall(item, direct)
  })
}

/**
 * Which of a rollout's records each tool run is read from — one per run, decided once
 * for the whole rollout, so the transcript never shows a run twice and the profile never
 * counts one twice.
 */
export type ToolRecords = {
  /** Call ids of the tools called directly: an item under one of them is its echo */
  readonly direct: ReadonlySet<string>
  /** Whether the code-mode cells stand for their runs (no typed item does) */
  readonly cells: boolean
  /** Whether FileChange items stand for the patches (none was applied as a call) */
  readonly fileChanges: boolean
}

export function toolRecords(lines: readonly any[]): ToolRecords {
  const direct = directCallIds(lines)
  return { direct, cells: !usesToolItems(lines, direct), fileChanges: usesFileChangeItems(lines) }
}

/** The typed tool item a line carries, when that item is the record its run is read from. */
export function toolItemFor(l: any, records: ToolRecords): any | null {
  const item = toolItemOf(l)
  if (!item) return null
  if (item.type === 'FileChange') return records.fileChanges ? item : null
  return echoesDirectCall(item, records.direct) ? null : item
}

/** The name a typed item's run is shown and counted under; null for one too malformed to show. */
export function toolItemName(item: any): string | null {
  return itemCall(item)?.name ?? null
}

/** One code-mode `exec` cell as a tool row, headlined by the first tool it calls. */
function execCellRow(cell: string, ts: number | undefined): SessionMessage {
  const calls = cellToolCalls(cell)
  const first = calls[0]
  // apply_patch takes its patch bare; every other tool, an object of fields
  const input = typeof first?.input === 'string' ? { input: first.input } : first?.input
  const head = first ? (toolPreview(first.name, input) ?? first.name) : null
  const preview = head && calls.length > 1 ? `${head} (+${calls.length - 1} more)` : head
  // a cell that only patches carries the edit, as the call it wraps would have
  const artifact = first && calls.length === 1 ? toolArtifact(first.name, input) : undefined
  return {
    role: 'assistant',
    kind: 'tool_call',
    toolName: 'exec',
    text: truncate(cell, 400),
    ...(preview ? { preview: truncate(preview, 200) } : {}),
    ...(artifact ? { artifact } : {}),
    ts
  }
}

/** What a typed item says about its run, before it becomes a call row and a result row. */
type ItemCall = {
  readonly name: string
  readonly detail: string
  readonly preview?: string | null
  readonly result?: string
  readonly failed?: boolean
}

/** One typed tool item as the call row and result row a direct call would have been. */
function toolItemRows(item: any, ts: number | undefined): SessionMessage[] {
  const call = itemCall(item)
  if (!call) return []
  const failed = call.failed || (typeof item.status === 'string' && item.status !== 'completed')
  // a command that was a check carries how it ended, off the item's own exit code
  const check = item.type === 'CommandExecution' ? commandItemCheck(item) : undefined
  return [
    {
      role: 'assistant',
      kind: 'tool_call',
      toolName: call.name,
      text: truncate(call.detail, 400),
      ...(call.preview ? { preview: truncate(call.preview, 200) } : {}),
      ...(check ? { artifact: check } : {}),
      ...(failed ? { failed: true } : {}),
      ts
    },
    ...(call.result ? [{ role: 'tool', kind: 'tool_result', text: truncate(call.result, 400), ts } as const] : [])
  ]
}

function itemCall(item: any): ItemCall | null {
  switch (item?.type) {
    case 'CommandExecution': {
      const script = shellScript(item.command)
      if (!script) return null
      return { name: 'shell', detail: script, preview: shellPreview(item.command), result: commandOutput(item) }
    }
    case 'McpToolCall': {
      if (typeof item.server !== 'string' || typeof item.tool !== 'string') return null
      const args = parseArguments(item.arguments)
      return {
        name: `mcp__${item.server}__${item.tool}`,
        detail: jsonText(item.arguments ?? {}),
        preview: callTitle(args),
        result: contentToText(item.result?.content) || errorText(item.error),
        failed: item.result?.isError === true
      }
    }
    case 'DynamicToolCall': {
      if (typeof item.tool !== 'string') return null
      const ns = typeof item.namespace === 'string' && item.namespace ? `${item.namespace}__` : ''
      return {
        name: `${ns}${item.tool}`,
        detail: jsonText(item.arguments ?? {}),
        preview: callTitle(parseArguments(item.arguments)),
        result: blocksText(item.content_items),
        failed: item.success === false
      }
    }
    case 'WebSearch':
      return webSearchCall(item)
    case 'ImageView': {
      const path = localPath(item.path)
      return path ? { name: 'view_image', detail: path, preview: toolPreview('view_image', { path }) } : null
    }
    case 'Extension':
      // a kind of its own for each extension tool; a search is the one with a shape to read
      if (item.kind === 'web.search') return webSearchCall(item)
      if (typeof item.kind !== 'string' || !item.kind) return null
      if (item.kind === 'image_gen.generation') {
        const saved = typeof item.savedPath === 'string' ? item.savedPath : ''
        const prompt = typeof item.revisedPrompt === 'string' ? item.revisedPrompt : ''
        return { name: 'image_gen', detail: prompt || saved, preview: saved || null, result: saved, failed: !!item.failure }
      }
      return { name: item.kind, detail: jsonText(item) }
    default:
      return null
  }
}

/** A search's queries (a newer item runs several at once), and the pages it found. */
function webSearchCall(item: any): ItemCall | null {
  const action = item.action && typeof item.action === 'object' ? item.action : {}
  const queries: string[] = Array.isArray(action.queries)
    ? action.queries.filter((q: unknown): q is string => typeof q === 'string' && q.trim() !== '')
    : []
  const query = queries[0] ?? [action.query, item.query, action.url].find((q) => typeof q === 'string' && q.trim())
  if (!query) return null
  const head = toolPreview('web_search', { query })
  const pages = Array.isArray(item.results) ? item.results : []
  return {
    name: 'web_search',
    detail: queries.length > 0 ? queries.join('\n') : query,
    preview: head && queries.length > 1 ? `${head} (+${queries.length - 1} more)` : head,
    result: pages
      .flatMap((r: any) => (typeof r?.url === 'string' ? [typeof r.title === 'string' ? `${r.title} — ${r.url}` : r.url] : []))
      .join('\n')
  }
}

/**
 * A command's output, led by its exit status when that was a failure, so the row's
 * glance at its result reads as the verdict. A silent success still says it finished.
 */
function commandOutput(item: any): string | undefined {
  const output =
    typeof item.aggregated_output === 'string'
      ? item.aggregated_output
      : [item.stdout, item.stderr].filter((s) => typeof s === 'string' && s).join('\n')
  const code = typeof item.exit_code === 'number' ? item.exit_code : null
  if (code !== null && code !== 0) return output.trim() ? `exit ${code}\n${output}` : `exit ${code}`
  return output.trim() ? output : code === 0 ? 'exit 0' : undefined
}

/** The agent's own words for what a call is for, when its arguments carry them. */
function callTitle(args: Record<string, unknown> | null): string | null {
  for (const key of ['title', 'query', 'prompt']) {
    const v = args?.[key]
    if (typeof v === 'string' && v.trim()) return v.trim().split('\n', 1)[0]!
  }
  return null
}

/** Text blocks of any casing (`input_text`, `inputText`, `text`) — anything carrying a `text`. */
function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n')
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined
  return typeof message === 'string' ? message : ''
}

/** Codex names local files as `file://` URLs in its items. */
function localPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null
  if (!path.startsWith('file://')) return path
  try {
    return decodeURIComponent(new URL(path).pathname)
  } catch {
    return path
  }
}

/** A call's output: a string, or — newer Codex — the content blocks it answered with. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    const text = contentToText(output)
    return text || (output.some((b) => b?.type === 'input_image') ? '(image)' : '')
  }
  return jsonText(output ?? '')
}

/**
 * A rollout that is a part of another thread rather than a thread of its own.
 * `thread_source` names the kind and has grown new ones (`subagent`, then
 * `guardian_review` for the auto-reviews) — each shares the parent's session id,
 * so it inherits the parent's thread name and cwd and lists as a duplicate. The
 * structural marks outlive the naming: a subagent `source` and a `parent_thread_id`.
 * A fork (`forked_from_id`) is a thread of its own and stays.
 */
function isThreadPart(p: any): boolean {
  if (p.thread_source === 'subagent' || p.thread_source === 'guardian_review') return true
  if (p.source && typeof p.source === 'object' && 'subagent' in p.source) return true
  return typeof p.parent_thread_id === 'string' && p.parent_thread_id !== ''
}

export function parseCodexMeta(file: string, sourceLabel: string): SessionMeta | null {
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  const lines = parseJsonlText(head.text, head.truncated)
  if (lines.length === 0) return null

  let nativeId = basename(file, '.jsonl')
  let threadId: string | null = null
  let cwd: string | null = null
  let logBranch: string | null = null
  let title = ''
  let firstTs: number | null = null
  let lastTs: number | null = null
  let messageCount = 0
  let historyBase: SessionMeta['historyBase']
  const countEchoes = usesEventEchoes(lines)

  for (const l of lines) {
    const ts = toMs(l.timestamp)
    if (ts) {
      if (!firstTs) firstTs = ts
      lastTs = ts
    }
    const p = l.payload ?? l
    if (lineKind(l) === 'session_meta' || p?.originator) {
      // subagent rollouts (guardian etc.) live in the same sessions/ dirs but are
      // parts of a thread, never sessions — and archiving the parent thread moves
      // only the parent's rollout, so these would surface as phantom sessions
      if (isThreadPart(p)) return null
      if (p.id) nativeId = String(p.id)
      // The name index is keyed by thread id (continuation rollouts share it)
      if (p.session_id || p.id) threadId = String(p.session_id ?? p.id)
      cwd = usableCwd(p.cwd) ?? cwd
      // often absent — plenty of rollouts carry no `git` block at all, or one with
      // only a commit hash. The indexer reads the checkout itself when it's missing.
      if (typeof p.git?.branch === 'string' && p.git.branch) logBranch = p.git.branch
      if (!historyBase && threadId) historyBase = continuesThread(p.history_base, threadId)
    }
    const isMessage =
      isItemMessage(l) ||
      (countEchoes &&
        lineKind(l) === 'event_msg' &&
        (p?.type === 'user_message' || p?.type === 'agent_message'))
    if (isMessage) {
      messageCount++
      const role = p.role ?? (p.type === 'user_message' ? 'user' : 'assistant')
      if (!title && role === 'user') {
        const t = contentToText(p.content) || (typeof p.message === 'string' ? p.message : '')
        // skip injected preambles (XML-ish context blocks, AGENTS.md instructions)
        if (t && !t.startsWith('<') && !t.startsWith('# AGENTS.md')) title = truncate(t)
      }
    }
  }
  if (messageCount === 0) return null
  if (head.truncated) {
    messageCount = Math.max(messageCount, Math.round((messageCount * head.size) / META_HEAD_BYTES))
  }

  const home = codexHomeOf(file)
  const threadName = home && threadId ? threadNames(home).get(threadId) : undefined
  if (threadName) title = truncate(threadName)

  const ft = fileTimes(file)
  return {
    id: `codex:${nativeId}`,
    provider: 'codex',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd,
    logBranch,
    startedAt: firstTs ?? ft.start,
    updatedAt: head.truncated ? ft.end : (lastTs ?? ft.end),
    messageCount,
    sourcePath: file,
    ...(historyBase ? { historyBase } : {})
  }
}

/**
 * A paginated thread's next rollout names the one before it: its history is that
 * file up to `end_byte_offset`, then its own lines. Only a base in the *same* thread
 * is a continuation — a fork carries one too, naming the thread it forked from, and
 * a fork is a thread of its own.
 */
function continuesThread(base: any, threadId: string): SessionMeta['historyBase'] {
  if (!base || typeof base !== 'object' || String(base.thread_id ?? '') !== threadId) return undefined
  const endByte = base.end_byte_offset
  return Number.isSafeInteger(endByte) && endByte > 0 ? { endByte } : undefined
}

/**
 * A thread's transcript: its newest rollout's tail, and — while the tail budget
 * lasts — the earlier segments it continues (`SessionMeta.segments`), each read
 * only up to where the thread's history in it ends.
 */
export function parseCodexMessages(file: string, segments: readonly SessionSegment[] = []): SessionMessage[] {
  const parts: SessionMessage[][] = []
  let budget = TRANSCRIPT_TAIL_BYTES
  let truncated = false
  const reads = [{ path: file, endByte: undefined as number | undefined }, ...[...segments].reverse()]
  for (const r of reads) {
    if (budget <= 0) {
      truncated = true
      break
    }
    const tail = readJsonlTail(r.path, { maxBytes: budget, end: r.endByte })
    parts.unshift(renderLines(tail.lines))
    budget -= tail.bytes
    if (tail.truncated) {
      truncated = true
      break
    }
  }
  const out = parts.flat()
  if (truncated) {
    out.unshift({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
  }
  return out
}

/** One rollout's lines as messages — echoes are judged per file, as they are written. */
function renderLines(lines: readonly any[]): SessionMessage[] {
  const out: SessionMessage[] = []
  const renderEchoes = usesEventEchoes(lines)
  const records = toolRecords(lines)
  // where each rendered custom call's row sits: its output is rendered only after the
  // call it answers, and a cell that threw marks its own row
  const customCalls = new Map<string, number>()
  // where each direct call's row sits, for a check its output says the end of
  const directCalls = new Map<string, number>()
  for (const l of lines) {
    const ts = toMs(l.timestamp) ?? undefined
    const p = l.payload ?? l
    if (lineKind(l) === 'response_item') {
      switch (p?.type) {
        case 'message': {
          const text = contentToText(p.content)
          if (text)
            out.push({ role: p.role === 'user' ? 'user' : 'assistant', kind: 'text', text: capText(text), ts })
          break
        }
        case 'function_call': {
          // the headline is the command or the patched files; the raw arguments stay in
          // the detail, as they do for every other agent's rows
          const args = parseArguments(p.arguments)
          const preview = toolPreview(p.name ?? 'tool', args) ?? callTitle(args)
          const asks = parseAsks(p.name ?? '', args)
          const artifact = toolArtifact(p.name ?? '', args)
          if (typeof p.call_id === 'string') directCalls.set(p.call_id, out.length)
          out.push({
            role: 'assistant',
            kind: 'tool_call',
            toolName: p.name ?? 'tool',
            text: truncate(String(p.arguments ?? ''), 400),
            ...(preview ? { preview: truncate(preview, 200) } : {}),
            ...(asks ? { asks } : {}),
            ...(artifact ? { artifact } : {}),
            ts
          })
          break
        }
        case 'custom_tool_call': {
          // freeform tools take raw text rather than JSON: a code-mode cell (rendered only
          // where no items speak for its runs — see usesToolItems) or a patch
          if (p.name === 'exec' && typeof p.input === 'string') {
            if (!records.cells) break
            if (typeof p.call_id === 'string') customCalls.set(p.call_id, out.length)
            out.push(execCellRow(p.input, ts))
            break
          }
          if (p.name !== 'apply_patch' || typeof p.input !== 'string') break
          const artifact = toolArtifact('apply_patch', p.input)
          const preview = patchPreview(p.input)
          if (typeof p.call_id === 'string') customCalls.set(p.call_id, out.length)
          out.push({
            role: 'assistant',
            kind: 'tool_call',
            toolName: 'apply_patch',
            text: truncate(p.input, 400),
            ...(preview ? { preview: truncate(preview, 200) } : {}),
            ...(artifact ? { artifact } : {}),
            ts
          })
          break
        }
        case 'custom_tool_call_output': {
          const at = typeof p.call_id === 'string' ? customCalls.get(p.call_id) : undefined
          if (at === undefined) break
          const text = outputText(p.output)
          // a cell that threw did not do what it was written to do
          if (out[at]?.toolName === 'exec' && text.startsWith('Script failed')) out[at] = { ...out[at]!, failed: true }
          out.push({ role: 'tool', kind: 'tool_result', text: truncate(text, 400), ts })
          break
        }
        case 'function_call_output': {
          const text = outputText(p.output)
          const at = typeof p.call_id === 'string' ? directCalls.get(p.call_id) : undefined
          const call = at === undefined ? undefined : out[at]
          // a shell call's output states its exit code (`Process exited with code 1`)
          if (at !== undefined && call?.artifact?.kind === 'check')
            out[at] = { ...call, artifact: checkOutcome(call.artifact, { text, exitCode: exitCodeIn(text) }) }
          out.push({ role: 'tool', kind: 'tool_result', text: truncate(text, 400), ts })
          break
        }
        case 'reasoning': {
          const t = contentToText(p.summary) || contentToText(p.content)
          if (t) out.push({ role: 'assistant', kind: 'reasoning', text: truncate(t, 400), ts })
          break
        }
      }
    } else if (lineKind(l) === 'event_msg' && p?.type === 'item_completed') {
      const item = toolItemFor(l, records)
      if (item?.type === 'FileChange') {
        const row = fileChangeRow(item, ts)
        if (row) out.push(row)
      } else if (item) {
        out.push(...toolItemRows(item, ts))
      }
    } else if (lineKind(l) === 'event_msg' && renderEchoes) {
      if (p?.type === 'user_message' && p.message)
        out.push({ role: 'user', kind: 'text', text: capText(String(p.message)), ts })
      if (p?.type === 'agent_message' && p.message)
        out.push({ role: 'assistant', kind: 'text', text: capText(String(p.message)), ts })
    }
  }
  return out
}

/** Codex serialises a call's arguments as a JSON string; a malformed one has no headline. */
function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
