import { describe, expect, it } from 'vitest'
import { absolutePath, buildWork, checkSummary, fileChange, needsLook, planTitle, sharedSummary, tabFor, todoSummary } from '../src/shared/work'
import type { CheckKind, FileEdit, SessionMessage, WorkArtifact } from '../src/shared/types'

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

describe('buildWork: checks', () => {
  const check = (checks: CheckKind[], command: string, status?: 'passed' | 'failed', exitCode?: number): WorkArtifact => ({
    kind: 'check',
    checks,
    command,
    ...(status ? { status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {})
  })

  it('keeps every run per check, in the tab’s order, the newest verdict as its state', () => {
    const log = [
      call('Bash', check(['tests'], 'npm test', 'failed', 1), { ts: 1 }),
      call('Bash', check(['types', 'tests'], 'npm run typecheck && npm test', 'passed', 0), { ts: 2 }),
      // still running: listed, but never the state
      call('Bash', check(['tests'], 'npm test'))
    ]
    const { checks } = buildWork(log)
    expect(checks.map((c) => c.kind)).toEqual(['types', 'tests'])
    const tests = checks[1]!
    expect(tests.runs.map((r) => r.key)).toEqual([0, 1, 2])
    expect(tests.last).toEqual({ key: 1, ts: 2, command: 'npm run typecheck && npm test', status: 'passed', exitCode: 0 })
    expect(checks[0]!.last?.key).toBe(1)
  })

  it('counts the files a landed edit touched after the verdict: the check no longer covers them', () => {
    const log = [
      call('Edit', edit('/r/a.ts', 'a', 'b')),
      call('Bash', check(['tests'], 'npm test', 'passed', 0)),
      call('Edit', edit('/r/a.ts', 'b', 'c')),
      call('Edit', edit('/r/a.ts', 'c', 'd')),
      call('Write', edit('/r/b.ts', '', 'x', 'write')),
      // an edit that never landed changes nothing
      call('Edit', edit('/r/c.ts', 'a', 'b'), { failed: true }),
      call('Bash', check(['lint'], 'npm run lint', 'failed', 1))
    ]
    const { checks } = buildWork(log)
    const byKind = Object.fromEntries(checks.map((c) => [c.kind, c]))
    expect(byKind.tests?.editedSince).toBe(2)
    expect(byKind.lint?.editedSince).toBe(0)
    expect(checks.filter(needsLook).map((c) => c.kind)).toEqual(['lint', 'tests'])
    expect(checkSummary(checks)).toBe('2 checks · 1 failing · 1 out of date')
  })

  it('says all passing only when every check has passed and nothing changed since', () => {
    const passing = buildWork([call('Bash', check(['types'], 'tsc', 'passed', 0)), call('Bash', check(['tests'], 'vitest', 'passed', 0))])
    expect(checkSummary(passing.checks)).toBe('2 checks · all passing')
    const waiting = buildWork([call('Bash', check(['tests'], 'vitest'))])
    expect(waiting.checks[0]!.last).toBeNull()
    expect(checkSummary(waiting.checks)).toBe('1 check')
  })

  it('opens a check row on the Checks tab', () => {
    expect(tabFor(check(['tests'], 'npm test'))).toBe('checks')
  })
})

describe('buildWork: what the agent shared', () => {
  const shared = (files: string[], links: { url: string; title?: string }[] = [], caption?: string): WorkArtifact => ({
    kind: 'shared',
    files,
    links,
    ...(caption ? { caption } : {})
  })

  it('lists each file and page once, newest hand-off first, paths made absolute', () => {
    const log = [
      call('SendUserFile', shared(['shot.png', '/tmp/report.md'], [], 'first'), { ts: 1 }),
      call('mcp__Claude_Browser__preview_start', shared([], [{ url: 'http://localhost:5173/' }]), { ts: 2 }),
      // sent again: moves to the top, with what was said this time
      call('SendUserFile', shared(['/r/shot.png'], [], 'again'), { ts: 3 }),
      // a write that failed handed nothing over
      call('create', shared(['/tmp/never.md']), { failed: true })
    ]
    const { shared: s } = buildWork(log, '/r')
    expect(s.files.map((f) => [f.path, f.caption, f.key])).toEqual([
      ['/r/shot.png', 'again', 2],
      ['/tmp/report.md', 'first', 0]
    ])
    expect(s.links).toEqual([{ url: 'http://localhost:5173/', key: 1, ts: 2, toolName: 'mcp__Claude_Browser__preview_start' }])
    expect(sharedSummary(s)).toBe('2 files · 1 page')
    expect(tabFor(shared(['a']))).toBe('files')
  })
})
