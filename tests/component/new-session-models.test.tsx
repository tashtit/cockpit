import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewSession, type StartSessionRequest } from '../../src/renderer/src/NewSession'
import { HandoffView, type StartHandoffRequest } from '../../src/renderer/src/HandoffView'
import type { ModelEndpoint, RepoGroup } from '../../src/shared/types'

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

function renderNew(): ReturnType<typeof vi.fn> {
  const onStart = vi.fn(async (_req: StartSessionRequest) => null)
  render(<NewSession repo={repo} repos={[repo]} busy={false} onStart={onStart} onCancel={() => {}} />)
  return onStart
}

/** Waits for the control too — accounts and endpoints arrive after the first render. */
async function choose(label: string, option: string | RegExp): Promise<void> {
  await userEvent.click(await screen.findByLabelText(label))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

async function start(onStart: ReturnType<typeof vi.fn>): Promise<StartSessionRequest> {
  await userEvent.type(screen.getByLabelText('Task', { exact: true }), 'do the thing')
  await userEvent.click(screen.getByRole('button', { name: 'Start session' }))
  expect(onStart).toHaveBeenCalledOnce()
  return onStart.mock.calls[0][0] as StartSessionRequest
}

describe('NewSession model picker', () => {
  it('picks from the agent’s own models, and the level from what that model takes', async () => {
    window.localStorage.setItem('cockpit:provider', 'codex')
    const onStart = renderNew()
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveTextContent('default'))
    await choose('Model', /^GPT-5\.5/)
    // GPT-5.5 names its own levels and its default — no ultra, which only Sol takes
    expect(screen.getByLabelText('Thinking')).toHaveTextContent('default · medium')
    await userEvent.click(screen.getByLabelText('Thinking'))
    expect(screen.queryByRole('option', { name: 'ultra' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: 'high' }))

    const req = await start(onStart)
    expect(req.options).toMatchObject({ model: 'gpt-5.5', effort: 'high' })
  })

  it('lists Claude’s aliases, which the CLI documents but keeps no catalog of', async () => {
    renderNew()
    await userEvent.click(await screen.findByLabelText('Model'))
    expect(await screen.findByRole('option', { name: /^opus/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^sonnet/ })).toBeInTheDocument()
  })

  it('asks the chosen account’s own home for its models', async () => {
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue({
      accounts: [
        { provider: 'claude', path: '/home/dev/.claude', label: 'default', identity: 'me@home.dev', isDefault: true },
        { provider: 'claude', path: '/home/dev/.claude-work', label: 'work', identity: 'me@work.dev', isDefault: false }
      ],
      githubUser: null
    })
    renderNew()
    // one account is a read-only field; the picker appears once both have loaded
    await screen.findByRole('button', { name: /^Account/ })
    await choose('Account', /me@work\.dev/)
    await waitFor(() =>
      expect(window.cockpit.listAgentModels).toHaveBeenCalledWith('claude', '/home/dev/.claude-work')
    )
  })

  it('drops a model and level the new agent doesn’t have', async () => {
    window.localStorage.setItem('cockpit:provider', 'codex')
    const onStart = renderNew()
    await choose('Model', /^GPT-5\.6-Sol/)
    await choose('Thinking', 'ultra')
    await userEvent.click(screen.getByRole('button', { name: /^Claude/ }))

    expect(screen.getByLabelText('Model')).toHaveTextContent('default')
    expect(screen.getByLabelText('Thinking')).toHaveTextContent('default')
    const req = await start(onStart)
    expect(req.provider).toBe('claude')
    expect(req.options.model).toBeUndefined()
    expect(req.options.effort).toBeUndefined()
  })

  // Azure serves deployments, and a deployment name is the model: with nothing to pick
  // from, the field has to take what the person types
  it('takes a typed model only where the provider lists none', async () => {
    const azure: ModelEndpoint = {
      id: 'ep-azure',
      label: 'azure',
      type: 'azure',
      baseUrl: 'https://acme.openai.azure.com'
    }
    vi.mocked(window.cockpit.getModelEndpoints).mockResolvedValue([azure])
    window.localStorage.setItem('cockpit:provider', 'copilot')
    const onStart = renderNew()
    await choose('Model provider', 'azure')
    const field = screen.getByRole('textbox', { name: 'Model' })
    expect(field).toHaveAttribute('placeholder', 'required')
    await userEvent.type(field, 'my-gpt-deployment')

    const req = await start(onStart)
    expect(req.options).toMatchObject({ model: 'my-gpt-deployment', modelEndpoint: 'ep-azure' })
  })
})

describe('HandoffView model picker', () => {
  it('continues on the model and level picked for the target agent', async () => {
    vi.mocked(window.cockpit.getHandoffBriefing).mockResolvedValue({ briefing: 'context', cwdExists: true })
    const onStart = vi.fn(async (_req: StartHandoffRequest) => null)
    render(
      <HandoffView
        source={{
          id: 'claude:src-1',
          provider: 'claude',
          title: 'fix the login bug',
          cwd: '/tmp/wt/fix-login',
          branch: 'cockpit/fix-login',
          repoRoot: '/tmp/repo'
        }}
        busy={false}
        onStart={onStart}
        onCancel={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByLabelText('Briefing')).toHaveValue('context'))
    // Codex is the preselected target
    await choose('Model', /^GPT-5\.6-Sol/)
    await choose('Thinking', 'ultra')
    await userEvent.click(screen.getByRole('button', { name: /Continue in Codex/ }))

    const req = onStart.mock.calls[0][0] as StartHandoffRequest
    expect(req.options).toMatchObject({ model: 'gpt-5.6-sol', effort: 'ultra' })
  })
})
