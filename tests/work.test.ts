import { describe, expect, it } from 'vitest'
import { absolutePath, buildWork, fileChange, hasWork, planTitle, todoSummary } from '../src/renderer/src/work'
import type { FileEdit, SessionMessage, WorkArtifact } from '../src/shared/types'

const call = (toolName: string, artifact: WorkArtifact, extra: Partial<SessionMessage> = {}): SessionMessage => ({
  role: 'assistant',
  kind: 'tool_call',
  toolName,
  text: '{}',
  artifact,
  ...extra
})
const say = (text: string): SessionMessage => ({ role: 'assistant', kind: 'text', text })
const edit = (path: string, from: string, to: string, change: FileEdit['change'] = 'edit'): WorkArtifact => ({
  kind: 'edits',
  files: [
    {
      path,
      change,
      hunks: [
        [
          { op: 'del', text: from },
          { op: 'add', text: to }
        ]
      ]
    }
  ]
})

describe('buildWork: plans', () => {
  it('keeps every plan, oldest first, each under its row', () => {
    const log = [say('thinking'), call('ExitPlanMode', { kind: 'plan', text: '# One' }), say('revised'), call('ExitPlanMode', { kind: 'plan', text: '# Two' }, { ts: 5 })]
    expect(buildWork(log).plans).toEqual([
      { key: 1, text: '# One' },
      { key: 3, text: '# Two', ts: 5 }
    ])
  })

  it('titles a plan by its first heading, else its first line', () => {
    expect(planTitle('Intro line\n\n## Add **rate** limiting\n- a')).toBe('Add rate limiting')
    expect(planTitle('**Approach:** one layer\n- b')).toBe('Approach: one layer')
    expect(planTitle('   ')).toBe('Plan')
  })
})

describe('buildWork: the to-do list', () => {
  it('a whole list replaces the one before it', () => {
    const log = [
      call('TodoWrite', { kind: 'todos', items: [{ text: 'a', status: 'pending' }] }),
      call('TodoWrite', {
        kind: 'todos',
        items: [
          { text: 'a', status: 'completed' },
          { text: 'b', status: 'in_progress' }
        ]
      })
    ]
    const w = buildWork(log)
    expect(w.todos.map((t) => [t.text, t.status])).toEqual([
      ['a', 'completed'],
      ['b', 'in_progress']
    ])
    expect(w.todosKey).toBe(1)
    expect(todoSummary(w.todos)).toBe('1 of 2 done')
  })

  it("folds Claude's tasks by the numbers their results gave them", () => {
    const log = [
      call('TaskCreate', { kind: 'task-add', items: ['Reproduce'], ids: ['4'] }),
      call('TaskCreate', { kind: 'task-add', items: ['Fix'], ids: ['5'] }),
      call('TaskUpdate', { kind: 'task-update', id: '4', status: 'completed' }),
      call('TaskUpdate', { kind: 'task-update', id: '5', status: 'in_progress', text: 'Fix the parser' })
    ]
    expect(buildWork(log).todos).toEqual([
      { id: '4', text: 'Reproduce', status: 'completed' },
      { id: '5', text: 'Fix the parser', status: 'in_progress' }
    ])
  })

  it('numbers a streamed create — no result read yet — after the highest number seen', () => {
    const log = [
      call('TaskCreate', { kind: 'task-add', items: ['First'], ids: ['2'] }),
      call('TaskCreate', { kind: 'task-add', items: ['Streamed'] }),
      call('TaskUpdate', { kind: 'task-update', id: '3', status: 'in_progress' })
    ]
    expect(buildWork(log).todos.map((t) => [t.id, t.status])).toEqual([
      ['2', 'pending'],
      ['3', 'in_progress']
    ])
  })

  it('a deleted task leaves the list; a failed call changes nothing', () => {
    const log = [
      call('TaskCreate', { kind: 'task-add', items: ['a', 'b'], ids: ['1', '2'] }),
      call('TaskUpdate', { kind: 'task-update', id: '1', status: 'deleted' }),
      call('TaskUpdate', { kind: 'task-update', id: '2', status: 'completed' }, { failed: true })
    ]
    expect(buildWork(log).todos).toEqual([{ id: '2', text: 'b', status: 'pending' }])
  })

  it('an update for a task created before the log starts is kept when it names the task', () => {
    const log = [
      call('TaskUpdate', { kind: 'task-update', id: '9', status: 'in_progress', text: 'Older task' }),
      call('TaskUpdate', { kind: 'task-update', id: '10', status: 'completed' })
    ]
    const w = buildWork(log)
    expect(w.todos).toEqual([{ id: '9', text: 'Older task', status: 'in_progress' }])
    expect(w.todosKey).toBe(0)
  })
})

describe('buildWork: edits', () => {
  it('groups edits by file in first-touched order, one path however it was written', () => {
    const log = [
      call('Edit', edit('/repo/src/a.ts', 'x', 'y'), { ts: 1 }),
      call('apply_patch', edit('src/b.ts', 'p', 'q')),
      call('apply_patch', edit('./src/a.ts', 'y', 'z'))
    ]
    const w = buildWork(log, '/repo')
    expect(w.files.map((f) => [f.path, f.edits.map((e) => e.key)])).toEqual([
      ['/repo/src/a.ts', [0, 2]],
      ['/repo/src/b.ts', [1]]
    ])
    expect(w.editCount).toBe(3)
    expect(w.files[0]).toMatchObject({ added: 2, removed: 2 })
  })

  it("a failed edit is listed but counts nothing, and doesn't decide what happened to the file", () => {
    const log = [
      call('Write', edit('/r/new.ts', '', 'a', 'write'), { failed: true }),
      call('Edit', edit('/r/new.ts', 'a', 'b'))
    ]
    const [f] = buildWork(log).files
    expect(f!.edits.map((e) => e.failed)).toEqual([true, false])
    expect(f).toMatchObject({ added: 1, removed: 1 })
    expect(fileChange(f!)).toBe('edit')
  })

  it('a file added then deleted reads as deleted', () => {
    const log = [call('create', edit('/r/t.ts', '', 'a', 'add')), call('apply_patch', { kind: 'edits', files: [{ path: '/r/t.ts', change: 'delete', hunks: [] }] })]
    expect(fileChange(buildWork(log).files[0]!)).toBe('delete')
  })

  it('makes a relative path absolute only when the directory is known', () => {
    expect(absolutePath('a.ts', '/r/')).toBe('/r/a.ts')
    expect(absolutePath('/abs/a.ts', '/r')).toBe('/abs/a.ts')
    expect(absolutePath('a.ts')).toBe('a.ts')
  })
})

describe('hasWork', () => {
  it('asks whether any call carries something for the panel', () => {
    expect(hasWork([say('hi'), { role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: 'ls' }])).toBe(false)
    expect(hasWork([call('TodoWrite', { kind: 'todos', items: [] })])).toBe(true)
  })
})
