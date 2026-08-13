import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'

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

/** Read at most maxBytes from the END of a file (for transcript tails). */
export function readTail(
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
    const n = readSync(fd, buf, 0, maxBytes, size - maxBytes)
    return { text: buf.toString('utf8', 0, n), truncated: true, size }
  } catch {
    return { text: '', truncated: false, size: 0 }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Transcript reads are capped: a 58MB session log must never be fully parsed on the
 * main process. Tail keeps the most recent conversation; the first (possibly partial)
 * line is dropped when truncated.
 */
export const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024

export function readJsonlTail(file: string): { lines: any[]; truncated: boolean } {
  const tail = readTail(file, TRANSCRIPT_TAIL_BYTES)
  if (!tail.text) return { lines: [], truncated: false }
  let text = tail.text
  if (tail.truncated) {
    const nl = text.indexOf('\n')
    text = nl >= 0 ? text.slice(nl + 1) : ''
  }
  return { lines: parseJsonlText(text, false), truncated: tail.truncated }
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

/** Recursively list files under dir (depth-limited), tolerant of missing dirs. */
export function walkFiles(dir: string, maxDepth = 6): string[] {
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
    case 'Write':
    case 'Read':
      return str(i.file_path)
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
      return str(i.query)
    case 'Task':
      return str(i.description) ?? str(i.prompt)
    case 'Skill':
      return str(i.skill)
    default:
      return null
  }
}
