import type { DiffFile, DiffFileStatus, DiffHunk, DiffHunkLine } from '../shared/types'

/**
 * Pure half of the worktree review: git's own unified diff text → the file/hunk
 * structure the renderer draws. No IO here — diff.ts runs git and reads untracked
 * files. Failure-tolerant the way the session parsers are: a header the parser
 * doesn't recognise is skipped, never thrown on. The diff is a reading aid for the
 * person about to ship, and a partial one beats none.
 */

export type DiffCaps = {
  /** Lines kept per file; the rest of that file's hunks are dropped and it is flagged */
  readonly maxLinesPerFile: number
  /** Lines kept across the whole diff; files past the budget ship without hunks */
  readonly maxLinesTotal: number
  /** Files kept in the listing; the count of the rest rides on the result */
  readonly maxFiles: number
}

/**
 * Generous for a PR-sized change, tight for a vendored tree: a 200-file diff of
 * 1,500-line files is still a few MB over the bridge, never the whole repo.
 */
export const DEFAULT_CAPS: DiffCaps = { maxLinesPerFile: 1_500, maxLinesTotal: 20_000, maxFiles: 200 }

type MutableFile = {
  path: string
  oldPath: string | null
  status: DiffFileStatus
  binary: boolean
  hunks: DiffHunk[]
  truncated: boolean
  lines: number
}

type MutableHunk = {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffHunkLine[]
}

/** `git diff` quotes paths with unusual bytes C-style; read them back. */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const bytes: number[] = []
  const s = raw.slice(1, -1)
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'))
      continue
    }
    const n = s[i + 1]
    if (n === undefined) break
    if (/[0-7]/.test(n)) {
      const oct = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? n
      bytes.push(parseInt(oct, 8))
      i += oct.length
      continue
    }
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, '\\': 92, '"': 34, a: 7, b: 8, f: 12, v: 11 }
    bytes.push(simple[n] ?? n.charCodeAt(0))
    i++
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Strip git's `a/` / `b/` prefix; `/dev/null` means "no such side". */
function sidePath(raw: string): string | null {
  const p = unquotePath(raw.trim())
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

/**
 * `diff --git a/P b/Q` — the two paths are space-separated with no quoting unless
 * unusual bytes are involved, so a path containing a space is ambiguous. Both
 * sides are normally the same path: take the split where they agree, else the
 * first split that gives an a/ and a b/ side.
 */
export function parseGitHeaderPaths(rest: string): { readonly a: string; readonly b: string } | null {
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*"|\S+)$/)
    if (!m) return null
    return { a: sidePath(m[1]) ?? '', b: sidePath(m[2]) ?? '' }
  }
  let first: { a: string; b: string } | null = null
  for (let i = rest.indexOf(' '); i !== -1; i = rest.indexOf(' ', i + 1)) {
    const a = rest.slice(0, i)
    const b = rest.slice(i + 1)
    if (!a.startsWith('a/') || !b.startsWith('b/')) continue
    const cand = { a: a.slice(2), b: b.slice(2) }
    if (cand.a === cand.b) return cand
    first ??= cand
  }
  return first
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * Unified diff text → files with hunks and per-line numbers. `caps` bound what
 * comes back; nothing here reads the disk.
 */
export function parseUnifiedDiff(
  text: string,
  caps: DiffCaps = DEFAULT_CAPS
): { readonly files: DiffFile[]; readonly droppedFiles: number } {
  const files: MutableFile[] = []
  let file: MutableFile | null = null
  let hunk: MutableHunk | null = null
  let oldNo = 0
  let newNo = 0
  let total = 0
  let dropped = 0

  const closeHunk = (): void => {
    if (hunk && file) file.hunks.push({ ...hunk, lines: hunk.lines })
    hunk = null
  }
  const closeFile = (): void => {
    closeHunk()
    if (!file) return
    if (files.length < caps.maxFiles) files.push(file)
    else dropped++
    file = null
  }

  // a trailing newline yields one empty line; never a phantom context row
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      const paths = parseGitHeaderPaths(line.slice('diff --git '.length))
      file = {
        path: paths?.b ?? paths?.a ?? '',
        oldPath: null,
        status: 'modified',
        binary: false,
        hunks: [],
        truncated: false,
        lines: 0
      }
      continue
    }
    if (!file) continue
    if (hunk) {
      const c = line[0]
      if (c === ' ' || c === '+' || c === '-') {
        if (total >= caps.maxLinesTotal || file.lines >= caps.maxLinesPerFile) {
          file.truncated = true
          continue
        }
        const op = c === ' ' ? 'same' : c === '+' ? 'add' : 'del'
        hunk.lines.push({
          op,
          text: line.slice(1),
          oldNo: op === 'add' ? null : oldNo,
          newNo: op === 'del' ? null : newNo
        })
        if (op !== 'add') oldNo++
        if (op !== 'del') newNo++
        file.lines++
        total++
        continue
      }
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      closeHunk()
    }
    const h = line.match(HUNK_RE)
    if (h) {
      if (file.truncated) continue // past the cap: later hunks of this file are gone too
      oldNo = Number(h[1])
      newNo = Number(h[3])
      hunk = {
        header: h[5] ?? '',
        oldStart: oldNo,
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: newNo,
        newCount: h[4] === undefined ? 1 : Number(h[4]),
        lines: []
      }
      continue
    }
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = unquotePath(line.slice('rename from '.length))
    } else if (line.startsWith('rename to ')) {
      file.path = unquotePath(line.slice('rename to '.length))
    } else if (line.startsWith('Binary files ')) file.binary = true
    else if (line.startsWith('--- ')) {
      const p = sidePath(line.slice(4))
      if (p !== null && file.status !== 'renamed') file.oldPath = p
    } else if (line.startsWith('+++ ')) {
      const p = sidePath(line.slice(4))
      if (p !== null) file.path = p
      else if (file.oldPath) file.path = file.oldPath // deleted: show the path that was
    }
  }
  closeFile()

  return {
    files: files.map((f) => {
      const { added, removed } = countLines(f.hunks)
      return {
        path: f.path,
        // a plain modification names the same path on both sides — no old path to show
        oldPath: f.status === 'renamed' ? f.oldPath : null,
        status: f.status,
        untracked: false,
        binary: f.binary,
        added,
        removed,
        hunks: f.hunks,
        truncated: f.truncated
      }
    }),
    droppedFiles: dropped
  }
}

function countLines(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.op === 'add') added++
      else if (l.op === 'del') removed++
    }
  return { added, removed }
}

export type NumstatEntry = {
  readonly added: number
  readonly removed: number
  readonly binary: boolean
}

/**
 * `git diff --numstat -z`: `added\tremoved\tpath\0`, or for a rename
 * `added\tremoved\t\0old\0new\0`; binary files count as `-\t-`. Keyed by the
 * path the change lands on, which is what the parsed files carry.
 */
export function parseNumstat(text: string): Map<string, NumstatEntry> {
  const out = new Map<string, NumstatEntry>()
  const tok = text.split('\0')
  for (let i = 0; i < tok.length; i++) {
    const m = tok[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/)
    if (!m) continue
    let path = m[3]
    if (path === '') {
      path = tok[i + 2] ?? ''
      i += 2
    }
    out.set(path, {
      added: m[1] === '-' ? 0 : Number(m[1]),
      removed: m[2] === '-' ? 0 : Number(m[2]),
      binary: m[1] === '-'
    })
  }
  return out
}

/** Numstat totals win over hunk counts: they are right even past the caps. */
export function withNumstat(files: readonly DiffFile[], stat: Map<string, NumstatEntry>): DiffFile[] {
  return files.map((f) => {
    const s = stat.get(f.path)
    return s ? { ...f, added: s.added, removed: s.removed, binary: f.binary || s.binary } : f
  })
}

/** `git rev-list --left-right --count base...HEAD` → "behind\tahead". */
export function parseAheadBehind(text: string): { readonly ahead: number; readonly behind: number } {
  const m = text.trim().match(/^(\d+)\s+(\d+)$/)
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : { ahead: 0, behind: 0 }
}

/**
 * The branch a worktree's work is measured against. The remote's HEAD (what
 * `origin/HEAD` points at) is the truth when there is one; otherwise the usual
 * names, remote before local. `existing` is what git reports as present.
 */
export function pickBase(originHead: string | null, existing: readonly string[]): string | null {
  if (originHead) return originHead
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    if (existing.includes(cand)) return cand
  }
  return null
}

/** `git status --porcelain -z` → the untracked paths and whether anything is dirty at all. */
export function parseStatus(text: string): { readonly dirty: boolean; readonly untracked: string[] } {
  const untracked: string[] = []
  let dirty = false
  const tok = text.split('\0')
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]
    if (t.length < 4) continue
    dirty = true
    const xy = t.slice(0, 2)
    const path = t.slice(3)
    if (xy === '??') untracked.push(path)
    // a rename/copy entry carries its original path as the next token
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++
  }
  return { dirty, untracked }
}

const BINARY_PROBE = 8_000

/** Git's own heuristic: a NUL in the first 8000 bytes makes a file binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_PROBE)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/**
 * An untracked file, drawn as the addition it is: git diff never shows it (it
 * is not in the index yet), but a reviewer must see that the agent created it.
 */
export function untrackedFile(
  path: string,
  content: Uint8Array,
  opts: { readonly truncated?: boolean; readonly maxLines?: number } = {}
): DiffFile {
  const base = { path, oldPath: null, status: 'added' as const, untracked: true }
  if (looksBinary(content)) {
    return { ...base, binary: true, added: 0, removed: 0, hunks: [], truncated: false }
  }
  const text = Buffer.from(content).toString('utf8')
  const all = text.split('\n')
  if (all[all.length - 1] === '') all.pop()
  const max = opts.maxLines ?? DEFAULT_CAPS.maxLinesPerFile
  const shown = all.slice(0, max)
  const lines: DiffHunkLine[] = shown.map((t, i) => ({ op: 'add', text: t, oldNo: null, newNo: i + 1 }))
  return {
    ...base,
    binary: false,
    added: all.length,
    removed: 0,
    hunks:
      lines.length === 0
        ? []
        : [{ header: '', oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, lines }],
    truncated: opts.truncated === true || shown.length < all.length
  }
}
