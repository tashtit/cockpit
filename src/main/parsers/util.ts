import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionMeta } from '../../shared/types'

/**
 * Read at most maxBytes from the start of a file. Session logs put their metadata
 * in the first lines — this lets meta parsing stay O(1) even for 50MB+ transcripts.
 */
export function readHead(
  file: string,
  maxBytes: number
): { text: string; truncated: boolean; size: number } {
  let fd: number | null = null
  try {
    const size = statSync(file).size
    if (size <= maxBytes) {
      return { text: readFileSync(file, 'utf8'), truncated: false, size }
    }
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return { text: buf.toString('utf8', 0, n), truncated: true, size }
  } catch {
    return { text: '', truncated: false, size: 0 }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Parse JSONL text into objects, skipping malformed lines. dropLast trims a truncated tail line. */
export function parseJsonlText(text: string, dropLast: boolean): any[] {
  const lines = text.split('\n')
  if (dropLast) lines.pop()
  const out: any[] = []
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* tolerate partial/corrupt lines */
    }
  }
  return out
}

/**
 * Read at most maxBytes from the END of a file (for transcript tails) — or from the
 * end of its first `end` bytes, for a file whose meaningful content stops there.
 */
export function readTail(
  file: string,
  maxBytes: number,
  end?: number
): { text: string; truncated: boolean; size: number } {
  let fd: number | null = null
  try {
    const size = Math.min(statSync(file).size, end ?? Infinity)
    if (size === 0) return { text: '', truncated: false, size }
    if (size <= maxBytes && end === undefined) {
      return { text: readFileSync(file, 'utf8'), truncated: false, size }
    }
    const want = Math.min(size, maxBytes)
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(want)
    const n = readSync(fd, buf, 0, want, size - want)
    return { text: buf.toString('utf8', 0, n), truncated: size > maxBytes, size }
  } catch {
    return { text: '', truncated: false, size: 0 }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Every file a session's log spans, oldest first: a thread's earlier pages, then `sourcePath`. */
export function sessionLogFiles(meta: Pick<SessionMeta, 'sourcePath' | 'segments'>): string[] {
  return [...(meta.segments ?? []).map((s) => s.path), meta.sourcePath]
}

/**
 * Transcript reads are capped: a 58MB session log must never be fully parsed on the
 * main process. Tail keeps the most recent conversation; the first (possibly partial)
 * line is dropped when truncated.
 */
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024

/** `bytes` is how much of the budget the read spent — what a multi-file read has left. */
export function readJsonlTail(
  file: string,
  opts: { readonly maxBytes?: number; readonly end?: number } = {}
): { lines: any[]; truncated: boolean; bytes: number } {
  const maxBytes = opts.maxBytes ?? TRANSCRIPT_TAIL_BYTES
  const tail = readTail(file, maxBytes, opts.end)
  if (!tail.text) return { lines: [], truncated: false, bytes: 0 }
  let text = tail.text
  if (tail.truncated) {
    const nl = text.indexOf('\n')
    text = nl >= 0 ? text.slice(nl + 1) : ''
  }
  return {
    lines: parseJsonlText(text, false),
    truncated: tail.truncated,
    bytes: Math.min(tail.size, maxBytes)
  }
}

/**
 * Slice without splitting a surrogate pair — `.slice()` counts UTF-16 code units,
 * so cutting mid-emoji leaves a lone surrogate that renders as U+FFFD.
 */
function sliceCodePoints(s: string, end: number): string {
  const cut = end > 0 && end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1]) ? end - 1 : end
  return s.slice(0, cut)
}

/** Cap a single message's text so one giant tool dump can't blow up the IPC payload. */
export function capText(s: string, max = 20_000): string {
  if (s.length <= max) return s
  const kept = sliceCodePoints(s, max)
  return kept + `\n… (${s.length - kept.length} more chars)`
}

/**
 * Recursively list files under dir (depth-limited), tolerant of missing dirs.
 * Symlinks are never followed — `isFile()` is false for them, which is what keeps
 * a link inside a walked directory from pulling in whatever it points at.
 * `skip` names directories to leave out entirely (`.git`, `node_modules`).
 */
export function walkFiles(
  dir: string,
  maxDepth = 6,
  opts: { readonly skip?: readonly string[] } = {}
): string[] {
  const skip = new Set(opts.skip ?? [])
  const out: string[] = []
  const stack: Array<{ d: string; depth: number }> = [{ d: dir, depth: 0 }]
  while (stack.length) {
    const { d, depth } = stack.pop()!
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory() && depth < maxDepth) stack.push({ d: p, depth: depth + 1 })
      else if (e.isFile()) out.push(p)
    }
  }
  return out
}

/** Parse a JSONL file into objects, skipping malformed lines (format drift tolerance). */
export function readJsonl(file: string): any[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: any[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* tolerate partial/corrupt lines (file may be mid-write) */
    }
  }
  return out
}

export function readJson(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Agent config files are hand-editable and some (copilot's config.json) ship with
 * leading `//` comment lines. Parse those tolerantly — a strict parse turns one
 * comment into "no config at all", which reads as a wiped inventory.
 */
export function parseJsonc(raw: string): any | null {
  try {
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
  } catch {
    return null
  }
}

/** readJson for hand-editable agent configs; tolerates `//` comment lines. */
export function readJsoncFile(file: string): any | null {
  try {
    return parseJsonc(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function fileTimes(file: string): { start: number; end: number } {
  try {
    const s = statSync(file)
    return { start: s.birthtimeMs || s.mtimeMs, end: s.mtimeMs }
  } catch {
    const now = Date.now()
    return { start: now, end: now }
  }
}

export function toMs(v: unknown): number | null {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const n = Date.parse(v)
    if (!Number.isNaN(n)) return n
  }
  return null
}

/** Extract plain text from a message content field that may be a string or a block array. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b
        if (b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text')
          return b.text ?? ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export function truncate(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? sliceCodePoints(one, n - 1) + '…' : one
}

/**
 * Human-scannable one-liner for a tool call: the command for shell tools, the path
 * for file tools — not the raw JSON input (that stays in the expanded detail).
 * Returns null for tools without an obvious headline field (MCP tools, unknowns).
 */
export function toolPreview(name: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
  switch (name) {
    case 'Bash':
      return str(i.command)
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
      return str(i.file_path)
    // the to-do tools: what the list became, not the list as JSON
    case 'TodoWrite':
    case 'update_plan': {
      const list = Array.isArray(i.todos) ? i.todos : Array.isArray(i.plan) ? i.plan : null
      return list ? `${list.length} ${list.length === 1 ? 'step' : 'steps'}` : null
    }
    case 'TaskCreate':
      return str(i.subject)
    case 'TaskUpdate': {
      const id = typeof i.taskId === 'string' || typeof i.taskId === 'number' ? String(i.taskId) : null
      const status = str(i.status)
      return id ? `#${id}${status ? ` → ${status.replace(/_/g, ' ')}` : ''}` : null
    }
    case 'NotebookEdit':
      return str(i.notebook_path)
    case 'Grep': {
      const pattern = str(i.pattern)
      const path = str(i.path)
      return pattern && path ? `${pattern} in ${path}` : pattern
    }
    case 'Glob':
      return str(i.pattern)
    case 'WebFetch':
      return str(i.url)
    case 'WebSearch':
    case 'web_search':
      return str(i.query)
    // Claude's subagent tool: `Task` before it was renamed `Agent`
    case 'Task':
    case 'Agent':
      return str(i.description) ?? str(i.prompt)
    case 'Skill':
      return str(i.skill)
    // the calls that stop and wait for the person: the headline is what was asked
    // (the options themselves render as picks — see SessionMessage.asks)
    case 'AskUserQuestion':
    case 'request_user_input': {
      const first = Array.isArray(i.questions) ? i.questions[0] : null
      const q = first && typeof first === 'object' ? (first as Record<string, unknown>) : null
      return str(q?.question) ?? str(q?.title) ?? str(q?.header) ?? 'waiting for your answer'
    }
    case 'ExitPlanMode':
    case 'exit_plan_mode':
      return 'waiting for the plan to be approved'
    // Codex: the command array (or string) it hands a shell, and apply_patch bodies
    case 'shell':
    case 'exec_command':
    case 'local_shell':
      return shellPreview(i.command ?? i.cmd)
    case 'apply_patch':
      return patchPreview(String(i.input ?? i.patch ?? ''))
    case 'view_image':
      return str(i.path)
    // Copilot CLI's own tool names (lowercase, `path` rather than `file_path`)
    case 'bash':
      return str(i.command) ?? str(i.cmd)
    case 'view':
    case 'create':
    case 'edit':
    case 'str_replace':
    case 'str_replace_editor':
      return str(i.path)
    // the Claude app's suggestions of work for later, and taking one back
    case 'mcp__ccd_session__spawn_task':
      return str(i.title)
    case 'mcp__ccd_session__dismiss_task':
      return str(i.reason) ?? 'withdrew a suggestion'
    // Copilot's to-do list and scratch tables: the call says what it is doing, the
    // query stays in the detail
    case 'sql':
      return str(i.description) ?? str(i.query)
    default:
      return null
  }
}

/**
 * What a shell call actually ran. Codex wraps every command in its shell — as an array
 * (`["bash", "-lc", "npm test"]`) in its logs and as a string (`bash -lc "npm test"`) in its
 * event stream — so the headline is the script inside, and an apply_patch script is named
 * by the files it touches rather than printed as a heredoc.
 */
export function shellPreview(command: unknown): string | null {
  const script = shellScript(command)
  if (script === null) return null
  const patch = patchPreview(script)
  if (patch) return patch
  const first = script.trim().split('\n', 1)[0]?.trim()
  return first || null
}

/** The whole script inside a Codex shell command, unwrapped as `shellPreview` reads it. */
export function shellScript(command: unknown): string | null {
  if (Array.isArray(command)) {
    const parts = command.map(String)
    const shell = parts[0]?.split('/').pop() ?? ''
    return parts.length >= 3 && /^(ba|z|da)?sh$/.test(shell) && /^-l?c$/.test(parts[1] ?? '')
      ? parts.slice(2).join(' ')
      : parts.join(' ')
  }
  if (typeof command === 'string') {
    const wrapped = command.match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/)
    return wrapped ? (wrapped[2] ?? '') : command
  }
  return null
}

/** `apply_patch src/a.ts, src/b.ts` — the paths a patch body adds, updates or deletes. */
export function patchPreview(text: string): string | null {
  const paths = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim())
  return paths.length > 0 ? `apply_patch ${paths.join(', ')}` : null
}
