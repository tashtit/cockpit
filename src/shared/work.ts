import type { CheckKind, EditLine, FileEdit, SessionMessage, TodoStatus, WorkArtifact } from './types'

/**
 * The Work panel's model: what the agent's own tool calls say about its work, folded
 * over the whole transcript — the plan it last proposed, where its to-do list stands
 * now, and every edit it made, file by file. Pure: ChatView builds it from the log
 * on every render the panel is open, which is cheap (a pass over rows that already
 * carry parsed artifacts; no diffing happens here — main did that).
 *
 * A row's `key` is its place among the rows it was given. ChatView hands over only the
 * rows that carry an artifact and translates between these and the transcript's own
 * row keys at the panel's edge, so a row can still open the panel at itself.
 */

export type WorkTab = 'plan' | 'todos' | 'edits' | 'checks' | 'files'

/** The order the Checks tab lists them in: quickest first, the order an agent runs them */
export const CHECK_ORDER: readonly CheckKind[] = ['types', 'lint', 'tests', 'e2e', 'build']

/** What a check is called wherever a person or the next agent reads it */
export const CHECK_LABEL: Readonly<Record<CheckKind, string>> = {
  types: 'Typecheck',
  lint: 'Lint',
  tests: 'Tests',
  e2e: 'End-to-end tests',
  build: 'Build'
}

/** One run of a check: a command that ran it, and how it ended if the log says. */
export type CheckRun = {
  readonly key: number
  readonly ts?: number
  readonly command: string
  /** Absent: no verdict — still running, refused, or sent to the background */
  readonly status?: 'passed' | 'failed'
  readonly exitCode?: number
  readonly output?: readonly string[]
}

/** A file an agent handed the person — the newest hand-off of it. */
export type SharedFileEntry = {
  /** Absolute when the session's directory is known, so `a.png` and `/repo/a.png` are one file */
  readonly path: string
  readonly key: number
  readonly ts?: number
  readonly toolName: string
  readonly caption?: string
}

/** A page an agent opened or published for the person — the newest time it did. */
export type SharedLinkEntry = {
  readonly url: string
  readonly title?: string
  readonly key: number
  readonly ts?: number
  readonly toolName: string
}

export type CheckWork = {
  readonly kind: CheckKind
  /** Oldest first */
  readonly runs: readonly CheckRun[]
  /** The newest run with a verdict — the check's state; null while none has one */
  readonly last: CheckRun | null
  /** Files edited after `last`, which it no longer speaks for */
  readonly editedSince: number
}

export type PlanEntry = { readonly key: number; readonly text: string; readonly ts?: number }

export type TodoEntry = { readonly id: string; readonly text: string; readonly status: TodoStatus }

export type EditEntry = {
  readonly key: number
  readonly ts?: number
  readonly toolName: string
  readonly edit: FileEdit
  /** The call's result was an error — the change never landed */
  readonly failed: boolean
  readonly added: number
  readonly removed: number
}

export type FileWork = {
  /** Absolute when the session's directory is known, so `a.ts` and `/repo/a.ts` are one file */
  readonly path: string
  readonly edits: readonly EditEntry[]
  readonly added: number
  readonly removed: number
}

export type WorkModel = {
  /** Oldest first; the last is the plan that counts */
  readonly plans: readonly PlanEntry[]
  readonly todos: readonly TodoEntry[]
  /** The row that last changed the list, null when nothing has */
  readonly todosKey: number | null
  /** In the order the agent first touched them */
  readonly files: readonly FileWork[]
  readonly editCount: number
  /** Every check the agent ran, in CHECK_ORDER */
  readonly checks: readonly CheckWork[]
  /** What it handed the person, newest first, each file and page once */
  readonly shared: { readonly files: readonly SharedFileEntry[]; readonly links: readonly SharedLinkEntry[] }
}

export function lineStat(lines: readonly EditLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.op === 'add') added++
    else if (l.op === 'del') removed++
  }
  return { added, removed }
}

export function editStat(edit: FileEdit): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of edit.hunks) {
    const s = lineStat(h)
    added += s.added
    removed += s.removed
  }
  return { added, removed }
}

/** Every file an edits artifact touched, summed — the row's `+3 −1`. */
export function artifactStat(a: Extract<WorkArtifact, { kind: 'edits' }>): { added: number; removed: number } {
  return a.files.reduce(
    (sum, f) => {
      const s = editStat(f)
      return { added: sum.added + s.added, removed: sum.removed + s.removed }
    },
    { added: 0, removed: 0 }
  )
}

/** A plan's headline: its first heading, else its first line, markdown marks stripped. */
export function planTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /^#{1,6}\s/.test(l)) ?? lines[0] ?? ''
  return line.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').trim() || 'Plan'
}

/** `/repo` + `src/a.ts` → `/repo/src/a.ts`; an absolute path stays as it is. */
export function absolutePath(path: string, cwd?: string): string {
  if (!cwd || path.startsWith('/')) return path
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
}

/** Which tab a row's artifact belongs on. */
export function tabFor(a: WorkArtifact): WorkTab {
  if (a.kind === 'plan') return 'plan'
  if (a.kind === 'edits') return 'edits'
  if (a.kind === 'check') return 'checks'
  if (a.kind === 'shared') return 'files'
  return 'todos'
}

export function buildWork(log: readonly SessionMessage[], cwd?: string): WorkModel {
  const plans: PlanEntry[] = []
  let todos: TodoEntry[] = []
  let todosKey: number | null = null
  const files = new Map<string, EditEntry[]>()
  let editCount = 0
  const runs = new Map<CheckKind, CheckRun[]>()
  // each file and page at its newest hand-off, with its place in that call's own list
  const sharedFiles = new Map<string, { readonly entry: SharedFileEntry; readonly i: number }>()
  const sharedLinks = new Map<string, { readonly entry: SharedLinkEntry; readonly i: number }>()
  // Claude numbers tasks 1, 2, 3… — a create whose result was never read (the live
  // stream carries no results) takes the next number after the highest seen
  let nextTask = 1
  const taskNo = (id: string): void => {
    const n = Number(id)
    if (Number.isInteger(n) && n >= nextTask) nextTask = n + 1
  }

  log.forEach((m, key) => {
    const a = m.kind === 'tool_call' ? m.artifact : undefined
    if (!a) return
    switch (a.kind) {
      case 'plan':
        plans.push({ key, text: a.text, ...(m.ts ? { ts: m.ts } : {}) })
        break
      case 'todos':
        todos = a.items.map((t, i) => ({ id: `step-${i + 1}`, text: t.text, status: t.status }))
        todosKey = key
        break
      case 'task-add': {
        if (m.failed) break
        const ids = a.ids?.length === a.items.length ? a.ids : a.items.map(() => String(nextTask++))
        a.items.forEach((text, i) => {
          const id = ids[i]!
          taskNo(id)
          todos = [...todos.filter((t) => t.id !== id), { id, text, status: 'pending' }]
        })
        todosKey = key
        break
      }
      case 'task-update': {
        if (m.failed) break
        const at = todos.findIndex((t) => t.id === a.id)
        const { status, text } = a
        if (status === 'deleted') {
          if (at >= 0) todos = todos.filter((t) => t.id !== a.id)
        } else if (at >= 0) {
          todos = todos.map((t, i) =>
            i === at ? { ...t, ...(status ? { status } : {}), ...(text ? { text } : {}) } : t
          )
        } else if (text) {
          // created before the part of the log that was read — known by its update alone
          taskNo(a.id)
          todos = [...todos, { id: a.id, text, status: status ?? 'pending' }]
        } else break
        todosKey = key
        break
      }
      case 'edits':
        for (const edit of a.files) {
          const path = absolutePath(edit.path, cwd)
          const s = editStat(edit)
          const entry: EditEntry = {
            key,
            ...(m.ts ? { ts: m.ts } : {}),
            toolName: m.toolName ?? 'edit',
            edit,
            failed: m.failed === true,
            ...s
          }
          files.set(path, [...(files.get(path) ?? []), entry])
          editCount++
        }
        break
      case 'shared': {
        // a write that failed handed nothing over
        if (m.failed) break
        const at = { key, ...(m.ts ? { ts: m.ts } : {}), toolName: m.toolName ?? 'tool' }
        a.files.forEach((file, i) => {
          const path = absolutePath(file, cwd)
          sharedFiles.set(path, { entry: { path, ...at, ...(a.caption ? { caption: a.caption } : {}) }, i })
        })
        a.links.forEach((link, i) => sharedLinks.set(link.url, { entry: { ...link, ...at }, i }))
        break
      }
      case 'check': {
        const { command, status, exitCode, output } = a
        const run: CheckRun = {
          key,
          ...(m.ts ? { ts: m.ts } : {}),
          command,
          ...(status ? { status } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(output ? { output } : {})
        }
        for (const kind of a.checks) runs.set(kind, [...(runs.get(kind) ?? []), run])
        break
      }
    }
  })

  // what each check's newest verdict no longer covers: the files a landed edit touched after it
  const landedEdits = [...files].flatMap(([path, edits]) => edits.filter((e) => !e.failed).map((e) => ({ path, key: e.key })))
  const checks = CHECK_ORDER.flatMap((kind): CheckWork[] => {
    const list = runs.get(kind)
    if (!list) return []
    const last = [...list].reverse().find((r) => r.status !== undefined) ?? null
    const since = last === null ? [] : landedEdits.filter((e) => e.key > last.key)
    return [{ kind, runs: list, last, editedSince: new Set(since.map((e) => e.path)).size }]
  })

  return {
    plans,
    todos,
    todosKey,
    files: [...files].map(([path, edits]) => {
      const landed = edits.filter((e) => !e.failed)
      return {
        path,
        edits,
        added: landed.reduce((n, e) => n + e.added, 0),
        removed: landed.reduce((n, e) => n + e.removed, 0)
      }
    }),
    editCount,
    checks,
    shared: { files: newestFirst(sharedFiles), links: newestFirst(sharedLinks) }
  }
}

/** "3 of 7 done" — the list's state in the words the tab and the row both use. */
export function todoSummary(todos: readonly TodoEntry[]): string {
  const done = todos.filter((t) => t.status === 'completed').length
  return todos.length === 0 ? 'no steps' : `${done} of ${todos.length} done`
}

/** What happened to a file across its edits: added, deleted, rewritten whole, or edited. */
export function fileChange(file: FileWork): FileEdit['change'] {
  const landed = file.edits.filter((e) => !e.failed)
  const last = landed[landed.length - 1]?.edit.change
  if (last === 'delete') return 'delete'
  const first = landed[0]?.edit.change
  return first === 'add' || first === 'write' ? first : 'edit'
}

/** The newest hand-off first; one call's files in the order it listed them. */
function newestFirst<T extends { readonly key: number }>(
  handed: ReadonlyMap<string, { readonly entry: T; readonly i: number }>
): T[] {
  return [...handed.values()].sort((a, b) => b.entry.key - a.entry.key || a.i - b.i).map((h) => h.entry)
}

/** A check that wants a look: its newest verdict failed, or files changed after it. */
export function needsLook(c: CheckWork): boolean {
  return c.last?.status === 'failed' || c.editedSince > 0
}

/** "3 checks · 1 failing · 1 out of date" — the tab's readout, in the words the rows use. */
export function checkSummary(checks: readonly CheckWork[]): string {
  const failing = checks.filter((c) => c.last?.status === 'failed').length
  const stale = checks.filter((c) => c.last?.status === 'passed' && c.editedSince > 0).length
  const parts = [checks.length === 1 ? '1 check' : `${checks.length} checks`]
  if (failing > 0) parts.push(`${failing} failing`)
  if (stale > 0) parts.push(`${stale} out of date`)
  if (failing === 0 && stale === 0 && checks.every((c) => c.last?.status === 'passed')) parts.push('all passing')
  return parts.join(' · ')
}

/** "3 files · 1 page" — the Files tab's readout. */
export function sharedSummary(shared: WorkModel['shared']): string {
  const parts: string[] = []
  if (shared.files.length > 0) parts.push(shared.files.length === 1 ? '1 file' : `${shared.files.length} files`)
  if (shared.links.length > 0) parts.push(shared.links.length === 1 ? '1 page' : `${shared.links.length} pages`)
  return parts.join(' · ') || 'nothing shared'
}
