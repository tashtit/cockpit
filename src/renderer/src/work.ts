import type { EditLine, FileEdit, SessionMessage, TodoStatus, WorkArtifact } from '../../shared/types'

/**
 * The Work panel's model: what the agent's own tool calls say about its work, folded
 * over the whole transcript — the plan it last proposed, where its to-do list stands
 * now, and every edit it made, file by file. Pure: ChatView builds it from the log
 * on every render the panel is open, which is cheap (a pass over rows that already
 * carry parsed artifacts; no diffing happens here — main did that).
 *
 * A row's `key` is its offset in the log, the same key the transcript renders it
 * under, so a row can open the panel at itself.
 */

export type WorkTab = 'plan' | 'todos' | 'edits'

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

/** Does any row carry something the panel shows? The header's Work key asks this. */
export function hasWork(log: readonly SessionMessage[]): boolean {
  return log.some((m) => m.kind === 'tool_call' && m.artifact !== undefined)
}

/** Which tab a row's artifact belongs on. */
export function tabFor(a: WorkArtifact): WorkTab {
  return a.kind === 'plan' ? 'plan' : a.kind === 'edits' ? 'edits' : 'todos'
}

export function buildWork(log: readonly SessionMessage[], cwd?: string): WorkModel {
  const plans: PlanEntry[] = []
  let todos: TodoEntry[] = []
  let todosKey: number | null = null
  const files = new Map<string, EditEntry[]>()
  let editCount = 0
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
    }
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
    editCount
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
