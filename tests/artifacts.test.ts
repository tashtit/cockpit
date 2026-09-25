import { describe, expect, it } from 'vitest'
import {
  acpDiffArtifact,
  acpPlanArtifact,
  fileChangeArtifact,
  pairHunks,
  parsePatch,
  parseUnifiedDiff,
  publishedUrl,
  sharedArtifact,
  todoListArtifact,
  todoStatus,
  todoTableArtifact,
  toolArtifact
} from '../src/main/parsers/artifacts'
import type { FileEdit, WorkArtifact } from '../src/shared/types'

/** The one file an edits artifact carries — every case below touches exactly one. */
function only(a: WorkArtifact | undefined): FileEdit {
  expect(a?.kind).toBe('edits')
  const files = (a as Extract<WorkArtifact, { kind: 'edits' }>).files
  expect(files).toHaveLength(1)
  return files[0]!
}

describe('toolArtifact: plans', () => {
  it("reads Claude's plan and Copilot's summary as the plan", () => {
    expect(toolArtifact('ExitPlanMode', { plan: '# Add rate limiting\n\n1. token bucket', planFilePath: '/p.md' })).toEqual({
      kind: 'plan',
      text: '# Add rate limiting\n\n1. token bucket'
    })
    expect(toolArtifact('exit_plan_mode', { summary: '**Approach:** one layer', recommendedAction: 'autopilot' })).toEqual({
      kind: 'plan',
      text: '**Approach:** one layer'
    })
  })

  it('a plan call with no words is no plan', () => {
    expect(toolArtifact('ExitPlanMode', {})).toBeUndefined()
    expect(toolArtifact('ExitPlanMode', { plan: '   ' })).toBeUndefined()
    expect(toolArtifact('exit_plan_mode', null)).toBeUndefined()
  })
})

describe('toolArtifact: to-do lists', () => {
  it("reads Claude's TodoWrite and Codex's update_plan as whole lists", () => {
    expect(
      toolArtifact('TodoWrite', {
        todos: [
          { content: 'Read the parser', status: 'completed', activeForm: 'Reading the parser' },
          { content: 'Write the test', status: 'in_progress', activeForm: 'Writing the test' },
          { content: 'Ship it', status: 'pending', activeForm: 'Shipping it' }
        ]
      })
    ).toEqual({
      kind: 'todos',
      items: [
        { text: 'Read the parser', status: 'completed' },
        { text: 'Write the test', status: 'in_progress' },
        { text: 'Ship it', status: 'pending' }
      ]
    })
    expect(
      toolArtifact('update_plan', {
        explanation: 'narrowing down',
        plan: [
          { step: 'Reproduce', status: 'completed' },
          { step: 'Fix', status: 'in_progress' }
        ]
      })
    ).toEqual({
      kind: 'todos',
      items: [
        { text: 'Reproduce', status: 'completed' },
        { text: 'Fix', status: 'in_progress' }
      ]
    })
  })

  it("reads Claude's task tools one step at a time", () => {
    expect(toolArtifact('TaskCreate', { subject: 'Wire the panel', description: 'd', activeForm: 'Wiring' })).toEqual({
      kind: 'task-add',
      items: ['Wire the panel']
    })
    expect(toolArtifact('TaskCreate', { tasks: [{ subject: 'One' }, { subject: 'Two' }, {}] })).toEqual({
      kind: 'task-add',
      items: ['One', 'Two']
    })
    expect(toolArtifact('TaskUpdate', { taskId: '3', status: 'in_progress' })).toEqual({
      kind: 'task-update',
      id: '3',
      status: 'in_progress'
    })
    expect(toolArtifact('TaskUpdate', { taskId: 4, status: 'deleted' })).toEqual({
      kind: 'task-update',
      id: '4',
      status: 'deleted'
    })
    expect(toolArtifact('TaskUpdate', { status: 'completed' })).toBeUndefined()
  })

  it('folds every CLI’s status words onto four, and anything unknown to not started', () => {
    expect(todoStatus('completed')).toBe('completed')
    expect(todoStatus('done')).toBe('completed')
    expect(todoStatus('in-progress')).toBe('in_progress')
    expect(todoStatus('IN_PROGRESS')).toBe('in_progress')
    // Copilot's to-do table has a fourth state
    expect(todoStatus('blocked')).toBe('blocked')
    expect(todoStatus('waiting')).toBe('pending')
    expect(todoStatus(undefined)).toBe('pending')
  })

  it('reads Copilot’s to-do table rows by their title', () => {
    expect(
      todoTableArtifact([
        { title: 'Read', status: 'done' },
        { title: 'Ship', status: 'blocked' },
        { title: '', status: 'pending' },
        { status: 'pending' }
      ])
    ).toEqual({
      kind: 'todos',
      items: [
        { text: 'Read', status: 'completed' },
        { text: 'Ship', status: 'blocked' }
      ]
    })
    expect(todoTableArtifact([])).toEqual({ kind: 'todos', items: [] })
    expect(todoTableArtifact('not rows')).toBeUndefined()
  })

  it('skips steps with no words and keeps a list bounded', () => {
    const a = toolArtifact('update_plan', {
      plan: [{ step: '' }, { step: 'Real' }, 'not a step', ...Array.from({ length: 100 }, (_, i) => ({ step: `s${i}` }))]
    })
    expect(a?.kind).toBe('todos')
    const items = (a as Extract<WorkArtifact, { kind: 'todos' }>).items
    expect(items[0]).toEqual({ text: 'Real', status: 'pending' })
    expect(items).toHaveLength(60)
  })

  it("reads Codex's todo_list stream item and ACP's plan entries", () => {
    expect(todoListArtifact([{ text: 'a', completed: true }, { text: 'b', completed: false }])).toEqual({
      kind: 'todos',
      items: [
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'pending' }
      ]
    })
    expect(acpPlanArtifact([{ content: 'Plan it', status: 'in_progress', priority: 'high' }])).toEqual({
      kind: 'todos',
      items: [{ text: 'Plan it', status: 'in_progress' }]
    })
    expect(acpPlanArtifact('nope')).toBeUndefined()
  })
})

describe('toolArtifact: edits', () => {
  it("a Claude Edit is its replacement, diffed, with the lines it didn't change as context", () => {
    const f = only(
      toolArtifact('Edit', {
        file_path: '/repo/src/a.ts',
        old_string: 'const a = 1\nconst b = 2\n',
        new_string: 'const a = 1\nconst b = 3\n',
        replace_all: false
      })
    )
    expect(f).toEqual({
      path: '/repo/src/a.ts',
      change: 'edit',
      hunks: [
        [
          { op: 'same', text: 'const a = 1' },
          { op: 'del', text: 'const b = 2' },
          { op: 'add', text: 'const b = 3' }
        ]
      ]
    })
  })

  it('keeps the indentation a trimmed split would lose', () => {
    const f = only(toolArtifact('Edit', { file_path: 'a.py', old_string: '    return 1', new_string: '    return 2' }))
    expect(f.hunks[0]).toEqual([
      { op: 'del', text: '    return 1' },
      { op: 'add', text: '    return 2' }
    ])
  })

  it('a MultiEdit is one file with a hunk per replacement', () => {
    const f = only(
      toolArtifact('MultiEdit', {
        file_path: '/r/a.ts',
        edits: [
          { old_string: 'x', new_string: 'y' },
          { old_string: 'p', new_string: 'q' },
          { old_string: 7, new_string: 'ignored' }
        ]
      })
    )
    expect(f.hunks).toHaveLength(2)
  })

  it("a Write is the whole file, added — the call can't say whether it existed", () => {
    const f = only(toolArtifact('Write', { file_path: '/r/new.md', content: '# Title\n\nbody\n' }))
    expect(f.change).toBe('write')
    expect(f.hunks).toEqual([
      [
        { op: 'add', text: '# Title' },
        { op: 'add', text: '' },
        { op: 'add', text: 'body' }
      ]
    ])
  })

  it("reads Copilot's edit and create", () => {
    expect(only(toolArtifact('edit', { path: '/r/a.ts', old_str: 'a', new_str: 'b' })).hunks).toEqual([
      [
        { op: 'del', text: 'a' },
        { op: 'add', text: 'b' }
      ]
    ])
    expect(only(toolArtifact('create', { path: '/r/b.ts', file_text: 'x\n' })).change).toBe('add')
    // an edit that names no file is nothing the panel can place
    expect(toolArtifact('edit', { old_str: 'a', new_str: 'b' })).toBeUndefined()
  })

  it('cuts a huge write to the file budget and says so', () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
    const f = only(toolArtifact('Write', { file_path: '/r/big.txt', content }))
    expect(f.hunks.flat()).toHaveLength(400)
    expect(f.truncated).toBe(true)
  })

  it('cuts a minified line to a readable width', () => {
    const f = only(toolArtifact('Write', { file_path: '/r/min.js', content: 'x'.repeat(5000) }))
    expect(f.hunks[0]![0]!.text.length).toBeLessThanOrEqual(400)
  })

  it('ordinary tools and unknown names carry nothing', () => {
    expect(toolArtifact('Bash', { command: 'ls' })).toBeUndefined()
    expect(toolArtifact('Read', { file_path: '/r/a' })).toBeUndefined()
    expect(toolArtifact('whatever', { plan: 'x' })).toBeUndefined()
  })
})

const PATCH = [
  '*** Begin Patch',
  '*** Add File: docs/new.md',
  '+# New',
  '+',
  '+text',
  '*** Update File: src/a.ts',
  '*** Move to: src/b.ts',
  '@@ function f() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '@@',
  '-old tail',
  '+new tail',
  '*** Delete File: src/gone.ts',
  '*** End Patch',
  ''
].join('\n')

describe('parsePatch', () => {
  it('reads every file of a patch, its hunks, a rename and a deletion', () => {
    expect(parsePatch(PATCH)).toEqual([
      {
        path: 'docs/new.md',
        change: 'add',
        hunks: [
          [
            { op: 'add', text: '# New' },
            { op: 'add', text: '' },
            { op: 'add', text: 'text' }
          ]
        ]
      },
      {
        path: 'src/a.ts',
        change: 'edit',
        movedTo: 'src/b.ts',
        hunks: [
          [
            { op: 'same', text: 'const a = 1' },
            { op: 'del', text: 'const b = 2' },
            { op: 'add', text: 'const b = 3' }
          ],
          [
            { op: 'del', text: 'old tail' },
            { op: 'add', text: 'new tail' }
          ]
        ]
      },
      { path: 'src/gone.ts', change: 'delete', hunks: [] }
    ])
  })

  it('is what apply_patch carries, bare (Copilot, Codex freeform) or under input (Codex function)', () => {
    const bare = toolArtifact('apply_patch', PATCH)
    const wrapped = toolArtifact('apply_patch', { input: PATCH })
    expect(bare).toEqual(wrapped)
    expect(bare?.kind === 'edits' && bare.files.map((f) => f.path)).toEqual(['docs/new.md', 'src/a.ts', 'src/gone.ts'])
  })

  it('finds a patch run as a shell command, as older Codex did', () => {
    const a = toolArtifact('shell', { command: ['apply_patch', PATCH] })
    expect(a?.kind).toBe('edits')
    const heredoc = toolArtifact('exec_command', { cmd: `apply_patch <<'EOF'\n${PATCH}EOF` })
    expect(heredoc?.kind).toBe('edits')
    // a shell command that is no patch is a check where it runs one, else nothing
    expect(toolArtifact('shell', { command: ['bash', '-lc', 'npm test'] })).toEqual({
      kind: 'check',
      checks: ['tests'],
      command: 'npm test',
      ownExit: true
    })
    expect(toolArtifact('shell', { command: ['bash', '-lc', 'git status'] })).toBeUndefined()
  })

  it('reads what an agent shares: files it sends, pages it publishes or opens', () => {
    expect(toolArtifact('SendUserFile', { files: ['/tmp/a.png', '', 7, 'b.md'], caption: 'Before and after', status: 'normal' })).toEqual({
      kind: 'shared',
      files: ['/tmp/a.png', 'b.md'],
      links: [],
      caption: 'Before and after'
    })
    expect(toolArtifact('Artifact', { file_path: '/tmp/r/index.html', description: 'The review' })).toEqual({
      kind: 'shared',
      files: ['/tmp/r/index.html'],
      links: [],
      caption: 'The review'
    })
    // the tool's other actions share nothing
    expect(toolArtifact('Artifact', { action: 'quickstart', intent: 'other' })).toBeUndefined()
    expect(toolArtifact('mcp__Claude_Browser__preview_start', { url: 'http://localhost:5173/' })).toEqual({
      kind: 'shared',
      files: [],
      links: [{ url: 'http://localhost:5173/' }]
    })
    expect(toolArtifact('mcp__Claude_Browser__preview_start', { name: 'dev' })).toBeUndefined()
    expect(toolArtifact('open_canvas', { canvasId: 'browser', input: { url: 'http://localhost:3345/x', title: 'Preview' } })).toEqual({
      kind: 'shared',
      files: [],
      links: [{ url: 'http://localhost:3345/x', title: 'Preview' }]
    })
    expect(toolArtifact('SendUserFile', { files: [] })).toBeUndefined()
  })

  it('never makes a page of an address that is not the web', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://open', 'http://a b', ''])
      expect(sharedArtifact({ links: [{ url }] })).toBeUndefined()
    expect(publishedUrl('Published /tmp/x.html at https://claude.ai/artifact/AbC.')).toBe('https://claude.ai/artifact/AbC')
    expect(publishedUrl('Nothing published')).toBeNull()
  })

  it('makes every agent’s shell call a check where it runs one', () => {
    expect(toolArtifact('Bash', { command: 'npm run typecheck', description: 'x' })).toMatchObject({ checks: ['types'] })
    expect(toolArtifact('bash', { command: 'npx vitest run', mode: 'sync' })).toMatchObject({ checks: ['tests'] })
    expect(toolArtifact('exec_command', { cmd: 'cargo test' })).toMatchObject({ checks: ['tests'] })
    expect(toolArtifact('Bash', { command: 'ls' })).toBeUndefined()
  })

  it('text that is not a patch is no edit', () => {
    expect(toolArtifact('apply_patch', 'just words')).toBeUndefined()
    expect(parsePatch('*** Begin Patch\n*** End Patch')).toEqual([])
  })
})

describe('parseUnifiedDiff', () => {
  it('reads the hunks and skips the headers and no-newline notes', () => {
    expect(
      parseUnifiedDiff(
        ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new', '\\ No newline at end of file', '@@ -9 +9 @@', '-z'].join(
          '\n'
        )
      )
    ).toEqual([
      [
        { op: 'same', text: 'keep' },
        { op: 'del', text: 'old' },
        { op: 'add', text: 'new' }
      ],
      [{ op: 'del', text: 'z' }]
    ])
  })
})

describe('fileChangeArtifact', () => {
  it("reads a rollout's FileChange map: content for an add, a unified diff for an update", () => {
    const a = fileChangeArtifact({
      '/r/new.ts': { type: 'add', content: 'export {}\n' },
      '/r/old.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: '/r/moved.ts' },
      '/r/gone.ts': { type: 'delete' }
    })
    expect(a).toEqual({
      kind: 'edits',
      files: [
        { path: '/r/new.ts', change: 'add', hunks: [[{ op: 'add', text: 'export {}' }]] },
        {
          path: '/r/old.ts',
          change: 'edit',
          movedTo: '/r/moved.ts',
          hunks: [
            [
              { op: 'del', text: 'a' },
              { op: 'add', text: 'b' }
            ]
          ]
        },
        { path: '/r/gone.ts', change: 'delete', hunks: [] }
      ]
    })
  })

  it("reads the exec stream's list, which names files but never lines", () => {
    expect(
      fileChangeArtifact([
        { path: 'a.ts', kind: 'update' },
        { path: 'b.ts', kind: 'add' },
        { kind: 'add' }
      ])
    ).toEqual({
      kind: 'edits',
      files: [
        { path: 'a.ts', change: 'edit', hunks: [] },
        { path: 'b.ts', change: 'add', hunks: [] }
      ]
    })
    expect(fileChangeArtifact(null)).toBeUndefined()
  })
})

describe('pairHunks and ACP diffs', () => {
  it('keeps three lines of context around each change and drops the rest of a whole file', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const after = [...before]
    after[5] = 'changed 5'
    after[30] = 'changed 30'
    const { hunks, cut } = pairHunks(before.join('\n'), after.join('\n'))
    expect(cut).toBe(false)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.filter((l) => l.op === 'same')).toHaveLength(6)
    expect(hunks[0]![0]).toEqual({ op: 'same', text: 'line 2' })
  })

  it('reads ACP diff content blocks; no old text is a new file', () => {
    const a = acpDiffArtifact([
      { type: 'content', content: { type: 'text', text: 'hi' } },
      { type: 'diff', path: '/r/a.ts', oldText: 'x\ny\n', newText: 'x\nz\n' },
      { type: 'diff', path: '/r/b.ts', oldText: null, newText: 'new\n' }
    ])
    expect(a).toEqual({
      kind: 'edits',
      files: [
        {
          path: '/r/a.ts',
          change: 'edit',
          hunks: [
            [
              { op: 'same', text: 'x' },
              { op: 'del', text: 'y' },
              { op: 'add', text: 'z' }
            ]
          ]
        },
        { path: '/r/b.ts', change: 'add', hunks: [[{ op: 'add', text: 'new' }]] }
      ]
    })
    expect(acpDiffArtifact([{ type: 'content' }])).toBeUndefined()
  })
})
