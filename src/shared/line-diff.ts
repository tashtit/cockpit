/*
 * Line diff for the renderer (pure, no DOM). Small inputs are the norm here — a
 * shared-instructions block is a few dozen lines — so the algorithm is the plain
 * longest-common-subsequence table over whatever remains after the common head and
 * tail are peeled off. That keeps the table tiny for the usual "one paragraph
 * changed" edit; a pathological pair falls back to "everything out, everything in"
 * rather than allocating a table the renderer would feel.
 */

export type DiffOp = 'same' | 'add' | 'del'

export type DiffLine = { readonly op: DiffOp; readonly text: string }

/** A run of unchanged lines hidden behind an "n unchanged lines" row. */
export type DiffFold = { readonly op: 'fold'; readonly lines: readonly DiffLine[] }

export type DiffRow = DiffLine | DiffFold

/** Text → lines, ignoring the blank padding a trim would remove; '' → no lines. */
export function splitLines(text: string): string[] {
  const t = text.trim()
  return t === '' ? [] : t.split('\n')
}

/** Append one array to another. Never `out.push(...items)`: a spread passes every item as
 *  its own call argument, and past ~100k lines that overflows the stack (RangeError). */
function pushAll<T>(out: T[], items: readonly T[]): void {
  for (const item of items) out.push(item)
}

/** Beyond this many table cells the LCS is not worth its memory — see fallback. */
const MAX_TABLE_CELLS = 1_000_000

export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  let head = 0
  const max = Math.min(before.length, after.length)
  while (head < max && before[head] === after[head]) head++
  let tail = 0
  while (
    tail < max - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  const a = before.slice(head, before.length - tail)
  const b = after.slice(head, after.length - tail)

  const out: DiffLine[] = before.slice(0, head).map((text) => ({ op: 'same', text }))
  pushAll(out, middle(a, b))
  for (const text of before.slice(before.length - tail)) out.push({ op: 'same', text })
  return out
}

function middle(a: readonly string[], b: readonly string[]): DiffLine[] {
  if (a.length === 0) return b.map((text) => ({ op: 'add', text }))
  if (b.length === 0) return a.map((text) => ({ op: 'del', text }))
  if ((a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) {
    return [...a.map((text): DiffLine => ({ op: 'del', text })), ...b.map((text): DiffLine => ({ op: 'add', text }))]
  }
  const w = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * w)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      lcs[i * w + j] =
        a[i - 1] === b[j - 1]
          ? lcs[(i - 1) * w + j - 1] + 1
          : Math.max(lcs[(i - 1) * w + j], lcs[i * w + j - 1])
    }
  }
  const rev: DiffLine[] = []
  let i = a.length
  let j = b.length
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      rev.push({ op: 'same', text: a[--i] })
      j--
    } else if (j > 0 && (i === 0 || lcs[i * w + j - 1] >= lcs[(i - 1) * w + j])) {
      rev.push({ op: 'add', text: b[--j] })
    } else {
      rev.push({ op: 'del', text: a[--i] })
    }
  }
  return groupChanges(rev.reverse())
}

/** Within each changed stretch, removed lines read first, then added — a hunk, not a zipper. */
function groupChanges(lines: readonly DiffLine[]): DiffLine[] {
  const out: DiffLine[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    pushAll(out, dels)
    pushAll(out, adds)
    dels = []
    adds = []
  }
  for (const line of lines) {
    if (line.op === 'same') {
      flush()
      out.push(line)
    } else if (line.op === 'del') dels.push(line)
    else adds.push(line)
  }
  flush()
  return out
}

/** Runs of this many unchanged lines or more, beyond the context, are folded. */
const MIN_FOLD = 3

/**
 * Keep `context` unchanged lines around every change; fold the longer quiet runs
 * between them. A run too short to be worth a fold row is simply shown.
 */
export function foldUnchanged(lines: readonly DiffLine[], context = 2): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, i) => {
    if (line.op === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true
    }
  })
  const rows: DiffRow[] = []
  let run: DiffLine[] = []
  const flush = (): void => {
    if (run.length >= MIN_FOLD) rows.push({ op: 'fold', lines: run })
    else pushAll(rows, run)
    run = []
  }
  lines.forEach((line, i) => {
    if (keep[i]) {
      flush()
      rows.push(line)
    } else run.push(line)
  })
  flush()
  return rows
}

/** One row of a side-by-side diff: what was there on the left, what will be on the right. */
export type DiffPair = {
  readonly op: 'pair'
  readonly left: DiffLine | null
  readonly right: DiffLine | null
}

export type SplitRow = DiffPair | DiffFold

/**
 * Unified rows → side-by-side rows. Within a changed stretch the n-th removed line
 * sits across from the n-th added one, and whichever side runs out leaves a blank
 * cell; context and folds span both sides.
 */
export function splitRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      out.push({ op: 'pair', left: dels[i] ?? null, right: adds[i] ?? null })
    }
    dels = []
    adds = []
  }
  for (const row of rows) {
    if (row.op === 'del') dels.push(row)
    else if (row.op === 'add') adds.push(row)
    else {
      flush()
      out.push(row.op === 'fold' ? row : { op: 'pair', left: row, right: row })
    }
  }
  flush()
  return out
}

export function diffStat(lines: readonly DiffLine[]): { readonly added: number; readonly removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.op === 'add') added++
    else if (line.op === 'del') removed++
  }
  return { added, removed }
}
