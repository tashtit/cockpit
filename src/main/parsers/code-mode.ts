/**
 * Codex's code mode: rather than call a tool, the model writes a JavaScript cell for its
 * `exec` tool, and the cell calls the tools —
 * `const r = await tools.exec_command({cmd: "npm test", workdir: "/r"}); text(r.output)`.
 *
 * Reading a cell is not running it. Only as much of JavaScript is understood as it takes
 * to find each `tools.<name>(` call and the literal fields of its first argument, which is
 * what a headline is made of: quoted and template strings (a `${…}` stays as written),
 * numbers and booleans. Anything computed is skipped. The cell is model-written and may
 * not even parse, so a confusing stretch yields what was found before it rather than an
 * error, and the read is bounded — a cell carrying a whole patch can be long.
 */

/** A cell longer than this is read only this far: its first calls are what a row names */
const MAX_CELL_CHARS = 64 * 1024
/** A headline names the first call and counts the rest; past this many they are not looked for */
const MAX_CALLS = 32
/** Fields read off one call's argument object */
const MAX_FIELDS = 32

export type CellValue = string | number | boolean | null

export type CellCall = {
  readonly name: string
  /** The first argument: an object's literal fields, a bare string (apply_patch's patch), or null */
  readonly input: Readonly<Record<string, CellValue>> | string | null
}

/** The tools a cell calls, in the order they are written. */
export function cellToolCalls(cell: string): CellCall[] {
  const s = cell.length > MAX_CELL_CHARS ? cell.slice(0, MAX_CELL_CHARS) : cell
  const calls: CellCall[] = []
  try {
    // the last significant character: whether a `/` opens a regex or divides
    let prev = ''
    let i = 0
    while (i < s.length && calls.length < MAX_CALLS) {
      const c = s[i]!
      if (c === '"' || c === "'" || c === '`') {
        i = readString(s, i).end
        prev = c
      } else if (c === '/' && (s[i + 1] === '/' || s[i + 1] === '*')) {
        i = skipComment(s, i)
      } else if (c === '/' && REGEX_AFTER.includes(prev)) {
        i = skipRegex(s, i)
        prev = '/'
      } else if (ID_START.test(c)) {
        const end = identEnd(s, i)
        const found = s.slice(i, end) === 'tools' && s[i - 1] !== '.' ? toolsCall(s, end) : null
        if (found) calls.push(found.call)
        // a call's arguments are read on, so the calls nested in them are found in order
        i = found ? found.args : end
        prev = found ? '(' : 'a'
      } else {
        if (!/\s/.test(c)) prev = c
        i++
      }
    }
  } catch {
    // a cell nested deeper than the stack: what was found before it stands
  }
  return calls
}

const ID_START = /[A-Za-z_$]/
const ID_PART = /[\w$]/
/** After one of these (or at the start), a `/` begins a regex literal rather than dividing */
const REGEX_AFTER = ['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']

function identEnd(s: string, i: number): number {
  let j = i + 1
  while (j < s.length && ID_PART.test(s[j]!)) j++
  return j
}

function skipSpace(s: string, i: number): number {
  let j = i
  for (;;) {
    while (j < s.length && /\s/.test(s[j]!)) j++
    if (s[j] === '/' && (s[j + 1] === '/' || s[j + 1] === '*')) j = skipComment(s, j)
    else return j
  }
}

/** `tools . name (` from just after `tools`: the call, and where its arguments start. */
function toolsCall(s: string, at: number): { readonly call: CellCall; readonly args: number } | null {
  let j = skipSpace(s, at)
  if (s[j] !== '.') return null
  j = skipSpace(s, j + 1)
  if (!ID_START.test(s[j] ?? '')) return null
  const end = identEnd(s, j)
  const name = s.slice(j, end)
  const open = skipSpace(s, end)
  if (s[open] !== '(') return null
  return { call: { name, input: readArgument(s, open + 1) }, args: open + 1 }
}

function readArgument(s: string, i: number): CellCall['input'] {
  const j = skipSpace(s, i)
  const c = s[j]
  if (c === '"' || c === "'" || c === '`') return literalAt(s, j)?.value ?? null
  if (c === '{') return readFields(s, j)
  return null
}

/**
 * A string that is the whole value — not the start of `"a" + b` or `"a".trim()`, which
 * only running the cell could answer — and where it ends.
 */
function literalAt(s: string, i: number): { readonly value: string; readonly end: number } | null {
  const lit = readString(s, i)
  if (lit.broken) return null
  const next = s[skipSpace(s, lit.end)]
  return next === undefined || ',})]'.includes(next) ? lit : null
}

/** The literal fields of the object literal at `i`, as far as they can be read. */
function readFields(s: string, i: number): Record<string, CellValue> {
  const fields: Record<string, CellValue> = {}
  let j = i + 1
  for (let n = 0; n < MAX_FIELDS * 2; n++) {
    j = skipSpace(s, j)
    const c = s[j]
    if (c === undefined || c === '}') break
    if (c === ',') {
      j++
      continue
    }
    let key: string | null = null
    if (c === '"' || c === "'") {
      const lit = readString(s, j)
      key = lit.value
      j = lit.end
    } else if (ID_START.test(c)) {
      const end = identEnd(s, j)
      key = s.slice(j, end)
      j = end
    } else {
      // a spread or a computed key: whatever it is, its value is not a literal
      j = scanTo(s, j + 1, ',}')
      continue
    }
    j = skipSpace(s, j)
    if (s[j] !== ':') {
      // shorthand (`{cmd}` names a variable) or a method: nothing to read
      j = s[j] === ',' || s[j] === '}' ? j : scanTo(s, j, ',}')
      continue
    }
    j = skipSpace(s, j + 1)
    const value = valueAt(s, j)
    if (value && key !== '__proto__') fields[key] = value.value
    j = value ? value.end : scanTo(s, j, ',}')
  }
  return fields
}

function valueAt(s: string, i: number): { readonly value: CellValue; readonly end: number } | null {
  const c = s[i]
  if (c === '"' || c === "'" || c === '`') return literalAt(s, i)
  const m = /^(?:-?\d+(?:\.\d+)?|true|false|null)(?![\w$.])/.exec(s.slice(i, i + 32))
  if (!m) return null
  const word = m[0]
  const next = s[skipSpace(s, i + word.length)]
  if (next !== undefined && !',})]'.includes(next)) return null
  const value = word === 'true' ? true : word === 'false' ? false : word === 'null' ? null : Number(word)
  return { value, end: i + word.length }
}

/** The quoted or template string at `i`, unescaped; `broken` when it never closes. */
function readString(s: string, i: number): { readonly value: string; readonly end: number; readonly broken?: true } {
  const quote = s[i]!
  let value = ''
  let j = i + 1
  while (j < s.length) {
    const c = s[j]!
    if (c === quote) return { value, end: j + 1 }
    if (c === '\\') {
      const e = unescape(s, j)
      value += e.text
      j = e.next
    } else if (quote === '`' && c === '$' && s[j + 1] === '{') {
      const close = scanTo(s, j + 2, '}')
      value += s.slice(j, close + 1)
      j = close + 1
    } else if (c === '\n' && quote !== '`') {
      // a quote that never closes on its line was never a string: a regex or comment misread
      break
    } else {
      value += c
      j++
    }
  }
  return { value, end: j, broken: true }
}

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['b', '\b'],
  ['f', '\f'],
  ['v', '\v'],
  ['0', '\0']
])

function unescape(s: string, j: number): { readonly text: string; readonly next: number } {
  const c = s[j + 1]
  if (c === undefined) return { text: '', next: j + 1 }
  if (c === '\n') return { text: '', next: j + 2 }
  const simple = ESCAPES.get(c)
  if (simple !== undefined) return { text: simple, next: j + 2 }
  if (c === 'x' && /^[0-9a-f]{2}$/i.test(s.slice(j + 2, j + 4))) {
    return { text: String.fromCharCode(parseInt(s.slice(j + 2, j + 4), 16)), next: j + 4 }
  }
  if (c === 'u' && s[j + 2] === '{') {
    const close = s.indexOf('}', j + 3)
    const hex = close > 0 ? s.slice(j + 3, close) : ''
    if (/^[0-9a-f]{1,6}$/i.test(hex) && parseInt(hex, 16) <= 0x10ffff) {
      return { text: String.fromCodePoint(parseInt(hex, 16)), next: close + 1 }
    }
  } else if (c === 'u' && /^[0-9a-f]{4}$/i.test(s.slice(j + 2, j + 6))) {
    return { text: String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16)), next: j + 6 }
  }
  return { text: c, next: j + 2 }
}

function skipComment(s: string, i: number): number {
  if (s[i + 1] === '/') {
    const nl = s.indexOf('\n', i + 2)
    return nl < 0 ? s.length : nl
  }
  const close = s.indexOf('*/', i + 2)
  return close < 0 ? s.length : close + 2
}

function skipRegex(s: string, i: number): number {
  let inClass = false
  let j = i + 1
  while (j < s.length) {
    const c = s[j]!
    if (c === '\n') return i + 1 // not a regex after all: read on as code
    if (c === '\\') j += 2
    else {
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) return identEnd(s, j)
      j++
    }
  }
  return s.length
}

/** Where the first of `stops` sits at nesting depth 0 from `i`, skipping strings and comments. */
function scanTo(s: string, i: number, stops: string): number {
  let depth = 0
  let j = i
  while (j < s.length) {
    const c = s[j]!
    if (c === '"' || c === "'" || c === '`') {
      j = readString(s, j).end
      continue
    }
    if (c === '/' && (s[j + 1] === '/' || s[j + 1] === '*')) {
      j = skipComment(s, j)
      continue
    }
    if (depth === 0 && stops.includes(c)) return j
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return j
      depth--
    }
    j++
  }
  return s.length
}
