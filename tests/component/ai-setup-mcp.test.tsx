import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiSetup } from '../../src/renderer/src/AiSetup'
import type { ExtensionsInventory } from '../../src/shared/types'

const inventory: ExtensionsInventory = {
  mcp: [
    {
      name: 'linear',
      config: { url: 'https://mcp.linear.app/sse', type: 'sse' },
      agents: ['claude', 'codex'],
      presences: [
        { agent: 'claude', scope: 'user' },
        { agent: 'claude', scope: 'project', projectPath: '/home/dev/cachely' },
        { agent: 'codex', scope: 'user' }
      ]
    }
  ],
  skills: [],
  plugins: [],
  marketplaces: []
}

async function openMcpTab(): Promise<void> {
  vi.mocked(window.cockpit.getExtensions).mockResolvedValue(inventory)
  render(<AiSetup repos={[]} onClose={vi.fn()} onOpenUrl={vi.fn()} />)
  await userEvent.click(await screen.findByRole('tab', { name: 'MCP Servers' }))
  await screen.findByText('linear')
}

describe('AiSetup MCP tab', () => {
  it('shows one scope chip per presence, separating global from project entries', async () => {
    await openMcpTab()
    // claude global + codex global + claude project:cachely
    expect(screen.getAllByText('global')).toHaveLength(2)
    expect(screen.getByText('cachely')).toBeInTheDocument()
    // copilot doesn't have the server — sharing is offered, not removal
    expect(screen.getByRole('button', { name: '+ Copilot' })).toBeInTheDocument()
  })

  it('removes a single project-scoped definition after an armed confirm', async () => {
    await openMcpTab()
    const x = screen.getByRole('button', {
      name: 'Remove linear from Claude project cachely'
    })
    await userEvent.click(x)
    // first click only arms — nothing removed yet
    expect(window.cockpit.removeMcp).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('button', { name: 'Confirm removing linear from Claude project cachely' })
    )
    expect(window.cockpit.removeMcp).toHaveBeenCalledWith('linear', 'claude', '/home/dev/cachely')
  })

  it('probes on Reload and offers CLI login when the server needs auth', async () => {
    await openMcpTab()
    vi.mocked(window.cockpit.checkMcp).mockResolvedValue({ status: 'needs-auth', detail: 'HTTP 401' })
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    // the status pill carries the probe detail as its title
    expect(await screen.findByTitle('HTTP 401')).toHaveTextContent('needs login')

    // login buttons only for agents with an `mcp login` CLI — never Copilot
    expect(screen.queryByRole('button', { name: /Log in · Copilot/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in · Codex' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Log in · Claude' }))
    // claude has a user-scope entry, so login runs from the home dir (no projectPath)
    expect(window.cockpit.loginMcp).toHaveBeenCalledWith('linear', 'claude', undefined)
  })
})
