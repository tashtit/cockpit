import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiSetup } from '../../src/renderer/src/AiSetup'
import type { ExtensionsInventory } from '../../src/shared/types'

const sseConfig = { url: 'https://mcp.linear.app/sse', type: 'sse' }

const inventory: ExtensionsInventory = {
  mcp: [
    {
      name: 'linear',
      config: sseConfig,
      agents: ['claude', 'codex'],
      presences: [
        { agent: 'claude', scope: 'user', config: sseConfig },
        { agent: 'claude', scope: 'project', projectPath: '/home/dev/cachely', config: sseConfig },
        { agent: 'codex', scope: 'user', config: sseConfig }
      ]
    }
  ],
  skills: [],
  plugins: [],
  marketplaces: []
}

async function openMcpTab(): Promise<void> {
  vi.mocked(window.cockpit.getExtensions).mockResolvedValue(inventory)
  render(<AiSetup repos={[]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
  await userEvent.click(await screen.findByRole('tab', { name: 'MCP health' }))
  await screen.findByText('linear')
}

describe('Agents › MCP health', () => {
  it('shows where each server is defined, without offering to change it here', async () => {
    await openMcpTab()
    // claude global + codex global + claude project:cachely
    expect(screen.getAllByText('global')).toHaveLength(2)
    expect(screen.getByText('cachely')).toBeInTheDocument()
    // switching servers on and off belongs to the Panel — this tab only probes
    expect(screen.queryByRole('button', { name: '+ Copilot' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
  })

  it('probes on Check and offers CLI login when the server needs auth', async () => {
    await openMcpTab()
    vi.mocked(window.cockpit.checkMcp).mockResolvedValue({ status: 'needs-auth', detail: 'HTTP 401' })
    await userEvent.click(screen.getByRole('button', { name: 'Check' }))
    // the status pill carries the probe detail as its title
    expect(await screen.findByTitle('HTTP 401')).toHaveTextContent('needs login')
    // claude and codex have an `mcp login`; copilot never does
    expect(screen.getByRole('button', { name: 'Log in · Claude' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Log in · Copilot' })).not.toBeInTheDocument()
  })

  it('logs in from the project directory when the server is project-only', async () => {
    vi.mocked(window.cockpit.getExtensions).mockResolvedValue({
      ...inventory,
      mcp: [
        {
          name: 'linear',
          config: sseConfig,
          agents: ['claude'],
          presences: [
            { agent: 'claude', scope: 'project', projectPath: '/home/dev/cachely', config: sseConfig }
          ]
        }
      ]
    })
    render(<AiSetup repos={[]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
    await userEvent.click(await screen.findByRole('tab', { name: 'MCP health' }))
    vi.mocked(window.cockpit.checkMcp).mockResolvedValue({ status: 'needs-auth' })
    await userEvent.click(await screen.findByRole('button', { name: 'Check' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Log in · Claude' }))
    expect(window.cockpit.loginMcp).toHaveBeenCalledWith('linear', 'claude', '/home/dev/cachely')
  })
})
