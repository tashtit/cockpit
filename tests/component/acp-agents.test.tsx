import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AcpAgents } from '../../src/renderer/src/AcpAgents'
import type { AcpAgent } from '../../src/shared/types'

const builtin: AcpAgent = {
  id: 'builtin-copilot',
  label: 'Copilot (ACP)',
  command: 'copilot',
  args: ['--acp'],
  provider: 'copilot',
  builtin: true
}

const custom: AcpAgent = {
  id: 'a1',
  label: 'Claude via adapter',
  command: 'claude-code-acp',
  provider: 'claude'
}

function api(): typeof window.cockpit {
  return window.cockpit
}

beforeEach(() => {
  vi.mocked(api().getAcpAgents).mockResolvedValue([builtin])
})

async function open(): Promise<void> {
  render(<AcpAgents onStatus={() => {}} />)
  await screen.findByText('Copilot (ACP)')
  await userEvent.click(screen.getByRole('button', { name: /Add an ACP agent/i }))
}

describe('ACP agents settings', () => {
  it('lists an agent with the CLI it drives and the command behind it', async () => {
    render(<AcpAgents onStatus={() => {}} />)
    const row = (await screen.findByText('Copilot (ACP)')).closest('li') as HTMLElement
    expect(within(row).getByText('copilot')).toBeTruthy()
    expect(within(row).getByText(/copilot --acp/)).toBeTruthy()
  })

  it('offers no way to remove a built-in — it lives in code, not config', async () => {
    render(<AcpAgents onStatus={() => {}} />)
    const row = (await screen.findByText('Copilot (ACP)')).closest('li') as HTMLElement
    expect(within(row).queryByRole('button', { name: /Remove agent/i })).toBeNull()
    expect(within(row).getByText('built in')).toBeTruthy()
  })

  it('says so when there are none', async () => {
    vi.mocked(api().getAcpAgents).mockResolvedValue([])
    render(<AcpAgents onStatus={() => {}} />)
    expect(await screen.findByText('no ACP agents')).toBeTruthy()
  })

  it('adds an agent, splitting the arguments field into argv', async () => {
    vi.mocked(api().addAcpAgent).mockResolvedValue([builtin, custom])
    await open()
    await userEvent.type(screen.getByLabelText('Display name'), 'Claude via adapter')
    await userEvent.type(screen.getByLabelText('Command'), 'claude-code-acp')
    await userEvent.type(screen.getByLabelText('Arguments'), '--stdio  --verbose')
    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }))
    await waitFor(() =>
      expect(api().addAcpAgent).toHaveBeenCalledWith({
        label: 'Claude via adapter',
        provider: 'claude',
        command: 'claude-code-acp',
        args: ['--stdio', '--verbose']
      })
    )
  })

  it('refuses a relative command before it ever reaches main', async () => {
    await open()
    await userEvent.type(screen.getByLabelText('Display name'), 'Sketchy')
    await userEvent.type(screen.getByLabelText('Command'), './agent')
    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }))
    expect(screen.getByRole('alert').textContent).toMatch(/absolute path/)
    expect(api().addAcpAgent).not.toHaveBeenCalled()
  })

  it('reports what a tested agent said about itself', async () => {
    vi.mocked(api().probeAcpAgent).mockResolvedValue({
      ok: true,
      name: 'Copilot',
      version: '1.0.86',
      protocolVersion: 1,
      loadSession: true,
      listSessions: true
    })
    await open()
    await userEvent.type(screen.getByLabelText('Display name'), 'Copilot')
    await userEvent.type(screen.getByLabelText('Command'), 'copilot')
    await userEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText(/Copilot 1\.0\.86.*ACP v1.*can resume sessions/)).toBeTruthy()
  })

  it('reports why a test failed rather than accepting the command on faith', async () => {
    vi.mocked(api().probeAcpAgent).mockResolvedValue({ ok: false, error: "'nope' was not found" })
    await open()
    await userEvent.type(screen.getByLabelText('Display name'), 'Nope')
    await userEvent.type(screen.getByLabelText('Command'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/was not found/)
  })

  it('surfaces a refusal from main instead of pretending the agent was added', async () => {
    vi.mocked(api().addAcpAgent).mockRejectedValue(new Error('Invalid agent: something'))
    await open()
    await userEvent.type(screen.getByLabelText('Display name'), 'X')
    await userEvent.type(screen.getByLabelText('Command'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Add agent' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid agent/)
  })
})
