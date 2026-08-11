import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewSession } from '../../src/renderer/src/NewSession'
import type { ModelEndpoint, RepoGroup } from '../../src/shared/types'

// jsdom has no scrollIntoView; Select's open-popup effect calls it
window.HTMLElement.prototype.scrollIntoView = vi.fn()

const repo: RepoGroup = {
  key: '/home/dev/cachely',
  name: 'cachely',
  fullName: 'dev/cachely',
  root: '/home/dev/cachely',
  sessionCount: 1,
  archivedCount: 0,
  lastActivity: 1700000000000,
  providers: ['claude'],
  hidden: false
}

const endpoints: ModelEndpoint[] = [
  {
    id: 'ep-openai',
    label: 'ollama-local',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.3']
  },
  {
    id: 'ep-anthropic',
    label: 'anthropic-gw',
    type: 'anthropic',
    baseUrl: 'https://gw.example.com'
  }
]

function renderNew(): ReturnType<typeof render> {
  return render(
    <NewSession
      repo={repo}
      repos={[repo]}
      busy={false}
      onStart={vi.fn().mockResolvedValue(null)}
      onCancel={vi.fn()}
    />
  )
}

describe('NewSession endpoint select', () => {
  it('hides the provider control when no endpoint fits the agent', async () => {
    vi.mocked(window.cockpit.getModelEndpoints).mockResolvedValue(endpoints)
    window.localStorage.setItem('cockpit:provider', 'codex')
    renderNew()
    await waitFor(() => expect(window.cockpit.getModelEndpoints).toHaveBeenCalled())
    expect(screen.queryByLabelText('Model provider')).not.toBeInTheDocument()
  })

  it('offers only the endpoints the active provider can use', async () => {
    vi.mocked(window.cockpit.getModelEndpoints).mockResolvedValue(endpoints)
    window.localStorage.setItem('cockpit:provider', 'claude')
    renderNew()
    // claude can use anthropic-type endpoints only
    const trigger = await screen.findByLabelText('Model provider')
    await userEvent.click(trigger)
    expect(screen.getByRole('option', { name: 'anthropic-gw' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'ollama-local' })).not.toBeInTheDocument()
  })

  it('copilot requires picking one of the provider models', async () => {
    vi.mocked(window.cockpit.getModelEndpoints).mockResolvedValue(endpoints)
    window.localStorage.setItem('cockpit:provider', 'copilot')
    renderNew()
    const trigger = await screen.findByLabelText('Model provider')
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('option', { name: 'ollama-local' }))
    await userEvent.type(screen.getByLabelText('Task'), 'do the thing')
    const start = screen.getByRole('button', { name: 'Start session' })
    expect(start).toBeDisabled()
    // the cached catalog renders the model control as a picker, not free text
    await userEvent.click(screen.getByLabelText('Model'))
    await userEvent.click(screen.getByRole('option', { name: 'llama3.3' }))
    expect(start).toBeEnabled()
  })

  it('refreshes the catalog from the provider itself', async () => {
    vi.mocked(window.cockpit.getModelEndpoints).mockResolvedValue(endpoints)
    vi.mocked(window.cockpit.listEndpointModels).mockResolvedValue(['llama3.3', 'fresh-model'])
    window.localStorage.setItem('cockpit:provider', 'copilot')
    renderNew()
    const trigger = await screen.findByLabelText('Model provider')
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('option', { name: 'ollama-local' }))
    await waitFor(() =>
      expect(window.cockpit.listEndpointModels).toHaveBeenCalledWith('ep-openai')
    )
    await userEvent.click(screen.getByLabelText('Model'))
    expect(await screen.findByRole('option', { name: 'fresh-model' })).toBeInTheDocument()
  })
})
