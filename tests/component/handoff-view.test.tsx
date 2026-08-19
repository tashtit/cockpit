import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HandoffView } from '../../src/renderer/src/HandoffView'
import type { HandoffSourceRef, StartHandoffRequest } from '../../src/renderer/src/HandoffView'

const source: HandoffSourceRef = {
  id: 'claude:src-1',
  provider: 'claude',
  title: 'fix the login bug',
  cwd: '/tmp/wt/fix-login',
  branch: 'cockpit/fix-login',
  repoRoot: '/tmp/repo'
}

function renderHandoff(
  over: { busy?: boolean } = {}
): { onStart: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onStart = vi.fn(async () => null)
  const onCancel = vi.fn()
  render(
    <HandoffView source={source} busy={over.busy ?? false} onStart={onStart} onCancel={onCancel} />
  )
  return { onStart, onCancel }
}

describe('HandoffView', () => {
  it('loads the briefing into the editor and defaults to a different agent', async () => {
    vi.mocked(window.cockpit.getHandoffBriefing).mockResolvedValue({
      briefing: '# Handoff briefing\n\ncontext here',
      cwdExists: true
    })
    renderHandoff()
    await waitFor(() =>
      expect(screen.getByLabelText('Briefing')).toHaveValue('# Handoff briefing\n\ncontext here')
    )
    // source is claude, so the first different provider (codex) is preselected
    expect(screen.getByRole('button', { pressed: true })).toHaveAccessibleName(/Codex/)
    expect(screen.getByRole('button', { name: /^Continue in Codex$/ })).toBeEnabled()
  })

  it('starts with the edited briefing plus the next-step section', async () => {
    vi.mocked(window.cockpit.getHandoffBriefing).mockResolvedValue({
      briefing: 'extracted context',
      cwdExists: true
    })
    const { onStart } = renderHandoff()
    await waitFor(() => expect(screen.getByLabelText('Briefing')).toHaveValue('extracted context'))

    const brief = screen.getByLabelText('Briefing')
    await userEvent.clear(brief)
    await userEvent.type(brief, 'edited context')
    await userEvent.type(
      screen.getByLabelText('What should the agent do next'),
      'run the tests'
    )
    await userEvent.click(screen.getByRole('button', { name: /Continue in Codex/ }))

    expect(onStart).toHaveBeenCalledOnce()
    const req = onStart.mock.calls[0][0] as StartHandoffRequest
    expect(req.source).toEqual(source)
    expect(req.provider).toBe('codex')
    expect(req.briefing).toBe('edited context\n\n## What to do next\n\nrun the tests')
  })

  it('blocks the handoff when the working directory is gone', async () => {
    vi.mocked(window.cockpit.getHandoffBriefing).mockResolvedValue({
      briefing: 'stale context',
      cwdExists: false,
      warnings: ['The working directory no longer exists — its git state is unavailable.']
    })
    renderHandoff()
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('working directory no longer exists')
    )
    expect(screen.getByRole('button', { name: /Continue in Codex/ })).toBeDisabled()
  })

  it('a failed briefing load offers Retry and keeps the editor usable', async () => {
    vi.mocked(window.cockpit.getHandoffBriefing)
      .mockRejectedValueOnce(new Error('not indexed yet'))
      .mockResolvedValueOnce({ briefing: 'second try', cwdExists: true })
    renderHandoff()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('not indexed yet'))

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByLabelText('Briefing')).toHaveValue('second try'))
  })

  it('Improve with AI replaces the text and Revert restores it', async () => {
    vi.mocked(window.cockpit.getHandoffBriefing).mockResolvedValue({
      briefing: 'extracted', cwdExists: true
    })
    vi.mocked(window.cockpit.improveHandoffBriefing).mockResolvedValue('ai-written briefing')
    renderHandoff()
    await waitFor(() => expect(screen.getByLabelText('Briefing')).toHaveValue('extracted'))

    await userEvent.click(screen.getByRole('button', { name: 'Improve with AI' }))
    await waitFor(() => expect(screen.getByLabelText('Briefing')).toHaveValue('ai-written briefing'))
    expect(window.cockpit.improveHandoffBriefing).toHaveBeenCalledWith('claude:src-1')

    await userEvent.click(screen.getByRole('button', { name: 'Revert to extracted' }))
    expect(screen.getByLabelText('Briefing')).toHaveValue('extracted')
  })

  it('a failed improve keeps the current text and shows the error', async () => {
    vi.mocked(window.cockpit.getHandoffBriefing).mockResolvedValue({
      briefing: 'extracted', cwdExists: true
    })
    vi.mocked(window.cockpit.improveHandoffBriefing).mockRejectedValue(new Error('claude timed out'))
    renderHandoff()
    await waitFor(() => expect(screen.getByLabelText('Briefing')).toHaveValue('extracted'))

    await userEvent.click(screen.getByRole('button', { name: 'Improve with AI' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('claude timed out'))
    expect(screen.getByLabelText('Briefing')).toHaveValue('extracted')
  })
})
