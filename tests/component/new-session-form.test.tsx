import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewSession } from '../../src/renderer/src/NewSession'
import type { RepoGroup } from '../../src/shared/types'

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

function renderForm(): void {
  render(<NewSession repo={repo} repos={[repo]} busy={false} onStart={vi.fn()} onCancel={() => {}} />)
}

describe('NewSession form order', () => {
  it('asks for the task before where it runs and who runs it', () => {
    renderForm()
    const task = screen.getByLabelText('Task', { exact: true })
    const project = screen.getByRole('button', { name: /^Project/ })
    // DOCUMENT_POSITION_FOLLOWING: the project control comes after the task
    expect(task.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(task).toHaveFocus()
  })

  it('previews the branch the task will produce, before anything is typed into it', async () => {
    renderForm()
    const branch = screen.getByLabelText('Branch')
    expect(branch).toHaveAttribute('placeholder', 'auto-generated')

    await userEvent.type(screen.getByLabelText('Task', { exact: true }), 'Add a CHANGELOG entry for the retry fix')
    expect(branch).toHaveAttribute('placeholder', 'add-changelog-entry-retry-fix')
  })
})
