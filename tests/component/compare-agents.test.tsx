import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiSetup } from '../../src/renderer/src/AiSetup'
import type { ExtensionsInventory, McpConfig, Provider } from '../../src/shared/types'

function server(
  name: string,
  byAgent: Partial<Record<Provider, McpConfig>>
): ExtensionsInventory['mcp'][number] {
  const presences = Object.entries(byAgent).map(([agent, config]) => ({
    agent: agent as Provider,
    scope: 'user' as const,
    config
  }))
  return { name, config: presences[0].config, agents: presences.map((p) => p.agent), presences }
}

const inventory: ExtensionsInventory = {
  mcp: [
    // one agent has it, two don't
    server('linear', { claude: { url: 'https://mcp.linear.app/sse', type: 'sse' } }),
    // two agree, one runs something else
    server('github', {
      claude: { command: 'gh-mcp', args: ['--stdio'] },
      codex: { command: 'gh-mcp', args: ['--stdio'] },
      copilot: { command: 'npx', args: ['-y', 'gh-mcp'] }
    }),
    // everybody matches — only visible with the filter off
    server('calm', { claude: { url: 'https://c' }, codex: { url: 'https://c' }, copilot: { url: 'https://c' } })
  ],
  skills: [],
  plugins: [],
  marketplaces: []
}

async function openCompare(): Promise<void> {
  vi.mocked(window.cockpit.getExtensions).mockResolvedValue(inventory)
  render(<AiSetup repos={[]} onClose={vi.fn()} onOpenUrl={vi.fn()} />)
  await screen.findByText('linear')
}

describe('Agents › Compare', () => {
  it('opens on the matrix and counts what is aligned, differing and incomplete', async () => {
    await openCompare()
    expect(screen.getByRole('tab', { name: 'Compare' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('1 aligned')).toBeInTheDocument()
    expect(screen.getByText('1 differ')).toBeInTheDocument()
    expect(screen.getByText('1 incomplete')).toBeInTheDocument()
  })

  it('hides rows every agent agrees on until the filter is turned off', async () => {
    await openCompare()
    expect(screen.queryByText('calm')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /only differences/i }))
    expect(screen.getByText('calm')).toBeInTheDocument()
  })

  it('fills a gap from the agent that already has the server', async () => {
    await openCompare()
    await userEvent.click(
      screen.getByRole('button', { name: 'Add linear to Codex from Claude' })
    )
    expect(window.cockpit.syncExtension).toHaveBeenCalledWith('mcp', 'linear', {
      to: 'codex',
      from: 'claude',
      overwrite: false
    })
  })

  it('shows which field the odd agent out disagrees on', async () => {
    await openCompare()
    await userEvent.click(screen.getByRole('button', { name: 'github' }))
    const diff = screen.getByRole('table', { name: '' }) ?? screen.getByRole('table')
    // the shared field is quiet; the differing one is called out
    expect(within(diff).getByText('npx')).toBeInTheDocument()
    expect(within(diff).getByRole('rowheader', { name: 'command' }).closest('tr')).toHaveClass(
      'differs'
    )
  })

  // overwriting an agent's own definition is destructive — one click must not do it
  it('requires an armed confirm before replacing a differing definition', async () => {
    await openCompare()
    await userEvent.click(screen.getByRole('button', { name: 'github' }))
    await userEvent.click(screen.getByRole('button', { name: 'Replace github in Copilot' }))
    expect(window.cockpit.syncExtension).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Confirm replacing github in Copilot' }))
    expect(window.cockpit.syncExtension).toHaveBeenCalledWith('mcp', 'github', {
      to: 'copilot',
      from: 'claude',
      overwrite: true
    })
  })

  it('fills every gap in a group additively, never replacing a definition', async () => {
    await openCompare()
    await userEvent.click(screen.getByRole('button', { name: 'Fill 2 gaps' }))
    // linear is missing from two agents; github differs but is left alone
    expect(window.cockpit.syncExtension).toHaveBeenCalledTimes(2)
    expect(vi.mocked(window.cockpit.syncExtension).mock.calls.map((c) => c[1])).toEqual([
      'linear',
      'linear'
    ])
  })

  it('reports a failed sync instead of claiming success', async () => {
    await openCompare()
    vi.mocked(window.cockpit.syncExtension).mockRejectedValueOnce(new Error('codex already has it'))
    await userEvent.click(
      screen.getByRole('button', { name: 'Add linear to Codex from Claude' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('codex already has it')
  })
})
