import { describe, it, expect, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TreeSidebar } from '../../src/renderer/src/TreeSidebar'
import type { PrStatus, RepoGroup, RoundtableMeta, SessionMeta } from '../../src/shared/types'
import { openPr, usageFixture } from './stub-api'

const repo: RepoGroup = {
  key: '/home/dev/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/home/dev/rocket',
  sessionCount: 2,
  archivedCount: 0,
  lastActivity: 1700000000000,
  providers: ['claude'],
  hidden: false
}

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'claude:abc',
    provider: 'claude',
    nativeId: 'abc',
    source: '/home/dev/.claude',
    title: 'fix the login flake',
    cwd: repo.root,
    logBranch: 'cockpit/login-flake',
    gitBranch: 'cockpit/login-flake',
    startedAt: 1700000000000,
    updatedAt: 1700000000000,
    messageCount: 4,
    sourcePath: '/home/dev/.claude/projects/x/abc.jsonl',
    repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root },
    ...over
  }
}

function renderSidebar(over: Partial<RepoGroup> = {}) {
  const props = {
    repos: [{ ...repo, ...over }],
    indexVersion: 0,
    accounts: null,
    zoom: 1,
    onResetZoom: vi.fn(),
    selectedId: null,
    onSelect: vi.fn(),
    onNewSession: vi.fn(),
    onRepoSetup: vi.fn(),
    selectedRoundtableId: null,
    onOpenRoundtable: vi.fn(),
    onNewTask: vi.fn(),
    onGoHome: vi.fn(),
    onNav: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenUrl: vi.fn(),
    activeView: 'welcome'
  }
  render(<TreeSidebar {...props} />)
  return props
}

/**
 * State that only exists as a visual treatment has to exist in the accessibility
 * tree too — strikethrough and a border color are invisible to a screen reader.
 */
describe('session rows state that is not colour-coded', () => {
  it('announces an archived session, which is otherwise only struck through', async () => {
    vi.mocked(window.cockpit.pageSessions).mockImplementation(async (q) =>
      q?.archived
        ? { total: 1, items: [session({ id: 'claude:old', title: 'old work', archived: true })] }
        : { total: 1, items: [session()] }
    )
    // the Archived disclosure only renders when the repo reports archived sessions
    renderSidebar({ archivedCount: 1 })

    // the live row says nothing extra; the archived one carries the word
    expect(
      await screen.findByRole('treeitem', { name: /fix the login flake/ })
    ).not.toHaveTextContent('archived')

    await userEvent.click(await screen.findByRole('button', { name: /Archived/ }))
    expect(await screen.findByRole('treeitem', { name: /old work\s*\(archived\)/ })).toBeVisible()
  })

  it('names a compact PR badge with its state, which is otherwise only a border colour', async () => {
    const pr = openPr({ isDraft: true, checks: 'none' })
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [session()] })
    vi.mocked(window.cockpit.getPrs).mockResolvedValue([pr])
    renderSidebar()

    // the badge renders only "#42" — "Draft" lives in --pr-draft and nowhere else
    const badge = await screen.findByRole('button', { name: /^Draft pull request #42/ })
    expect(badge).toHaveTextContent('#42')
    expect(badge).not.toHaveTextContent('Draft')
  })
})

/**
 * The checks verdict, the review outcome and the unresolved threads are glyphs on
 * the badge — a check, an x, a dot, a red mark, a discussion bubble and its count —
 * so, like the state colour, they have to be said in the accessible name and the
 * tooltip too.
 */
describe('PR badge checks and review', () => {
  async function renderWithPr(pr: PrStatus): Promise<HTMLElement> {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [session()] })
    vi.mocked(window.cockpit.getPrs).mockResolvedValue([pr])
    renderSidebar()
    return screen.findByRole('button', { name: /pull request #42/ })
  }

  it('shows failing checks and requested changes as marks, and says both in the name', async () => {
    const badge = await renderWithPr(openPr({ checks: 'failing', review: 'changes_requested' }))
    expect(badge).toHaveAccessibleName(
      'Open pull request #42: Fix the login flake, checks failing, changes requested'
    )
    expect(badge).toHaveAttribute('title', 'Open — #42 Fix the login flake\nchecks failing\nchanges requested')
    expect(badge.querySelector('.pr-checks.failing')).not.toBeNull()
    expect(badge.querySelector('.pr-review-mark')).not.toBeNull()
    // the compact badge still only spends its width on the number
    expect(badge).toHaveTextContent(/^#42$/)
  })

  it('gives passing, failing and pending checks three different shapes', async () => {
    const shapes = new Map<string, string | null>()
    for (const checks of ['passing', 'failing', 'pending'] as const) {
      const badge = await renderWithPr(openPr({ checks }))
      expect(badge).toHaveAccessibleName(new RegExp(`, checks ${checks}$`))
      const glyph = badge.querySelector(`.pr-checks.${checks} path`)
      expect(glyph, checks).not.toBeNull()
      shapes.set(checks, glyph?.getAttribute('d') ?? null)
      cleanup()
    }
    expect(new Set(shapes.values()).size).toBe(3)
  })

  it('keeps the tooltip-only review outcomes off the badge', async () => {
    for (const review of ['approved', 'review_required'] as const) {
      const badge = await renderWithPr(openPr({ review }))
      expect(badge).toHaveAccessibleName(new RegExp(`, ${review.replace('_', ' ')}$`))
      expect(badge.querySelector('.pr-review-mark'), review).toBeNull()
      cleanup()
    }
  })

  it('says nothing about checks while none have reported', async () => {
    const badge = await renderWithPr(openPr({ checks: 'none' }))
    expect(badge).toHaveAccessibleName('Open pull request #42: Fix the login flake')
    expect(badge.querySelector('.pr-checks')).toBeNull()
  })

  it('counts the unresolved threads beside the other marks, and spells the count out', async () => {
    const badge = await renderWithPr(
      openPr({ checks: 'failing', review: 'changes_requested', unresolvedThreads: 3 })
    )
    expect(badge).toHaveAccessibleName(
      'Open pull request #42: Fix the login flake, checks failing, changes requested, 3 unresolved threads'
    )
    expect(badge).toHaveAttribute(
      'title',
      'Open — #42 Fix the login flake\nchecks failing\nchanges requested\n3 unresolved threads'
    )
    const threads = badge.querySelector('.pr-threads')
    expect(threads).toHaveTextContent(/^3$/)
    // the digits are their own element: a narrow sidebar sheds them and keeps the glyph
    expect(threads?.querySelector('.pr-threads-n')).toHaveTextContent(/^3$/)
    // a glyph beside the number, so a bare "3" never has to explain itself
    expect(threads?.querySelector('svg[aria-hidden="true"] path')).not.toBeNull()
    expect(badge.querySelector('.pr-checks.failing')).not.toBeNull()
    expect(badge.querySelector('.pr-review-mark')).not.toBeNull()
  })

  it('says one thread in the singular, and nothing at all when none are waiting', async () => {
    const one = await renderWithPr(openPr({ unresolvedThreads: 1 }))
    expect(one).toHaveAccessibleName(/, 1 unresolved thread$/)
    expect(one.querySelector('.pr-threads')).toHaveTextContent(/^1$/)
    cleanup()

    const none = await renderWithPr(openPr({ unresolvedThreads: 0 }))
    expect(none).not.toHaveAccessibleName(/unresolved/)
    expect(none.querySelector('.pr-threads')).toBeNull()
    expect(none).toHaveTextContent(/^#42$/)
  })

  it('counts threads on a draft too — reviewers can be waiting before it is ready', async () => {
    const badge = await renderWithPr(openPr({ isDraft: true, checks: 'none', unresolvedThreads: 2 }))
    expect(badge).toHaveAccessibleName('Draft pull request #42: Fix the login flake, 2 unresolved threads')
    expect(badge.querySelector('.pr-threads')).toHaveTextContent(/^2$/)
  })

  it('lets a merged PR rest: its old verdicts are history, not a contradiction', async () => {
    const badge = await renderWithPr(
      openPr({ state: 'MERGED', checks: 'failing', review: 'changes_requested', unresolvedThreads: 4 })
    )
    expect(badge).toHaveAccessibleName('Merged pull request #42: Fix the login flake')
    expect(badge).toHaveAttribute('title', 'Merged — #42 Fix the login flake')
    expect(badge.querySelector('.pr-checks')).toBeNull()
    expect(badge.querySelector('.pr-review-mark')).toBeNull()
    expect(badge.querySelector('.pr-threads')).toBeNull()
  })

  it('shows nothing on a closed PR either', async () => {
    const badge = await renderWithPr(openPr({ state: 'CLOSED', unresolvedThreads: 2 }))
    expect(badge).toHaveAccessibleName('Closed pull request #42: Fix the login flake')
    expect(badge.querySelector('.pr-threads')).toBeNull()
    expect(badge).toHaveTextContent(/^#42$/)
  })
})

describe('handoff threads', () => {
  it('marks a chain ancestor with the elbow and announces the relationship', async () => {
    // the indexer emits chains contiguously: continuation first, then its source
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({
      total: 2,
      items: [
        session({ id: 'codex:new', provider: 'codex', title: 'continue the fix', continuedFrom: 'claude:abc' }),
        session({ title: 'fix the login flake' })
      ]
    })
    renderSidebar()

    const ancestor = await screen.findByRole('treeitem', {
      name: /fix the login flake\s*\(continued by the session above\)/
    })
    expect(ancestor.className).toContain('chained')
    // the continuation row itself is not marked
    const head = screen.getByRole('treeitem', { name: /continue the fix/ })
    expect(head.className).not.toContain('chained')
  })

  it('does not thread rows that merely sit next to each other', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({
      total: 2,
      items: [
        session({ id: 'codex:new', provider: 'codex', title: 'unrelated work' }),
        session({ title: 'fix the login flake' })
      ]
    })
    renderSidebar()

    const row = await screen.findByRole('treeitem', { name: /fix the login flake/ })
    expect(row.className).not.toContain('chained')
  })
})

describe('sidebar row controls stay reachable', () => {
  it('gives every hover action an accessible name, not just an icon', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [session()] })
    renderSidebar()

    // .row-actions is display:none until hover/focus-within, but the buttons are in the
    // DOM either way — an unnamed one would be an unusable target once revealed
    expect(await screen.findByRole('button', { name: 'Archive session' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'New session in rocket' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open acme/rocket on GitHub' })).toBeVisible()
  })

  it('keeps one always-visible New task button that fires without any hover', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [session()] })
    const { onNewTask } = renderSidebar()

    const btn = screen.getByRole('button', { name: 'New task' })
    expect(btn).toBeVisible()
    await userEvent.click(btn)
    expect(onNewTask).toHaveBeenCalled()
  })
})

describe('roundtables as tree items', () => {
  const grounded: RoundtableMeta = {
    id: 'rt-g',
    title: 'adopt biome?',
    updatedAt: 1700000000000,
    providers: ['claude', 'codex'],
    entryCount: 3,
    running: false,
    branch: 'cockpit/table-biome',
    repoRoot: repo.root
  }
  const floating: RoundtableMeta = {
    ...grounded,
    id: 'rt-f',
    title: 'tabs or spaces',
    branch: null,
    repoRoot: null
  }

  it('groups tables under their project or Chats, and expands their seat sessions', async () => {
    vi.mocked(window.cockpit.pageSessions).mockImplementation(async (q) =>
      q?.roundtableId === 'rt-g'
        ? {
            total: 1,
            items: [session({ id: 'claude:seat1', title: 'wave turn', roundtableId: 'rt-g' })]
          }
        : { total: 0, items: [] }
    )
    vi.mocked(window.cockpit.listRoundtables).mockResolvedValue([grounded, floating])
    const props = renderSidebar()

    // the grounded table sits inside its repo's children; the repo-less one gets a
    // Chats section even though no plain chat sessions exist
    const groundedRow = await screen.findByRole('treeitem', { name: /adopt biome\?/ })
    expect(await screen.findByRole('treeitem', { name: /tabs or spaces/ })).toBeVisible()
    expect(screen.getByRole('treeitem', { name: /Chats/ })).toBeVisible()

    await userEvent.click(groundedRow)
    expect(props.onOpenRoundtable).toHaveBeenCalledWith('rt-g')

    // the chevron reveals the seat-sessions the table spawned — hidden everywhere else
    await userEvent.click(within(groundedRow).getByRole('button', { name: 'Show seat sessions' }))
    await waitFor(() =>
      expect(window.cockpit.pageSessions).toHaveBeenCalledWith(
        expect.objectContaining({ roundtableId: 'rt-g' })
      )
    )
    const seat = await screen.findByRole('treeitem', { name: /wave turn/ })
    await userEvent.click(seat)
    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude:seat1', roundtableId: 'rt-g' })
    )
  })
})

/**
 * The footer is a glance: the usage row opens Settings at its own section, the
 * identity bar opens Settings plain — same affordance, different landing.
 */
describe('sidebar footer', () => {
  it('opens Settings at the usage section from the meters, plain from the identity bar', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue(usageFixture())
    const props = renderSidebar()
    await userEvent.click(await screen.findByRole('button', { name: /^Subscription usage/ }))
    expect(props.onOpenSettings).toHaveBeenLastCalledWith('usage')
    await userEvent.click(screen.getByRole('button', { name: 'Accounts — open settings' }))
    expect(props.onOpenSettings).toHaveBeenLastCalledWith()
  })

  it('shows no usage row when nothing is measured', async () => {
    renderSidebar()
    await waitFor(() => expect(window.cockpit.getUsage).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /^Subscription usage/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Accounts — open settings' })).toBeInTheDocument()
  })
})

describe('project order', () => {
  const project = (name: string): RepoGroup => ({
    ...repo,
    key: `gh:acme/${name}`,
    name,
    fullName: `acme/${name}`,
    root: `/home/dev/${name}`
  })

  function renderProjects(repos: RepoGroup[]) {
    const props = { ...renderSidebarProps(), repos }
    render(<TreeSidebar {...props} />)
  }

  function renderSidebarProps() {
    return {
      repos: [] as RepoGroup[],
      indexVersion: 0,
      accounts: null,
      zoom: 1,
      onResetZoom: vi.fn(),
      selectedId: null,
      onSelect: vi.fn(),
      onNewSession: vi.fn(),
      onRepoSetup: vi.fn(),
      selectedRoundtableId: null,
      onOpenRoundtable: vi.fn(),
      onNewTask: vi.fn(),
      onGoHome: vi.fn(),
      onNav: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenUrl: vi.fn(),
      activeView: 'welcome'
    }
  }

  const rowNames = (): string[] =>
    Array.from(document.querySelectorAll('.repo-row .repo-name')).map((n) => n.textContent ?? '')

  it('moves a project with ⌥↓, saves every key, and announces where it went', async () => {
    renderProjects([project('apple'), project('mango'), project('zebra')])
    const row = screen.getByRole('treeitem', { name: /acme\/apple/ })
    row.focus()
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}')

    expect(rowNames()).toEqual(['acme/mango', 'acme/apple', 'acme/zebra'])
    expect(window.cockpit.setRepoOrder).toHaveBeenCalledWith([
      'gh:acme/mango',
      'gh:acme/apple',
      'gh:acme/zebra'
    ])
    expect(screen.getByRole('status')).toHaveTextContent('acme/apple moved to position 2 of 3')
  })

  it('drops a dragged project after the one it lands on, and ignores foreign drags', () => {
    renderProjects([project('apple'), project('mango'), project('zebra')])
    const types: string[] = []
    const dataTransfer = {
      types,
      setData: (t: string) => types.push(t),
      effectAllowed: '',
      dropEffect: ''
    }
    const node = (name: string): HTMLElement =>
      screen.getByRole('treeitem', { name: new RegExp(`acme/${name}`) }).parentElement as HTMLElement

    // a file or anything else dragged over the tree is not a reorder
    fireEvent.dragOver(node('mango'), { dataTransfer: { types: ['Files'] } })
    expect(node('mango')).not.toHaveClass('drop-after')

    fireEvent.dragStart(screen.getByRole('treeitem', { name: /acme\/apple/ }), { dataTransfer })
    expect(node('apple')).toHaveClass('dragging')
    // jsdom drag events carry no pointer position, which reads as the lower half
    fireEvent.dragOver(node('mango'), { dataTransfer })
    expect(node('mango')).toHaveClass('drop-after')
    fireEvent.drop(node('mango'), { dataTransfer })

    expect(rowNames()).toEqual(['acme/mango', 'acme/apple', 'acme/zebra'])
    expect(window.cockpit.setRepoOrder).toHaveBeenCalledWith([
      'gh:acme/mango',
      'gh:acme/apple',
      'gh:acme/zebra'
    ])
    expect(node('apple')).not.toHaveClass('dragging')
  })

  it('offers sort A→Z only while the projects are in a dragged order', async () => {
    renderProjects([project('apple'), project('zebra')])
    await userEvent.click(screen.getByRole('button', { name: 'Choose projects to display' }))
    expect(screen.queryByRole('button', { name: /sort A→Z/ })).toBeNull()
    cleanup()

    renderProjects([project('zebra'), project('apple')])
    await userEvent.click(screen.getByRole('button', { name: 'Choose projects to display' }))
    await userEvent.click(screen.getByRole('button', { name: /sort A→Z/ }))
    expect(window.cockpit.setRepoOrder).toHaveBeenCalledWith([])
    expect(rowNames()).toEqual(['acme/apple', 'acme/zebra'])
  })
})
