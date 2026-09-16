import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { reloadDiffLayout } from '../../src/renderer/src/diff-layout'
import { InstructionsEditor } from '../../src/renderer/src/InstructionsEditor'
import type { InstructionFile, InstructionsState } from '../../src/shared/types'

// the layout store caches its value at module load; the shared setup clears
// localStorage between tests, so re-read it or one test's Split leaks into the next
beforeEach(() => reloadDiffLayout())

const BASE = '# Rules\n\nUse worktrees.\nNever push.'

const file = (over: Partial<InstructionFile>): InstructionFile => ({
  agents: ['claude'],
  path: '/Users/me/.claude/CLAUDE.md',
  exists: true,
  content: 'own\n',
  block: BASE,
  own: { above: 12, below: 0 },
  duplicates: 0,
  status: 'synced',
  ...over
})

const state: InstructionsState = {
  repoRoot: null,
  baseline: BASE,
  files: [
    file({}),
    file({
      agents: ['codex'],
      path: '/Users/me/.codex/AGENTS.md',
      block: BASE.replace('worktrees', 'branches'),
      own: { above: 3, below: 1 },
      status: 'drifted'
    }),
    file({
      agents: ['copilot'],
      path: '/Users/me/.copilot/copilot-instructions.md',
      exists: false,
      content: '',
      block: null,
      own: { above: 0, below: 0 },
      status: 'missing'
    })
  ]
}

async function open(s: InstructionsState = state): Promise<void> {
  vi.mocked(window.cockpit.getInstructions).mockResolvedValue(s)
  render(<InstructionsEditor repoRoot={null} setNotice={vi.fn()} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: /^Changes/ })
}

const changesTab = (): HTMLElement => screen.getByRole('button', { name: /^Changes/ })
const block = (path: string): HTMLElement => screen.getByRole('region', { name: `Changes to ${path}` })
const diffLines = (el: HTMLElement, op: 'add' | 'del'): string[] =>
  [...el.querySelectorAll(`.idiff-line.${op} .idiff-text`)].map((n) => n.textContent ?? '')

describe('Instructions › the Changes tab', () => {
  it('counts the files an apply would write, and shows each one as a diff', async () => {
    await open()
    expect(changesTab()).toHaveTextContent('Changes2')
    await userEvent.click(changesTab())
    expect(screen.getByText(/Writes/)).toHaveTextContent('Writes 2 of 3 files')

    // the drifted block: the old line out, the new line in — and nothing else
    const codex = block('~/.codex/AGENTS.md')
    expect(diffLines(codex, 'del')).toEqual(['Use branches.'])
    expect(diffLines(codex, 'add')).toEqual(['Use worktrees.'])
    expect(within(codex).getByText('rewrites block')).toBeInTheDocument()

    // a file that doesn't exist yet is created, every line new
    const copilot = block('~/.copilot/copilot-instructions.md')
    expect(within(copilot).getByText('creates file')).toBeInTheDocument()
    expect(diffLines(copilot, 'add')).toHaveLength(4)
    expect(diffLines(copilot, 'del')).toEqual([])

    // a file already carrying the text says so, and draws no diff
    const claude = block('~/.claude/CLAUDE.md')
    expect(within(claude).getByText('no changes')).toBeInTheDocument()
    expect(claude.querySelector('.idiff-body')).toBeNull()
  })

  it('shows the markers, and counts the agent’s own lines that stay put', async () => {
    await open()
    await userEvent.click(changesTab())
    const codex = block('~/.codex/AGENTS.md')
    // the rails are the pair the apply writes — the plugin's, never the older cockpit one
    expect(within(codex).getByText('<!-- agent-parity:shared:start -->')).toBeInTheDocument()
    expect(within(codex).getByText('<!-- agent-parity:shared:end -->')).toBeInTheDocument()
    expect(within(codex).getByText(/3 lines outside the markers stay as they are/)).toBeInTheDocument()
    expect(within(codex).getByText(/1 line outside the markers stays as it is/)).toBeInTheDocument()
    // colour and glyph never carry the state alone
    expect(within(codex).getByText('removed:')).toHaveClass('sr-only')
  })

  it('says when the write drops a second copy of the block', async () => {
    // the same text under both spellings of the markers: nothing changes inside the
    // rails, but the file is still written, and the review says why
    await open({
      ...state,
      files: [file({ duplicates: 1, own: { above: 2, below: 0 }, status: 'drifted' })]
    })
    expect(changesTab()).toHaveTextContent('Changes1')
    await userEvent.click(changesTab())
    const claude = block('~/.claude/CLAUDE.md')
    expect(within(claude).getByText('rewrites block')).toBeInTheDocument()
    expect(within(claude).getByText(/a second copy of the block is dropped/)).toBeInTheDocument()
    expect(diffLines(claude, 'add')).toEqual([])
    expect(diffLines(claude, 'del')).toEqual([])
  })

  it('reviews an unsaved draft as the draft, and says so', async () => {
    await open()
    await userEvent.type(screen.getByRole('textbox', { name: 'Shared instructions' }), '\nOne more rule.')
    // the file in sync with the *saved* baseline is now a write too
    expect(changesTab()).toHaveTextContent('Changes3')
    await userEvent.click(changesTab())
    expect(screen.getByText(/Writes/)).toHaveTextContent('Writes 3 of 3 files')
    expect(screen.getByText('comparing with your unsaved draft')).toBeInTheDocument()
    const claude = block('~/.claude/CLAUDE.md')
    expect(within(claude).getByText('rewrites block')).toBeInTheDocument()
    expect(diffLines(claude, 'add')).toEqual(['One more rule.'])
    // and the per-file button, which writes the saved text, says which text it writes
    expect(screen.getByRole('button', { name: 'Re-apply' })).toHaveAttribute(
      'title',
      expect.stringMatching(/saved baseline/)
    )
  })

  it('jumps from a file row to that file’s own changes', async () => {
    await open()
    await userEvent.click(
      screen.getByRole('button', { name: 'See what applying changes in /Users/me/.codex/AGENTS.md' })
    )
    expect(changesTab()).toHaveAttribute('aria-pressed', 'true')
    const head = block('~/.codex/AGENTS.md').querySelector('.idiff-head')
    expect(head).toHaveFocus()
    // a row already in sync has nothing to jump to
    expect(
      screen.queryByRole('button', { name: 'See what applying changes in /Users/me/.claude/CLAUDE.md' })
    ).not.toBeInTheDocument()
  })

  it('folds a quiet stretch and opens it on request', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `rule ${i}`).join('\n')
    await open({
      repoRoot: null,
      baseline: `${long}\nlast`,
      files: [file({ block: `${long}\nold last`, status: 'drifted' })]
    })
    await userEvent.click(changesTab())
    const claude = block('~/.claude/CLAUDE.md')
    // two lines of context before the change; the ten before them fold
    const fold = within(claude).getByRole('button', { name: /10 unchanged lines/ })
    expect(within(claude).queryByText('rule 0')).not.toBeInTheDocument()
    expect(within(claude).getByText('rule 10')).toBeInTheDocument()
    await userEvent.click(fold)
    expect(within(claude).getByText('rule 0')).toBeInTheDocument()
    expect(within(claude).queryByRole('button', { name: /unchanged lines/ })).not.toBeInTheDocument()
  })

  it('lays the diff side by side on request, and remembers the choice', async () => {
    await open()
    await userEvent.click(changesTab())
    const toggle = screen.getByRole('group', { name: 'Diff layout' })
    expect(within(toggle).getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(within(toggle).getByRole('button', { name: 'Split' }))

    // the removed line sits across from the line that replaces it
    const codex = block('~/.codex/AGENTS.md')
    const pair = [...codex.querySelectorAll('.idiff-pair')].find((p) => p.querySelector('.del'))
    expect(pair?.children[0]).toHaveTextContent('Use branches.')
    expect(pair?.children[0]).toHaveClass('del')
    expect(pair?.children[1]).toHaveTextContent('Use worktrees.')
    expect(pair?.children[1]).toHaveClass('add')
    // a created file has nothing on the left: blank cells, not a slid column
    const copilot = block('~/.copilot/copilot-instructions.md')
    expect(copilot.querySelectorAll('.idiff-pair .idiff-line.empty')).toHaveLength(4)

    expect(window.localStorage.getItem('cockpit:diff-layout')).toBe('split')
    await userEvent.click(within(toggle).getByRole('button', { name: 'Unified' }))
    expect(codex.querySelector('.idiff-pair')).toBeNull()
    expect(diffLines(codex, 'del')).toEqual(['Use branches.'])
  })

  it('opens the review in the layout it was left in', async () => {
    window.localStorage.setItem('cockpit:diff-layout', 'split')
    reloadDiffLayout()
    await open()
    await userEvent.click(changesTab())
    expect(screen.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true')
    expect(block('~/.codex/AGENTS.md').querySelector('.idiff-pair')).not.toBeNull()
  })

  it('has nothing to compare while the draft is empty', async () => {
    await open({ repoRoot: null, baseline: '', files: [file({ block: null, status: 'unmanaged' })] })
    expect(changesTab()).toHaveTextContent(/^Changes$/)
    await userEvent.click(changesTab())
    expect(screen.getByText(/nothing to compare yet/)).toBeInTheDocument()
  })
})

/*
 * A repo's instructions belong in the repo, so the editor's third action opens a
 * PR to it — and the same drift row that offers "apply" also offers to take the
 * file's own version, which is how a teammate's merged update arrives.
 */
describe('Instructions › sharing with the repo', () => {
  const repoState: InstructionsState = {
    repoRoot: '/work/cockpit',
    baseline: BASE,
    files: [
      file({ path: '/work/cockpit/CLAUDE.md' }),
      file({
        agents: ['codex', 'copilot'],
        path: '/work/cockpit/AGENTS.md',
        block: BASE.replace('worktrees', 'branches'),
        status: 'drifted'
      })
    ]
  }

  async function openRepo(setNotice = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
    vi.mocked(window.cockpit.getInstructions).mockResolvedValue(repoState)
    render(<InstructionsEditor repoRoot="/work/cockpit" setNotice={setNotice} onSaved={vi.fn()} />)
    await screen.findByRole('button', { name: /^Changes/ })
    return setNotice
  }

  it('offers the PR only for a repo, never for the global baseline', async () => {
    await open()
    expect(screen.queryByRole('button', { name: 'Save & open PR' })).toBeNull()
  })

  it('saves the draft, opens a PR, and links it', async () => {
    const setNotice = await openRepo()
    vi.mocked(window.cockpit.saveInstructionsBaseline).mockResolvedValue(repoState)
    vi.mocked(window.cockpit.shareInstructions).mockResolvedValue({
      status: 'opened',
      url: 'https://github.com/tashtit/cockpit/pull/7'
    })

    await userEvent.type(screen.getByRole('textbox', { name: 'Shared instructions' }), '\nOne more.')
    await userEvent.click(screen.getByRole('button', { name: 'Save & open PR' }))

    expect(window.cockpit.saveInstructionsBaseline).toHaveBeenCalledWith(
      '/work/cockpit',
      `${BASE}\nOne more.`
    )
    expect(window.cockpit.shareInstructions).toHaveBeenCalledWith('/work/cockpit')
    expect(setNotice).toHaveBeenLastCalledWith({
      text: 'Pull request opened. Teammates get it once it merges and they pull.',
      kind: 'ok',
      link: { href: 'https://github.com/tashtit/cockpit/pull/7', label: 'Open pull request' }
    })
  })

  it('says so when the repo already carries this text', async () => {
    const setNotice = await openRepo()
    vi.mocked(window.cockpit.shareInstructions).mockResolvedValue({ status: 'unchanged' })
    await userEvent.click(screen.getByRole('button', { name: 'Save & open PR' }))
    expect(setNotice).toHaveBeenLastCalledWith({
      text: 'The repo already says this — nothing to open a pull request for.',
      kind: 'ok'
    })
  })

  it('shows the failure verbatim', async () => {
    const setNotice = await openRepo()
    vi.mocked(window.cockpit.shareInstructions).mockRejectedValue(
      new Error('remote: Permission to tashtit/cockpit.git denied')
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save & open PR' }))
    expect(setNotice).toHaveBeenLastCalledWith({
      text: 'remote: Permission to tashtit/cockpit.git denied',
      kind: 'error'
    })
  })

  it('takes a drifted file’s own version when asked', async () => {
    await openRepo()
    vi.mocked(window.cockpit.adoptInstructionsFrom).mockResolvedValue({
      ...repoState,
      baseline: BASE.replace('worktrees', 'branches')
    })
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Take the shared block in /work/cockpit/AGENTS.md as the baseline'
      })
    )
    expect(window.cockpit.adoptInstructionsFrom).toHaveBeenCalledWith(
      '/work/cockpit',
      '/work/cockpit/AGENTS.md'
    )
    expect(screen.getByRole('textbox', { name: 'Shared instructions' })).toHaveValue(
      BASE.replace('worktrees', 'branches')
    )
  })

  it('offers it only on a drifted file — a synced one has nothing to take', async () => {
    await openRepo()
    expect(
      screen.queryByRole('button', {
        name: 'Take the shared block in /work/cockpit/CLAUDE.md as the baseline'
      })
    ).toBeNull()
  })
})
