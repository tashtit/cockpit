import { diffLines } from '../../shared/line-diff'
import type { EditLine, FileEdit, TodoItem, TodoStatus, WorkArtifact } from '../../shared/types'
import { checkArtifact } from './checks'
import { capText, shellScript, truncate } from './util'

/**
 * What a tool call hands the person to look at — a plan, a to-do list, an edit, a
 * check it ran (`checks.ts`) —
 * read off the call's own input, for every agent and both paths a call arrives by
 * (the log on disk and the live stream). The Work panel renders these; without them
 * a plan was 400 characters of JSON behind a collapsed row.
 *
 * Tool inputs are provider-internal and drift between releases, so every field is
 * read defensively and a shape that doesn't match is simply no artifact — never a
 * broken transcript. Everything is bounded: an artifact rides every transcript read
 * over IPC, so a 3,000-line Write or a whole-file ACP diff must not ride it whole.
 * IO-free — the unit tests target this directly.
 */

/** Files one call may report (a patch can touch many) */
const MAX_FILES = 24
/** Lines kept per file across its hunks; the rest is cut and the file marked */
const MAX_FILE_LINES = 400
/** One line of code — a minified bundle line must not become the payload */
const MAX_LINE_CHARS = 400
/** Lines of unchanged context kept around each change of a before/after pair */
const CONTEXT = 3
/** Beyond this many lines a side is not diffed at all: named, marked, no lines */
const MAX_DIFF_SIDE = 6_000
const MAX_TODOS = 60
const MAX_TODO_CHARS = 300
const MAX_PLAN_CHARS = 20_000

type Rec = Record<string, unknown>

function record(v: unknown): Rec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** Text → lines as written: a trailing newline ends the last line, it doesn't add one. */
function lines(text: string): string[] {
  if (text === '') return []
  const out = text.replace(/\r\n/g, '\n').split('\n')
  if (out[out.length - 1] === '') out.pop()
  return out
}

/** The words each CLI uses for a step's state, folded onto four. */
export function todoStatus(v: unknown): TodoStatus {
  const s = typeof v === 'string' ? v.toLowerCase().replace(/[\s-]/g, '_') : ''
  if (s === 'completed' || s === 'complete' || s === 'done') return 'completed'
  if (s === 'in_progress' || s === 'active' || s === 'running') return 'in_progress'
  if (s === 'blocked') return 'blocked'
  return 'pending'
}

function todos(list: unknown, read: (item: Rec) => { text: unknown; status: unknown }): WorkArtifact | undefined {
  if (!Array.isArray(list)) return undefined
  const items: TodoItem[] = []
  for (const raw of list) {
    const r = record(raw)
    if (!r) continue
    const { text, status } = read(r)
    const t = str(text)
    if (t) items.push({ text: truncate(t, MAX_TODO_CHARS), status: todoStatus(status) })
    if (items.length === MAX_TODOS) break
  }
  // an empty list is still a statement — the agent cleared its plan
  return { kind: 'todos', items }
}

/** Files one call may hand over */
const MAX_SHARED_FILES = 24
const MAX_CAPTION_CHARS = 300

/** A page a person can be sent to: http(s) only — never `file:`, `javascript:` or an app scheme */
function webUrl(v: unknown): string | null {
  const s = str(v)?.trim()
  return s && /^https?:\/\/[^\s]+$/i.test(s) ? s : null
}

/** What a call handed the person to look at: files it sent, pages it opened for them. */
export function sharedArtifact(parts: {
  readonly files?: readonly unknown[]
  readonly links?: readonly { readonly url: unknown; readonly title?: unknown }[]
  readonly caption?: unknown
}): WorkArtifact | undefined {
  const files = (parts.files ?? []).flatMap((f) => (str(f) ? [str(f)!.trim()] : [])).slice(0, MAX_SHARED_FILES)
  const links = (parts.links ?? []).flatMap((l) => {
    const url = webUrl(l.url)
    const title = str(l.title)
    return url ? [{ url, ...(title ? { title: truncate(title, MAX_CAPTION_CHARS) } : {}) }] : []
  })
  const caption = str(parts.caption)
  if (files.length === 0 && links.length === 0) return undefined
  return { kind: 'shared', files, links, ...(caption ? { caption: truncate(caption, MAX_CAPTION_CHARS) } : {}) }
}

/** The page a publish's result names: `Published <file> at https://…` */
export function publishedUrl(result: string): string | null {
  const m = /\bat (https?:\/\/\S+)/.exec(result)
  return m ? webUrl(m[1]!.replace(/[.,)]+$/, '')) : null
}

export function planArtifact(text: unknown): WorkArtifact | undefined {
  const t = str(text)
  return t ? { kind: 'plan', text: capText(t.trim(), MAX_PLAN_CHARS) } : undefined
}

/**
 * Keep a file's lines inside the bound: every line cut to a readable width, and
 * lines past the file's budget dropped from the end, the file marked.
 */
function bounded(file: Omit<FileEdit, 'hunks' | 'truncated'>, hunks: readonly EditLine[][], cut = false): FileEdit {
  let budget = MAX_FILE_LINES
  let truncated = cut
  const kept: EditLine[][] = []
  for (const h of hunks) {
    if (h.length === 0) continue
    if (budget <= 0) {
      truncated = true
      break
    }
    const part = h.length > budget ? h.slice(0, budget) : h
    if (part.length < h.length) truncated = true
    budget -= part.length
    kept.push(
      part.map((l) => (l.text.length > MAX_LINE_CHARS ? { op: l.op, text: truncate(l.text, MAX_LINE_CHARS) } : l))
    )
  }
  return { ...file, hunks: kept, ...(truncated ? { truncated: true } : {}) }
}

/**
 * A before/after pair as hunks: the line diff, with only `CONTEXT` unchanged lines
 * kept around each change — an ACP diff carries whole files, and a hunk that is the
 * whole file would push the change itself off the panel.
 */
export function pairHunks(before: string, after: string): { hunks: EditLine[][]; cut: boolean } {
  const a = lines(before)
  const b = lines(after)
  if (a.length > MAX_DIFF_SIDE || b.length > MAX_DIFF_SIDE) return { hunks: [], cut: true }
  const diff = diffLines(a, b)
  const keep = diff.map(() => false)
  diff.forEach((l, i) => {
    if (l.op === 'same') return
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(diff.length - 1, i + CONTEXT); k++) keep[k] = true
  })
  const hunks: EditLine[][] = []
  let cur: EditLine[] | null = null
  diff.forEach((l, i) => {
    if (!keep[i]) {
      cur = null
      return
    }
    if (!cur) {
      cur = []
      hunks.push(cur)
    }
    cur.push(l)
  })
  return { hunks, cut: false }
}

function replaceEdit(path: unknown, pairs: ReadonlyArray<readonly [unknown, unknown]>): FileEdit | null {
  const p = str(path)
  if (!p) return null
  const hunks: EditLine[][] = []
  let cut = false
  for (const [before, after] of pairs) {
    if (typeof before !== 'string' || typeof after !== 'string') continue
    const d = pairHunks(before, after)
    hunks.push(...d.hunks)
    cut ||= d.cut
  }
  return bounded({ path: p, change: 'edit' }, hunks, cut)
}

/** A file written whole: every line is new, as far as the call can say. */
function wholeFile(path: unknown, content: unknown, change: 'add' | 'write'): FileEdit | null {
  const p = str(path)
  if (!p || typeof content !== 'string') return null
  return bounded({ path: p, change }, [lines(content).map((text) => ({ op: 'add', text }))])
}

function edits(files: ReadonlyArray<FileEdit | null>): WorkArtifact | undefined {
  const kept = files.filter((f): f is FileEdit => f !== null).slice(0, MAX_FILES)
  return kept.length > 0 ? { kind: 'edits', files: kept } : undefined
}

/**
 * The patch format Codex and Copilot both write (`*** Begin Patch` … `*** End Patch`):
 * per file an Add, Update (optionally `*** Move to:`) or Delete header, `@@` lines
 * between hunks, and ` `/`-`/`+` lines.
 */
export function parsePatch(text: string): FileEdit[] {
  type Draft = { path: string; change: FileEdit['change']; movedTo?: string; hunks: EditLine[][] }
  const files: Draft[] = []
  let cur: Draft | null = null
  let hunk: EditLine[] | null = null
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = raw.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (head) {
      const change = head[1] === 'Add' ? 'add' : head[1] === 'Delete' ? 'delete' : 'edit'
      cur = { path: head[2]!.trim(), change, hunks: [] }
      files.push(cur)
      hunk = null
      continue
    }
    if (!cur) continue
    const move = raw.match(/^\*\*\* Move to: (.+)$/)
    if (move) {
      cur.movedTo = move[1]!.trim()
      continue
    }
    if (raw.startsWith('***')) continue
    if (raw.startsWith('@@')) {
      hunk = null
      continue
    }
    if (cur.change === 'delete') continue
    const op = raw[0] === '+' ? 'add' : raw[0] === '-' ? 'del' : raw[0] === ' ' ? 'same' : null
    // a bare empty line inside an update is a blank context line some writers leave
    // unprefixed; anywhere else it is the patch's own spacing
    if (op === null && !(raw === '' && cur.change === 'edit')) continue
    if (!hunk) {
      hunk = []
      cur.hunks.push(hunk)
    }
    hunk.push({ op: op ?? 'same', text: op === null ? '' : raw.slice(1) })
  }
  return files.map((f) => {
    // the unprefixed blank a patch ends on is spacing, not context
    for (const h of f.hunks) while (h.length > 0 && h[h.length - 1]!.op === 'same' && h[h.length - 1]!.text === '') h.pop()
    const { hunks, ...file } = f
    return bounded(file, hunks)
  })
}

/** A unified diff's hunks (`@@ -a,b +c,d @@`), headers and "no newline" notes skipped. */
export function parseUnifiedDiff(text: string): EditLine[][] {
  const hunks: EditLine[][] = []
  let hunk: EditLine[] | null = null
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('@@')) {
      hunk = []
      hunks.push(hunk)
      continue
    }
    if (!hunk || raw.startsWith('\\')) continue
    const op = raw[0] === '+' ? 'add' : raw[0] === '-' ? 'del' : raw[0] === ' ' ? 'same' : null
    if (op) hunk.push({ op, text: raw.slice(1) })
  }
  return hunks
}

/** The patch inside a shell script — Codex once ran apply_patch as a command. */
function patchIn(text: string): string | null {
  const start = text.indexOf('*** Begin Patch')
  if (start < 0) return null
  const end = text.indexOf('*** End Patch', start)
  return end < 0 ? text.slice(start) : text.slice(start, end + '*** End Patch'.length)
}

function patchArtifact(text: unknown): WorkArtifact | undefined {
  const patch = typeof text === 'string' ? patchIn(text) : null
  return patch ? edits(parsePatch(patch)) : undefined
}

/** The tool names each CLI plans, lists and edits with, and what each one's input says. */
export function toolArtifact(name: string, input: unknown): WorkArtifact | undefined {
  const i = record(input)
  switch (name) {
    // Claude
    case 'ExitPlanMode':
      return planArtifact(i?.plan)
    case 'TodoWrite':
      return todos(i?.todos, (t) => ({ text: t.content ?? t.activeForm, status: t.status }))
    case 'TaskCreate': {
      // one task per call, or a batch under `tasks`
      const tasks = i?.tasks
      const batch = Array.isArray(tasks) ? tasks.map((t) => record(t)?.subject) : [i?.subject]
      const items = batch.flatMap((s) => (str(s) ? [truncate(str(s)!, MAX_TODO_CHARS)] : []))
      return items.length > 0 ? { kind: 'task-add', items: items.slice(0, MAX_TODOS) } : undefined
    }
    case 'TaskUpdate': {
      const id = i?.taskId
      if (typeof id !== 'string' && typeof id !== 'number') return undefined
      const status = i?.status
      const s = typeof status === 'string' ? status.toLowerCase() : null
      const text = str(i?.subject)
      return {
        kind: 'task-update',
        id: String(id),
        ...(s ? { status: s === 'deleted' ? 'deleted' : todoStatus(s) } : {}),
        ...(text ? { text: truncate(text, MAX_TODO_CHARS) } : {})
      }
    }
    case 'Edit':
      return edits([replaceEdit(i?.file_path, [[i?.old_string, i?.new_string]])])
    case 'MultiEdit': {
      const list = i?.edits
      const pairs = Array.isArray(list)
        ? list.map((e): readonly [unknown, unknown] => [record(e)?.old_string, record(e)?.new_string])
        : []
      return edits([replaceEdit(i?.file_path, pairs)])
    }
    case 'Write':
      return edits([wholeFile(i?.file_path, i?.content, 'write')])
    // Codex
    case 'update_plan':
      return todos(i?.plan, (t) => ({ text: t.step, status: t.status }))
    case 'shell':
    case 'exec_command':
    case 'local_shell': {
      const cmd = i?.command ?? i?.cmd
      return patchArtifact(Array.isArray(cmd) ? cmd.map(String).join('\n') : cmd) ?? checkArtifact(shellScript(cmd))
    }
    // what an agent hands the person: files it sends, a page it publishes (its address
    // is in the result), a preview it opens
    case 'SendUserFile':
      return sharedArtifact({ files: Array.isArray(i?.files) ? i.files : [], caption: i?.caption })
    case 'Artifact':
      return i?.action === undefined || i?.action === 'publish'
        ? sharedArtifact({ files: [i?.file_path], caption: i?.description })
        : undefined
    case 'mcp__Claude_Browser__preview_start':
      return sharedArtifact({ links: [{ url: i?.url }] })
    case 'open_canvas': {
      const canvas = record(i?.input)
      return i?.canvasId === 'browser' ? sharedArtifact({ links: [{ url: canvas?.url, title: canvas?.title }] }) : undefined
    }
    // every agent's shell: a command that runs tests, a typecheck, a linter or a build
    case 'Bash':
    case 'bash':
      return checkArtifact(i?.command)
    // Codex and Copilot: the input is the patch, bare or under `input`/`patch`
    case 'apply_patch':
      return patchArtifact(typeof input === 'string' ? input : (i?.input ?? i?.patch))
    // Copilot
    case 'exit_plan_mode':
      return planArtifact(i?.summary ?? i?.plan)
    case 'edit':
    case 'str_replace':
      return edits([replaceEdit(i?.path, [[i?.old_str, i?.new_str]])])
    case 'create':
      return edits([wholeFile(i?.path, i?.file_text, 'add')])
    case 'str_replace_editor':
      if (i?.command === 'create') return edits([wholeFile(i?.path, i?.file_text, 'add')])
      if (i?.command === 'str_replace') return edits([replaceEdit(i?.path, [[i?.old_str, i?.new_str]])])
      return undefined
    default:
      return undefined
  }
}

/**
 * Codex's typed file change — `FileChange.changes` in a rollout, keyed by path with
 * the content (`add`) or a unified diff (`update`), and `file_change.changes` in the
 * `exec --json` stream, a list of paths and kinds with no lines at all.
 */
export function fileChangeArtifact(changes: unknown): WorkArtifact | undefined {
  const files: Array<FileEdit | null> = []
  if (Array.isArray(changes)) {
    for (const c of changes) {
      const r = record(c)
      const path = str(r?.path)
      if (path) files.push({ path, change: changeKind(r?.kind), hunks: [] })
    }
  } else {
    for (const [path, c] of Object.entries(record(changes) ?? {})) {
      const r = record(c)
      const kind = changeKind(r?.type ?? r?.kind)
      if (kind === 'add') files.push(wholeFile(path, r?.content, 'add') ?? { path, change: 'add', hunks: [] })
      else if (kind === 'delete') files.push({ path, change: 'delete', hunks: [] })
      else {
        const unified = r?.unified_diff
        const diff = typeof unified === 'string' ? parseUnifiedDiff(unified) : []
        const moved = str(r?.move_path)
        files.push(bounded({ path, change: 'edit', ...(moved ? { movedTo: moved } : {}) }, diff))
      }
    }
  }
  return edits(files)
}

function changeKind(v: unknown): FileEdit['change'] {
  return v === 'add' ? 'add' : v === 'delete' ? 'delete' : 'edit'
}

/** Codex's `todo_list` stream item: `{ items: [{ text, completed }] }`. */
export function todoListArtifact(items: unknown): WorkArtifact | undefined {
  return todos(items, (t) => ({ text: t.text, status: t.completed === true ? 'completed' : 'pending' }))
}

/** Copilot's to-do table (`todos` in the session's own `session.db`): `{ title, status }` rows. */
export function todoTableArtifact(rows: unknown): WorkArtifact | undefined {
  return todos(rows, (t) => ({ text: t.title, status: t.status }))
}

/** ACP's `plan` update: `{ entries: [{ content, status, priority }] }`, always the whole list. */
export function acpPlanArtifact(entries: unknown): WorkArtifact | undefined {
  return todos(entries, (t) => ({ text: t.content, status: t.status }))
}

/** ACP tool-call content blocks of type `diff`: `{ path, oldText, newText }`, whole files. */
export function acpDiffArtifact(content: unknown): WorkArtifact | undefined {
  if (!Array.isArray(content)) return undefined
  const files: Array<FileEdit | null> = []
  for (const c of content) {
    const r = record(c)
    if (r?.type !== 'diff') continue
    const path = str(r.path)
    if (!path || typeof r.newText !== 'string') continue
    if (typeof r.oldText !== 'string') {
      files.push(wholeFile(path, r.newText, 'add'))
      continue
    }
    const d = pairHunks(r.oldText, r.newText)
    files.push(bounded({ path, change: 'edit' }, d.hunks, d.cut))
  }
  return edits(files)
}
