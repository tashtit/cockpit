/*
 * A reader for TOML that is going to be edited, not just understood.
 *
 * Codex keeps its whole configuration in one config.toml — model providers, profiles,
 * trusted projects, MCP servers — and Cockpit only ever edits the servers. Writing the
 * file back out from a parsed tree would reformat and reorder everything else the user
 * wrote, so this reader records where each table and each key sits in the text: an
 * edit is a splice, and every byte it doesn't touch stays as it was.
 *
 * Tolerant, like the session parsers: a statement this reader can't make sense of is
 * skipped, never fatal to the file. It is not a validator either — a key defined twice
 * is Codex's to refuse. Pure and IO-free.
 */

export type TomlValue =
  | string
  | number
  | boolean
  | readonly TomlValue[]
  | { readonly [key: string]: TomlValue }

/** Where a piece of the text sits: `[start, end)`. */
export type TomlSpan = { readonly start: number; readonly end: number }

export type TomlKeyValue = TomlSpan & {
  /** the key as written, a dotted key split into its parts */
  readonly key: readonly string[]
  /** undefined when the value couldn't be read */
  readonly value: TomlValue | undefined
  /** the value's own text, without the key or a trailing comment */
  readonly valueSpan: TomlSpan
  /** an array value's elements, each where it sits */
  readonly items?: readonly TomlSpan[]
}

/**
 * One table and the keys under it. The first section is the keys above any header
 * (an empty path). Sections tile the text: each runs to where the next one starts,
 * and a comment written directly above a header belongs to that header's section.
 */
export type TomlSection = TomlSpan & {
  readonly path: readonly string[]
  /** `[[path]]`: one element of an array of tables */
  readonly array: boolean
  /** where the section's keys start — past its header line */
  readonly bodyStart: number
  readonly keys: readonly TomlKeyValue[]
}

/** A statement that doesn't parse: the scanner skips its line and carries on. */
class Unreadable extends Error {}

type Read = { readonly value: TomlValue; readonly end: number; readonly items?: TomlSpan[] }

export function scanToml(text: string): TomlSection[] {
  const sections: TomlSection[] = []
  let open = { path: [] as string[], array: false, start: 0, bodyStart: 0, keys: [] as TomlKeyValue[] }
  // where the last statement ended: a header's leading comments never reach above it
  let floor = 0
  let pos = 0
  while (pos < text.length) {
    const lineStart = pos
    pos = skipSpaces(text, pos)
    const c = text[pos]
    if (c === undefined) break
    if (c === '\n' || c === '\r' || c === '#') {
      pos = nextLine(text, pos)
      continue
    }
    try {
      if (c === '[') {
        const header = readHeader(text, pos)
        const end = endOfStatement(text, header.end)
        const start = leadingComments(text, lineStart, floor)
        sections.push({ ...open, end: start })
        open = { path: header.path, array: header.array, start, bodyStart: end, keys: [] }
        floor = pos = end
        continue
      }
      const key = readKey(text, pos)
      if (text[key.end] !== '=') throw new Unreadable()
      const valueStart = skipSpaces(text, key.end + 1)
      const read = readValue(text, valueStart)
      const end = endOfStatement(text, read.end)
      open.keys.push({
        key: key.path,
        value: read.value,
        valueSpan: { start: valueStart, end: read.end },
        ...(read.items ? { items: read.items } : {}),
        start: lineStart,
        end
      })
      floor = pos = end
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err
      pos = nextLine(text, lineStart)
    }
  }
  sections.push({ ...open, end: text.length })
  return sections
}

/* ---------- lines ---------- */

function skipSpaces(text: string, pos: number): number {
  while (text[pos] === ' ' || text[pos] === '\t') pos++
  return pos
}

/** Past spaces, newlines and comments — what may sit between an array's elements. */
function skipBlank(text: string, pos: number): number {
  for (;;) {
    const c = text[pos]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') pos++
    else if (c === '#') pos = nextLine(text, pos)
    else return pos
  }
}

function nextLine(text: string, pos: number): number {
  const nl = text.indexOf('\n', pos)
  return nl === -1 ? text.length : nl + 1
}

/** Past the rest of a statement's line: only a comment may follow the value. */
function endOfStatement(text: string, pos: number): number {
  pos = skipSpaces(text, pos)
  if (text[pos] === '#') return nextLine(text, pos)
  if (text[pos] === '\r' && text[pos + 1] === '\n') return pos + 2
  if (text[pos] === '\n') return pos + 1
  if (pos >= text.length) return pos
  throw new Unreadable()
}

/** The comment lines directly above a header, which are about that header. */
function leadingComments(text: string, lineStart: number, floor: number): number {
  let start = lineStart
  while (start > floor) {
    const prev = text.lastIndexOf('\n', start - 2) + 1
    if (prev < floor || !/^[ \t]*#/.test(text.slice(prev, start))) break
    start = prev
  }
  return start
}

/* ---------- keys ---------- */

const BARE_KEY = /[A-Za-z0-9_-]+/y

/** A dotted key; `end` is past the spaces that follow it. */
function readKey(text: string, pos: number): { path: string[]; end: number } {
  const path: string[] = []
  for (;;) {
    pos = skipSpaces(text, pos)
    const c = text[pos]
    if (c === '"') {
      const s = basicString(text, pos)
      path.push(s.value)
      pos = s.end
    } else if (c === "'") {
      const s = literalString(text, pos)
      path.push(s.value)
      pos = s.end
    } else {
      BARE_KEY.lastIndex = pos
      const m = BARE_KEY.exec(text)
      if (!m) throw new Unreadable()
      path.push(m[0])
      pos += m[0].length
    }
    pos = skipSpaces(text, pos)
    if (text[pos] !== '.') return { path, end: pos }
    pos++
  }
}

function readHeader(text: string, pos: number): { path: string[]; array: boolean; end: number } {
  const array = text[pos + 1] === '['
  const key = readKey(text, pos + (array ? 2 : 1))
  const close = array ? ']]' : ']'
  if (!text.startsWith(close, key.end)) throw new Unreadable()
  return { path: key.path, array, end: key.end + close.length }
}

/* ---------- values ---------- */

function readValue(text: string, pos: number): Read {
  const c = text[pos]
  if (text.startsWith('"""', pos)) return multilineString(text, pos, '"""')
  if (text.startsWith("'''", pos)) return multilineString(text, pos, "'''")
  if (c === '"') return basicString(text, pos)
  if (c === "'") return literalString(text, pos)
  if (c === '[') return array(text, pos)
  if (c === '{') return inlineTable(text, pos)
  return bare(text, pos)
}

function basicString(text: string, pos: number): { value: string; end: number } {
  for (let i = pos + 1; i < text.length; i++) {
    const c = text[i]
    if (c === '\n' || c === '\r') break
    if (c === '\\') i++
    else if (c === '"') return { value: tomlUnescape(text.slice(pos + 1, i)), end: i + 1 }
  }
  throw new Unreadable()
}

function literalString(text: string, pos: number): { value: string; end: number } {
  const close = text.indexOf("'", pos + 1)
  const nl = text.indexOf('\n', pos + 1)
  if (close === -1 || (nl !== -1 && nl < close)) throw new Unreadable()
  return { value: text.slice(pos + 1, close), end: close + 1 }
}

/** `"""…"""` or `'''…'''`. Up to two quotes may sit against the closing three. */
function multilineString(text: string, pos: number, quotes: '"""' | "'''"): Read {
  const basic = quotes === '"""'
  for (let i = pos + 3; i < text.length; i++) {
    if (basic && text[i] === '\\') {
      i++
      continue
    }
    if (!text.startsWith(quotes, i)) continue
    let end = i + 3
    while (text[end] === quotes[0] && end - i < 5) end++
    // a newline right after the opening quotes is not part of the value
    const body = text.slice(pos + 3, end - 3).replace(/^\r?\n/, '')
    return { value: basic ? tomlUnescape(body) : body, end }
  }
  throw new Unreadable()
}

function array(text: string, pos: number): Read {
  const value: TomlValue[] = []
  const items: TomlSpan[] = []
  let i = skipBlank(text, pos + 1)
  while (text[i] !== ']') {
    const read = readValue(text, i)
    value.push(read.value)
    items.push({ start: i, end: read.end })
    i = skipBlank(text, read.end)
    if (text[i] === ',') i = skipBlank(text, i + 1)
    else if (text[i] !== ']') throw new Unreadable()
  }
  return { value, end: i + 1, items }
}

/** `{ a = 1, b.c = "x" }` — newlines and a trailing comma allowed, as TOML 1.1 does. */
function inlineTable(text: string, pos: number): Read {
  const value: Record<string, TomlValue> = {}
  let i = skipBlank(text, pos + 1)
  while (text[i] !== '}') {
    const key = readKey(text, i)
    if (text[key.end] !== '=') throw new Unreadable()
    const read = readValue(text, skipSpaces(text, key.end + 1))
    assignPath(value, key.path, read.value)
    i = skipBlank(text, read.end)
    if (text[i] === ',') i = skipBlank(text, i + 1)
    else if (text[i] !== '}') throw new Unreadable()
  }
  return { value, end: i + 1 }
}

/** Numbers, booleans, dates: everything up to the next delimiter. Dates stay text. */
function bare(text: string, pos: number): Read {
  let end = pos
  while (end < text.length && !',]}#\n\r'.includes(text[end])) end++
  const token = text.slice(pos, end).trimEnd()
  if (token === '') throw new Unreadable()
  return { value: scalar(token), end: pos + token.length }
}

function scalar(token: string): TomlValue {
  if (token === 'true') return true
  if (token === 'false') return false
  const plain = token.replace(/_/g, '')
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(plain)) return Number(plain)
  if (/^0x[0-9A-Fa-f]+$/.test(plain)) return parseInt(plain.slice(2), 16)
  if (/^0o[0-7]+$/.test(plain)) return parseInt(plain.slice(2), 8)
  if (/^0b[01]+$/.test(plain)) return parseInt(plain.slice(2), 2)
  if (/^[+-]?inf$/.test(token)) return token.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/.test(token)) return NaN
  return token
}

/**
 * Set `path` inside a table, making the tables on the way. A key read from a file
 * is data: `__proto__` becomes an ordinary key rather than a new prototype.
 */
export function assignPath(target: Record<string, TomlValue>, path: readonly string[], value: TomlValue): void {
  let table = target
  for (const [i, key] of path.entries()) {
    const last = i === path.length - 1
    const had = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
    const next = last ? value : isTomlTable(had) ? had : {}
    Object.defineProperty(table, key, { value: next, enumerable: true, writable: true, configurable: true })
    if (!last) table = next as Record<string, TomlValue>
  }
}

export function isTomlTable(v: unknown): v is Record<string, TomlValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/* ---------- strings in and out ---------- */

const TOML_UNESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\x1b',
  '"': '"',
  '\\': '\\'
}

/**
 * The escapes of a TOML basic string, undone — the reader's half of `tomlString`.
 * A backslash ending a line (multi-line strings only) swallows the whitespace after it.
 */
function tomlUnescape(s: string): string {
  return s.replace(
    /\\([ \t]*\r?\n[ \t\r\n]*|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2}|.)/g,
    (whole, e: string) => {
      if (e.includes('\n')) return ''
      if (e.length === 1) return TOML_UNESCAPES[e] ?? e
      const code = parseInt(e.slice(1), 16)
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
  )
}

const TOML_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r'
}

/**
 * A TOML basic string. Control characters must be escaped too — a raw newline in an
 * env value (a PEM key, a service-account JSON) makes the whole config.toml one Codex
 * refuses to load, and Codex then won't start at all.
 */
export function tomlString(s: string): string {
  const body = s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    const named = TOML_ESCAPES[c]
    return named ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  return `"${body}"`
}

/** A TOML key can only be bare if it matches this — anything else must be quoted. */
const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/

/** One key, quoted unless it is a valid bare key (dotted names must be quoted). */
export function tomlKey(key: string): string {
  return BARE_TOML_KEY.test(key) ? key : tomlString(key)
}

export function tomlKeyPath(path: readonly string[]): string {
  return path.map(tomlKey).join('.')
}

/** A value written back out: enough to round-trip what this reader produces. */
export function tomlValue(v: TomlValue): string {
  if (typeof v === 'string') return tomlString(v)
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan'
    return Number.isFinite(v) ? String(v) : v > 0 ? 'inf' : '-inf'
  }
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`
  const entries = Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`)
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
}
