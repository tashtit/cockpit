import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TreeSidebar } from '../../src/renderer/src/TreeSidebar'
import type { PrStatus, RepoGroup, SessionMeta } from '../../src/shared/types'

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
    gitBranch: 'cockpit/login-flake',
    startedAt: 1700000000000,
    updatedAt: 1700000000000,
    messageCount: 4,
    sourcePath: '/home/dev/.claude/projects/x/abc.jsonl',
    repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root },
    ...over
  }
}

function renderSidebar(over: Partial<RepoGroup> = {}): void {
  render(
    <TreeSidebar
      repos={[{ ...repo, ...over }]}
      indexVersion={0}
      accounts={null}
      zoom={1}
      onResetZoom={vi.fn()}
      selectedId={null}
      onSelect={vi.fn()}
      onNewSession={vi.fn()}
      onGoHome={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenExtensions={vi.fn()}
      onOpenUrl={vi.fn()}
    />
  )
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
    const pr: PrStatus = {
      number: 42,
      title: 'Fix the login flake',
      state: 'OPEN',
      isDraft: true,
      headRefName: 'cockpit/login-flake',
      url: 'https://github.com/acme/rocket/pull/42'
    }
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [session()] })
    vi.mocked(window.cockpit.getPrs).mockResolvedValue([pr])
    renderSidebar()

    // the badge renders only "#42" — "Draft" lives in --pr-draft and nowhere else
    const badge = await screen.findByRole('button', { name: /^Draft pull request #42/ })
    expect(badge).toHaveTextContent('#42')
    expect(badge).not.toHaveTextContent('Draft')
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
})
