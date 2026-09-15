import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { formatNotes, pairLines, ReviewPanel } from '../../src/renderer/src/ReviewPanel'
import { reloadDiffLayout, setDiffLayout } from '../../src/renderer/src/diff-layout'
import type { DiffFile, DiffHunkLine, WorkspaceDiff } from '../../src/shared/types'

const line = (op: DiffHunkLine['op'], text: string, oldNo: number | null, newNo: number | null): DiffHunkLine => ({
  op,
  text,
  oldNo,
  newNo
})

const aTs: DiffFile = {
  path: 'src/a.ts',
  oldPath: null,
  status: 'modified',
  untracked: false,
  binary: false,
  added: 2,
  removed: 1,
  truncated: false,
  hunks: [
    {
      header: 'export function a',
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 4,
      lines: [
        line('same', 'one', 1, 1),
        line('del', 'two', 2, null),
        line('add', 'two changed', null, 2),
        line('add', 'two and a half', null, 3),
        line('same', 'three', 3, 4)
      ]
    }
  ]
}

const notesMd: DiffFile = {
  path: 'notes.md',
  oldPath: null,
  status: 'added',
  untracked: true,
  binary: false,
  added: 1,
  removed: 0,
  truncated: false,
  hunks: [{ header: '', oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [line('add', '# notes', null, 1)] }]
}

const blob: DiffFile = {
  path: 'blob.bin',
  oldPath: null,
  status: 'added',
  untracked: false,
  binary: true,
  added: 0,
  removed: 0,
  truncated: false,
  hunks: []
}

const moved: DiffFile = {
  ...aTs,
  path: 'src/b.ts',
  oldPath: 'src/a-old.ts',
  status: 'renamed',
  truncated: true,
  added: 300,
  removed: 12
}

function diff(over: Partial<WorkspaceDiff> = {}): WorkspaceDiff {
  return {
    cwd: '/tmp/wt',
    scope: 'branch',
    branch: 'cockpit/feature',
    base: 'origin/main',
    ahead: 2,
    behind: 1,
    dirty: true,
    files: [aTs, notesMd, blob],
    added: 3,
    removed: 1,
    droppedFiles: 0,
    ...over
  }
}

function renderPanel(over: { busy?: boolean; onNotes?: (t: string) => void } = {}): void {
  render(<ReviewPanel cwd="/tmp/wt" provider="claude" busy={over.busy ?? false} onNotes={over.onNotes} />)
}

beforeEach(() => {
  window.localStorage.clear()
  reloadDiffLayout()
  vi.mocked(window.cockpit.getWorkspaceDiff).mockResolvedValue(diff())
})

describe('ReviewPanel', () => {
  it('lists the files with their kind, stats and branch state', async () => {
    renderPanel()
    expect(window.cockpit.getWorkspaceDiff).toHaveBeenCalledWith('/tmp/wt', 'branch')
    await screen.findByText('src/a.ts')
    expect(screen.getByText('3 files')).toBeInTheDocument()
    expect(screen.getByText('2 ahead, 1 behind origin/main')).toBeInTheDocument()
    expect(screen.getByText('uncommitted changes')).toBeInTheDocument()
    expect(screen.getByText('untracked')).toBeInTheDocument()
    expect(screen.getByText('binary')).toBeInTheDocument()
    // both line numbers ride every line, and the change reads aloud
    expect(screen.getByText('two changed')).toBeInTheDocument()
    expect(screen.getAllByText('added:').length).toBeGreaterThan(0)
    expect(screen.getByText('@@ -1,3 +1,4 @@ export function a')).toBeInTheDocument()
  })

  it('switches scope and asks main again', async () => {
    renderPanel()
    await screen.findByText('src/a.ts')
    vi.mocked(window.cockpit.getWorkspaceDiff).mockResolvedValue(diff({ scope: 'staged', files: [], added: 0, removed: 0 }))
    await userEvent.click(screen.getByRole('button', { name: 'Staged' }))
    await waitFor(() => expect(window.cockpit.getWorkspaceDiff).toHaveBeenLastCalledWith('/tmp/wt', 'staged'))
    expect(screen.getByRole('button', { name: 'Staged' })).toHaveAttribute('aria-pressed', 'true')
    await screen.findByText(/No changes staged/)
  })

  it('reloads on refresh and once a running turn settles, never mid-turn', async () => {
    const { rerender } = render(<ReviewPanel cwd="/tmp/wt" provider="claude" busy={true} />)
    expect(window.cockpit.getWorkspaceDiff).not.toHaveBeenCalled()
    rerender(<ReviewPanel cwd="/tmp/wt" provider="claude" busy={false} />)
    await screen.findByText('src/a.ts')
    expect(window.cockpit.getWorkspaceDiff).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await waitFor(() => expect(window.cockpit.getWorkspaceDiff).toHaveBeenCalledTimes(2))
  })

  it('shows main’s refusal unwrapped', async () => {
    vi.mocked(window.cockpit.getWorkspaceDiff).mockRejectedValue(
      new Error("Error invoking remote method 'workspace:diff': Error: Not a git repository — nothing to review here.")
    )
    renderPanel()
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Not a git repository — nothing to review here.')
    )
  })

  it('names the cut when a file or the listing was capped', async () => {
    vi.mocked(window.cockpit.getWorkspaceDiff).mockResolvedValue(diff({ files: [moved], droppedFiles: 3 }))
    renderPanel()
    await screen.findByText('src/a-old.ts → src/b.ts')
    expect(screen.getByText(/312 lines changed in all/)).toBeInTheDocument()
    expect(screen.getByText(/3 more files not shown/)).toBeInTheDocument()
    expect(screen.getByText('renamed')).toBeInTheDocument()
  })

  it('lays lines side by side when the shared preference says split', async () => {
    setDiffLayout('split')
    renderPanel()
    await screen.findByText('two changed')
    expect(document.querySelectorAll('.idiff-pair').length).toBeGreaterThan(0)
    // the removed line sits across from the first added one; the second added line
    // faces a blank — as does the untracked file's lone line
    expect(document.querySelectorAll('.idiff-line.empty')).toHaveLength(2)
  })

  it('collects notes on lines and hands them to the composer as one message', async () => {
    const onNotes = vi.fn()
    renderPanel({ onNotes })
    await screen.findByText('two changed')
    await userEvent.click(screen.getByRole('button', { name: 'Note on src/a.ts line 2' }))
    await userEvent.type(screen.getByRole('textbox', { name: /Note for the agent on src\/a.ts line 2/ }), 'rename this{Enter}')
    expect(screen.getByRole('note')).toHaveTextContent('rename this')
    // a second note, discarded, leaves the count alone
    await userEvent.click(screen.getByRole('button', { name: 'Note on src/a.ts line 3' }))
    await userEvent.keyboard('{Escape}')
    const send = screen.getByRole('button', { name: 'Send 1 note to Claude' })
    await userEvent.click(send)
    expect(onNotes).toHaveBeenCalledOnce()
    const text = onNotes.mock.calls[0][0] as string
    expect(text).toContain('on cockpit/feature (vs origin/main)')
    expect(text).toContain('1. src/a.ts:2')
    expect(text).toContain('> two changed')
    expect(text).toContain('rename this')
    expect(screen.queryByRole('button', { name: /Send .* to Claude/ })).not.toBeInTheDocument()
  })

  it('offers no note keys when the session takes no input', async () => {
    renderPanel()
    await screen.findByText('two changed')
    expect(screen.queryByRole('button', { name: /^Note on/ })).not.toBeInTheDocument()
  })
})

describe('pairLines', () => {
  it('pairs the n-th removal with the n-th addition and spans context', () => {
    const rows = pairLines(aTs.hunks[0].lines)
    expect(rows.map(([l, r]) => [l?.text ?? null, r?.text ?? null])).toEqual([
      ['one', 'one'],
      ['two', 'two changed'],
      [null, 'two and a half'],
      ['three', 'three']
    ])
  })
})

describe('formatNotes', () => {
  it('addresses removed lines on the old side and quotes the line', () => {
    const text = formatNotes(
      [
        { path: 'a.ts', line: line('del', 'gone', 7, null), text: 'why?' },
        { path: 'b.ts', line: line('add', 'new', null, 3), text: 'two\nlines' }
      ],
      { branch: null, base: null }
    )
    expect(text).toBe(
      [
        'Review notes on the changes in this worktree:',
        '',
        '1. a.ts:7 (removed line)',
        '   > gone',
        '   why?',
        '',
        '2. b.ts:3',
        '   > new',
        '   two',
        '   lines'
      ].join('\n')
    )
  })
})
