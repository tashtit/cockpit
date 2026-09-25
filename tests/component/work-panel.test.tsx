import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView, foldToolRuns } from '../../src/renderer/src/ChatView'
import { addChatMessage, refreshChatLog, setChatLog, streamChatText } from '../../src/renderer/src/chat-log'
import { DiffLines } from '../../src/renderer/src/InstructionDiff'
import type { DiffLine } from '../../src/shared/line-diff'
import type { ChatBinding } from '../../src/renderer/src/chat-binding'
import type { SessionMessage, WorkArtifact } from '../../src/shared/types'
import { parseAsks } from '../../src/shared/asks'

const binding: ChatBinding = {
  provider: 'claude',
  cwd: '/tmp/wt',
  nativeSessionId: 'abc',
  title: 'fix the flake',
  branch: 'cockpit/fix',
  repoRoot: '/tmp/repo'
}

const say = (text: string): SessionMessage => ({ role: 'assistant', kind: 'text', text })
const user = (text: string): SessionMessage => ({ role: 'user', kind: 'text', text })
const call = (toolName: string, artifact: WorkArtifact, extra: Partial<SessionMessage> = {}): SessionMessage => ({
  role: 'assistant',
  kind: 'tool_call',
  toolName,
  text: '{}',
  artifact,
  ...extra
})
const edit = (path: string): WorkArtifact => ({
  kind: 'edits',
  files: [
    {
      path,
      change: 'edit',
      hunks: [
        [
          { op: 'same', text: 'const a = 1' },
          { op: 'del', text: 'const b = 2' },
          { op: 'add', text: 'const b = 3' }
        ]
      ]
    }
  ]
})
const PLAN = '# Add rate limiting\n\n1. A token bucket per key'

function renderChat(log: SessionMessage[], over: Partial<ChatBinding> = {}): void {
  setChatLog(log)
  render(
    <ChatView
      binding={{ ...binding, ...over }}
      prs={[]}
      busy={false}
      elsewhere={false}
      prBusy={false}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      onCreatePr={vi.fn()}
      onOpenUrl={vi.fn()}
      onOpenHandoff={vi.fn()}
      onOpenLineage={vi.fn()}
      permissions={[]}
      onAnswerPermission={vi.fn()}
    />
  )
}

const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Work' })

describe('the Work key', () => {
  it('is offered only once the transcript holds a plan, a to-do list or an edit', () => {
    renderChat([user('hi'), say('hello'), { role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: 'ls' }])
    expect(screen.queryByRole('button', { name: 'Work' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(screen.queryByRole('complementary', { name: 'Work' })).not.toBeInTheDocument()
  })

  it('opens beside the transcript on the list under way, and closes by key, ⌘J and Escape', async () => {
    renderChat([
      user('fix it'),
      call('TodoWrite', {
        kind: 'todos',
        items: [
          { text: 'Reproduce', status: 'completed' },
          { text: 'Fix the parser', status: 'in_progress' }
        ]
      }),
      call('Edit', edit('/tmp/wt/src/a.ts'))
    ])
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(panel()).getByRole('tab', { name: /To-dos/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getByText('1 of 2 done')).toBeInTheDocument()
    // the state rides a word, never the mark's colour alone
    expect(within(panel()).getByText('in progress:')).toBeInTheDocument()
    // the transcript stays: the panel is beside it, not instead of it
    expect(screen.getByText('fix it')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(screen.queryByRole('complementary', { name: 'Work' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    fireEvent.keyDown(panel(), { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Work' })).not.toBeInTheDocument()
  })
  it('names a blocked step as one, and counts it as not done', async () => {
    renderChat([
      user('ship it'),
      call('sql', {
        kind: 'todos',
        items: [
          { text: 'Build', status: 'completed' },
          { text: 'Publish', status: 'blocked' }
        ]
      })
    ])
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(within(panel()).getByText('1 of 2 done')).toBeInTheDocument()
    expect(within(panel()).getByText('blocked:')).toBeInTheDocument()
    expect(within(panel()).getByText('Publish').closest('li')).toHaveClass('work-todo', 'blocked')
  })
})

describe('a row that carries work', () => {
  it('is one click from its edit: the panel opens on Edits with that file open', async () => {
    renderChat([user('fix it'), call('Edit', edit('/tmp/wt/src/a.ts'), { preview: '/tmp/wt/src/a.ts' })])
    const row = screen.getByRole('button', { name: /src\/a\.ts.*open in the Work panel/ })
    // the row says what changed before it is opened
    expect(within(row).getByText('+1')).toBeInTheDocument()
    await userEvent.click(row)
    expect(within(panel()).getByRole('tab', { name: /Edits/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getByText('src/a.ts')).toBeInTheDocument()
    expect(within(panel()).getByText('const b = 3')).toBeInTheDocument()

    fireEvent.keyDown(panel(), { key: 'Escape' })
    // closing hands focus back to the row that opened it
    expect(screen.getByRole('button', { name: /src\/a\.ts.*open in the Work panel/ })).toHaveFocus()
  })

  it('says when an edit never landed', async () => {
    renderChat([user('fix it'), call('Edit', edit('/tmp/wt/src/a.ts'), { failed: true })])
    const row = screen.getByRole('button', { name: /open in the Work panel/ })
    expect(within(row).getByText("didn't apply")).toBeInTheDocument()
    await userEvent.click(row)
    expect(within(panel()).getAllByText("didn't apply").length).toBeGreaterThan(0)
  })

  it('keeps an ordinary tool row for everything else', () => {
    renderChat([user('go'), { role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: 'ls', preview: 'ls' }])
    expect(screen.queryByRole('button', { name: /open in the Work panel/ })).not.toBeInTheDocument()
    // the collapsed ⚙︎ row: headline in the summary, raw input behind it
    expect(document.querySelector('details.tool-row')).toBeInTheDocument()
  })

  it('never folds a plan into a run of tool rows', () => {
    const tool = (i: number): SessionMessage => ({ role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: `s${i}` })
    const rows = [tool(0), tool(1), call('ExitPlanMode', { kind: 'plan', text: PLAN }), tool(2), tool(3)].map((m, key) => ({ m, key }))
    expect(foldToolRuns(rows, false).map((b) => b.kind)).toEqual(['row', 'row', 'row', 'row', 'row'])
  })
})

describe('a plan waiting for approval', () => {
  const pending = (): SessionMessage[] => [
    user('plan it'),
    call('ExitPlanMode', { kind: 'plan', text: PLAN }, { asks: parseAsks('ExitPlanMode', { plan: PLAN }) })
  ]

  it('is read in the approval card, above its two answers', async () => {
    renderChat(pending())
    const card = screen.getByRole('region', { name: 'Claude is asking you' })
    const plan = within(card).getByRole('region', { name: 'The plan' })
    expect(await within(plan).findByText(/A token bucket per key/)).toBeInTheDocument()
    expect(within(card).getByRole('radio', { name: /Approve the plan/ })).toBeInTheDocument()
  })

  it('opens in the panel, which says it is waiting on you', async () => {
    renderChat(pending())
    await userEvent.click(screen.getByRole('button', { name: 'Open in the Work panel' }))
    expect(within(panel()).getByRole('tab', { name: /Plan/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getByText('waiting for your approval')).toBeInTheDocument()
    expect(await within(panel()).findByText(/A token bucket per key/)).toBeInTheDocument()
  })

  it('the Work key opens on the plan while one waits', async () => {
    renderChat([call('Edit', edit('/tmp/wt/a.ts')), ...pending()])
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(within(panel()).getByRole('tab', { name: /Plan/ })).toHaveAttribute('aria-selected', 'true')
  })
})

describe('checks', () => {
  const check = (command: string, extra: Partial<Extract<WorkArtifact, { kind: 'check' }>> = {}): WorkArtifact => ({
    kind: 'check',
    checks: ['tests'],
    command,
    ...extra
  })

  it('a check row says how it ended, not that it failed to apply', () => {
    renderChat([user('test it'), call('Bash', check('npm test', { status: 'failed', exitCode: 1 }), { failed: true, preview: 'npm test' })])
    const row = screen.getByRole('button', { name: /npm test/ })
    expect(within(row).getByText('failed')).toHaveClass('tool-verdict', 'tone-danger')
    expect(within(row).queryByText("didn't apply")).not.toBeInTheDocument()
  })

  it('the Work key opens on a failing check, which shows its state, output and what changed since', async () => {
    renderChat([
      user('fix it'),
      call('Bash', check('npm test', { status: 'passed', exitCode: 0 }), { ts: Date.parse('2026-09-01T10:00:00Z') }),
      call('Edit', edit('/tmp/wt/src/a.ts')),
      call('Bash', { kind: 'check', checks: ['types'], command: 'npx tsc --noEmit', status: 'failed', exitCode: 2, output: ['src/a.ts(1,7): error TS2322'] })
    ])
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(within(panel()).getByRole('tab', { name: /Checks/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getByText('2 checks · 1 failing · 1 out of date')).toBeInTheDocument()
    const types = within(panel()).getByText('Typecheck').closest('li')!
    expect(within(types).getByText('failed')).toHaveClass('review-kind', 'tone-danger')
    expect(within(types).getByText('exit 2')).toBeInTheDocument()
    expect(within(types).getByText('src/a.ts(1,7): error TS2322')).toBeInTheDocument()
    const tests = within(panel()).getByText('Tests').closest('li')!
    expect(within(tests).getByText('passed')).toHaveClass('tone-ok')
    expect(within(tests).getByText('1 file edited since')).toHaveClass('work-flag')
  })

  it('keeps the runs before the newest verdict one step away', async () => {
    renderChat([
      user('fix it'),
      call('Bash', check('npm test', { status: 'failed', exitCode: 1 }), { preview: 'npm test' }),
      call('Bash', check('npm test -- --run', { status: 'passed', exitCode: 0 }), { preview: 'npm test -- --run' })
    ])
    // the older run's row opens the panel at itself: its fold opens, the run is in it
    await userEvent.click(screen.getAllByRole('button', { name: /npm test/ })[0]!)
    expect(within(panel()).getByText('1 earlier run · 1 failed')).toBeInTheDocument()
    expect(within(panel()).getByText('npm test').closest('li')).toHaveClass('work-check-run')
  })

  it('says what would appear when the agent ran none', async () => {
    renderChat([user('fix it'), call('Edit', edit('/tmp/wt/a.ts'))])
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    await userEvent.click(within(panel()).getByRole('tab', { name: /Checks/ }))
    expect(within(panel()).getByText(/No checks yet/)).toBeInTheDocument()
  })
})

describe('files', () => {
  const shared = (files: string[], links: { url: string; title?: string }[] = [], caption?: string): WorkArtifact => ({
    kind: 'shared',
    files,
    links,
    ...(caption ? { caption } : {})
  })

  it('the Work key opens on what it sent: each file read by main, with what to do with it', async () => {
    vi.mocked(window.cockpit.readSessionFile).mockResolvedValue({
      kind: 'text',
      text: '# Report\n\nAll green.',
      truncated: false,
      markdown: true,
      size: 21,
      openable: true
    })
    const onOpenUrl = vi.fn()
    setChatLog([
      user('show me'),
      call('SendUserFile', shared(['/tmp/wt/report.md'], [], 'The run'), { preview: undefined }),
      call('open_canvas', shared([], [{ url: 'http://localhost:3345/', title: 'Preview' }]))
    ])
    render(
      <ChatView
        binding={binding}
        prs={[]}
        busy={false}
        elsewhere={false}
        prBusy={false}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onCreatePr={vi.fn()}
        onOpenUrl={onOpenUrl}
        onOpenHandoff={vi.fn()}
        onOpenLineage={vi.fn()}
        permissions={[]}
        onAnswerPermission={vi.fn()}
      />
    )
    // the row names what it handed over
    expect(screen.getByRole('button', { name: /report\.md/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(within(panel()).getByRole('tab', { name: /Files/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getByText('1 file · 1 page')).toBeInTheDocument()
    expect(await within(panel()).findByRole('heading', { name: 'Report' })).toBeInTheDocument()
    expect(window.cockpit.readSessionFile).toHaveBeenCalledWith('claude:abc', '/tmp/wt/report.md')
    expect(within(panel()).getByText('The run')).toBeInTheDocument()

    await userEvent.click(within(panel()).getByRole('button', { name: 'Open' }))
    expect(window.cockpit.openSessionFile).toHaveBeenCalledWith('claude:abc', '/tmp/wt/report.md', 'open')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Show in Finder' }))
    expect(window.cockpit.openSessionFile).toHaveBeenCalledWith('claude:abc', '/tmp/wt/report.md', 'reveal')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Preview' }))
    expect(onOpenUrl).toHaveBeenCalledWith('http://localhost:3345/')
  })

  it('says a file is gone, and offers nothing to do with it', async () => {
    vi.mocked(window.cockpit.readSessionFile).mockResolvedValue({ kind: 'missing' })
    renderChat([user('show me'), call('SendUserFile', shared(['/tmp/scratch/shot.png']))])
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(await within(panel()).findByText(/no longer on disk/)).toBeInTheDocument()
    expect(within(panel()).getByText('gone')).toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'Show in Finder' })).not.toBeInTheDocument()
  })

  it('shows what main said when it would not read a file', async () => {
    vi.mocked(window.cockpit.readSessionFile).mockRejectedValue(new Error("Error invoking remote method 'sessions:file': Error: This session did not share that file."))
    renderChat([user('show me'), call('SendUserFile', shared(['/tmp/x.md']))])
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('This session did not share that file.')
  })
})

describe('the Edits tab', () => {
  it('points at Changes for what is on disk, where there is a worktree to diff', async () => {
    renderChat([call('Edit', edit('/tmp/wt/a.ts'))])
    await userEvent.click(screen.getByRole('button', { name: /open in the Work panel/ }))
    await userEvent.click(within(panel()).getByRole('button', { name: 'Changes' }))
    expect(screen.getByRole('region', { name: 'Changes to review' })).toBeInTheDocument()
  })

  it('has no Changes link outside a repository', async () => {
    renderChat([call('Edit', edit('/tmp/wt/a.ts'))], { repoRoot: null })
    await userEvent.click(screen.getByRole('button', { name: /open in the Work panel/ }))
    expect(within(panel()).queryByRole('button', { name: 'Changes' })).not.toBeInTheDocument()
  })
})

/** One change, then a long quiet stretch — the stretch folds behind a row. */
const quiet = (path: string): WorkArtifact => ({
  kind: 'edits',
  files: [
    {
      path,
      change: 'edit',
      hunks: [
        [
          { op: 'add', text: 'import { limit } from "./limit"' },
          ...Array.from({ length: 10 }, (_, i) => ({ op: 'same' as const, text: `line ${i}` }))
        ]
      ]
    }
  ]
})

describe('a fold the reader opened', () => {
  it('stays open while the turn streams, a re-read lands and another edit arrives', async () => {
    renderChat([user('fix it'), call('Edit', quiet('/tmp/wt/src/a.ts'), { ts: 1 })])
    await userEvent.click(screen.getByRole('button', { name: /open in the Work panel/ }))
    await userEvent.click(within(panel()).getByRole('button', { name: '8 unchanged lines' }))
    expect(within(panel()).getByText('line 9')).toBeInTheDocument()
    act(() => {
      streamChatText('still working')
      addChatMessage(call('Edit', quiet('/tmp/wt/src/b.ts'), { ts: 2 }))
    })
    // the log read from disk again: the same edit in a fresh object
    act(() =>
      refreshChatLog(
        structuredClone([
          user('fix it'),
          call('Edit', quiet('/tmp/wt/src/a.ts'), { ts: 1 }),
          say('still working'),
          call('Edit', quiet('/tmp/wt/src/b.ts'), { ts: 2 })
        ])
      )
    )
    expect(within(panel()).getByText('src/b.ts')).toBeInTheDocument()
    expect(within(panel()).getByText('line 9')).toBeInTheDocument()
  })

  it('closes when the lines change, not when the same lines come in a new array', async () => {
    const lines: DiffLine[] = [{ op: 'add', text: 'new' }, ...Array.from({ length: 10 }, (_, i) => ({ op: 'same' as const, text: `line ${i}` }))]
    const { rerender } = render(<DiffLines lines={lines} layout="unified" />)
    await userEvent.click(screen.getByRole('button', { name: '8 unchanged lines' }))
    rerender(<DiffLines lines={structuredClone(lines)} layout="unified" />)
    expect(screen.getByText('line 9')).toBeInTheDocument()
    rerender(<DiffLines lines={[{ op: 'add', text: 'newer' }, ...lines.slice(1)]} layout="unified" />)
    expect(screen.queryByText('line 9')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '8 unchanged lines' })).toBeInTheDocument()
  })
})
