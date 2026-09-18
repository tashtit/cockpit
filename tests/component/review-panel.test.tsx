import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import type { JSX } from 'react'
import userEvent from '@testing-library/user-event'
import { formatNotes, pairLines, ReviewPanel } from '../../src/renderer/src/ReviewPanel'
import { reloadDiffLayout, setDiffLayout } from '../../src/renderer/src/diff-layout'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { DiffFile, DiffHunkLine, PrFeedback, PrStatus, WorkspaceDiff } from '../../src/shared/types'
import { openPr } from './stub-api'

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
  render(<ReviewPanel cwd="/tmp/wt" provider="claude" busy={over.busy ?? false} onCompose={over.onNotes} />)
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

/* The branch's open PR inside the review — the badge's own fixture, on this branch. */
const pr = (over: Partial<PrStatus> = {}): PrStatus =>
  openPr({ headRefName: 'cockpit/feature', checks: 'failing', review: 'changes_requested', ...over })

const fbJob = (id: number): string => `https://github.com/acme/rocket/actions/runs/9/job/${id}`

function prFeedback(over: Partial<PrFeedback> = {}): PrFeedback {
  return {
    number: 42,
    title: 'Fix the login flake',
    url: 'https://github.com/acme/rocket/pull/42',
    headRefName: 'cockpit/feature',
    baseRefName: 'main',
    conflicts: true,
    checks: [
      { name: 'lint', workflow: 'CI', bucket: 'fail', state: 'FAILURE', link: fbJob(1) },
      { name: 'e2e', workflow: 'CI', bucket: 'fail', state: 'TIMED_OUT', link: fbJob(2) },
      { name: 'unit', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: fbJob(3) },
      { name: 'release', workflow: 'CI', bucket: 'skipping', state: 'SKIPPED', link: null }
    ],
    changeRequests: [{ author: 'mona', body: 'Please add a test.', url: 'https://github.com/acme/rocket/pull/42#r1' }],
    threads: [
      {
        path: 'src/a.ts',
        line: 2,
        side: 'RIGHT',
        outdated: false,
        comments: [
          { author: 'mona', body: 'Why the rename?', url: 'https://github.com/acme/rocket/pull/42#c1' },
          { author: 'titan', body: 'Clearer name.', url: 'https://github.com/acme/rocket/pull/42#c2' }
        ],
        moreComments: 1
      },
      {
        path: 'src/a.ts',
        line: 2,
        side: 'LEFT',
        outdated: false,
        comments: [{ author: 'hubot', body: 'The old line was fine.', url: 'https://github.com/acme/rocket/pull/42#c3' }],
        moreComments: 0
      },
      {
        path: 'src/gone.ts',
        line: null,
        side: 'RIGHT',
        outdated: true,
        comments: [{ author: 'mona', body: 'Outdated remark', url: 'https://github.com/acme/rocket/pull/42#c4' }],
        moreComments: 0
      }
    ],
    warnings: [],
    ...over
  }
}

function renderWithPr(
  over: { busy?: boolean; onCompose?: (t: string) => void; pr?: PrStatus; repoRoot?: string | null; onOpenUrl?: (u: string) => void } = {}
): { rerender: (busy: boolean) => void } {
  const el = (busy: boolean): JSX.Element => (
    <ReviewPanel
      cwd="/tmp/wt"
      provider="claude"
      busy={busy}
      onCompose={over.onCompose}
      pr={'pr' in over ? over.pr : pr()}
      repoRoot={'repoRoot' in over ? over.repoRoot : '/tmp/repo'}
      onOpenUrl={over.onOpenUrl ?? (() => {})}
    />
  )
  const r = render(el(over.busy ?? false))
  return { rerender: (busy) => r.rerender(el(busy)) }
}

describe('ReviewPanel — the branch’s pull request', () => {
  beforeEach(() => {
    vi.mocked(window.cockpit.getPrFeedback).mockResolvedValue(prFeedback())
  })

  it('reads what the open PR is waiting on and lists it', async () => {
    renderWithPr({ onCompose: vi.fn() })
    const strip = await screen.findByRole('region', { name: 'Pull request #42' })
    expect(window.cockpit.getPrFeedback).toHaveBeenCalledWith('/tmp/repo', 42)
    await within(strip).findByText('2 of 3 checks failing')
    expect(within(strip).getByText('changes requested')).toBeInTheDocument()
    expect(within(strip).getByText('3 unresolved threads')).toBeInTheDocument()
    expect(within(strip).getByText('conflicts with main')).toBeInTheDocument()
    const list = within(strip).getByRole('list', { name: 'What the pull request is waiting on' })
    expect(within(list).getByText('timed out')).toBeInTheDocument()
    expect(within(list).getByText('lint')).toBeInTheDocument()
    expect(within(list).getByText('Please add a test.')).toBeInTheDocument()
    expect(within(list).getByText('outdated')).toBeInTheDocument()
    expect(within(strip).getByRole('button', { name: 'Fix with Claude' })).toBeEnabled()
  })

  it('opens GitHub from the list', async () => {
    const onOpenUrl = vi.fn()
    renderWithPr({ onOpenUrl })
    await userEvent.click(await screen.findByRole('button', { name: 'Open the lint check on GitHub' }))
    expect(onOpenUrl).toHaveBeenCalledWith(fbJob(1))
  })

  it('hands the fix prompt to the composer and says what it could not include', async () => {
    vi.mocked(window.cockpit.getPrFixBriefing).mockResolvedValue({
      briefing: '# Fix pull request #42: Fix the login flake',
      warnings: ["Couldn't read the failed-step log for e2e — the prompt links to it instead."]
    })
    const onCompose = vi.fn()
    renderWithPr({ onCompose })
    await userEvent.click(await screen.findByRole('button', { name: 'Fix with Claude' }))
    expect(window.cockpit.getPrFixBriefing).toHaveBeenCalledWith('/tmp/repo', 42)
    await waitFor(() => expect(onCompose).toHaveBeenCalledWith('# Fix pull request #42: Fix the login flake'))
    expect(await screen.findByText(/Couldn't read the failed-step log for e2e/)).toBeInTheDocument()
  })

  it('shows progress while the prompt is gathered, and main’s refusal when it fails', async () => {
    let fail: (e: Error) => void = () => {}
    vi.mocked(window.cockpit.getPrFixBriefing).mockReturnValue(new Promise((_, rej) => (fail = rej)))
    renderWithPr({ onCompose: vi.fn() })
    await userEvent.click(await screen.findByRole('button', { name: 'Fix with Claude' }))
    expect(screen.getByRole('button', { name: /Gathering what failed/ })).toBeDisabled()
    fail(new Error("Error invoking remote method 'github:pr-fix': Error: Couldn't read PR #42 from GitHub — HTTP 401"))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't read PR #42 from GitHub — HTTP 401"))
    expect(screen.getByRole('button', { name: 'Fix with Claude' })).toBeEnabled()
  })

  it('offers no fix when nothing is waiting, or when the session takes no input', async () => {
    vi.mocked(window.cockpit.getPrFeedback).mockResolvedValue(
      prFeedback({ conflicts: false, changeRequests: [], threads: [], checks: [{ name: 'unit', workflow: 'CI', bucket: 'pass', state: 'SUCCESS', link: null }] })
    )
    const { unmount } = render(
      <ReviewPanel cwd="/tmp/wt" provider="claude" busy={false} onCompose={vi.fn()} pr={pr()} repoRoot="/tmp/repo" />
    )
    await screen.findByText('1 check passed')
    expect(screen.queryByRole('button', { name: /Fix with/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('list', { name: /waiting on/ })).not.toBeInTheDocument()
    unmount()

    vi.mocked(window.cockpit.getPrFeedback).mockResolvedValue(prFeedback())
    renderWithPr({})
    await screen.findByText('2 of 3 checks failing')
    expect(screen.queryByRole('button', { name: /Fix with/ })).not.toBeInTheDocument()
  })

  it('disables the fix mid-turn and reads the PR again once the turn settles', async () => {
    const { rerender } = renderWithPr({ onCompose: vi.fn(), busy: true })
    expect(window.cockpit.getPrFeedback).not.toHaveBeenCalled()
    rerender(false)
    await screen.findByText('2 of 3 checks failing')
    rerender(true)
    expect(screen.getByRole('button', { name: 'Fix with Claude' })).toBeDisabled()
    rerender(false)
    await waitFor(() => expect(window.cockpit.getPrFeedback).toHaveBeenCalledTimes(2))
  })

  it('stays away from merged PRs and sessions outside a repository', () => {
    renderWithPr({ pr: pr({ state: 'MERGED' }) })
    expect(screen.queryByRole('region', { name: /Pull request/ })).not.toBeInTheDocument()
    renderWithPr({ repoRoot: null })
    renderWithPr({ pr: undefined })
    expect(screen.queryByRole('region', { name: /Pull request/ })).not.toBeInTheDocument()
    expect(window.cockpit.getPrFeedback).not.toHaveBeenCalled()
  })

  it('puts reviewers’ threads under their lines — both sides — in the branch scope only', async () => {
    renderWithPr({ onCompose: vi.fn() })
    await screen.findByText('2 of 3 checks failing')
    const threads = await screen.findAllByRole('note', { name: /Unresolved review thread/ })
    // the RIGHT-side thread on the added line 2, the LEFT-side one on the removed line 2
    expect(threads).toHaveLength(2)
    expect(threads[0]).toHaveTextContent('@hubot')
    expect(threads[0]).toHaveTextContent('The old line was fine.')
    expect(threads[1]).toHaveTextContent('Why the rename?')
    expect(threads[1]).toHaveTextContent('@titan')
    expect(threads[1]).toHaveTextContent('1 more reply')
    // the file head counts the threads it shows; the outdated one has no line to sit on
    expect(screen.getByText('2 threads')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Staged' }))
    await waitFor(() => expect(screen.queryAllByRole('note', { name: /Unresolved review thread/ })).toHaveLength(0))
  })

  it('keeps threads under their lines when the diff is split', async () => {
    setDiffLayout('split')
    renderWithPr({})
    await screen.findByText('2 of 3 checks failing')
    expect(await screen.findAllByRole('note', { name: /Unresolved review thread/ })).toHaveLength(2)
  })
})

describe('ChatView → review panel', () => {
  it('brings the branch’s PR into the review', async () => {
    vi.mocked(window.cockpit.getPrFeedback).mockResolvedValue(prFeedback({ headRefName: 'cockpit/test' }))
    render(
      <ChatView
        binding={{ provider: 'codex', cwd: '/tmp/wt', nativeSessionId: 'n1', title: 't', branch: 'cockpit/test', repoRoot: '/tmp/repo' }}
        prs={[pr({ headRefName: 'cockpit/test', number: 7 })]}
        log={[]}
        busy={false}
        prBusy={false}
        onSend={() => {}}
        onCancel={() => {}}
        onCreatePr={() => {}}
        onOpenUrl={() => {}}
        onOpenHandoff={() => {}}
        onOpenLineage={() => {}}
        permissions={[]}
        onAnswerPermission={() => {}}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Changes' }))
    expect(await screen.findByRole('region', { name: 'Pull request #7' })).toBeInTheDocument()
    expect(window.cockpit.getPrFeedback).toHaveBeenCalledWith('/tmp/repo', 7)
    expect(await screen.findByRole('button', { name: 'Fix with Codex' })).toBeInTheDocument()
  })
})
