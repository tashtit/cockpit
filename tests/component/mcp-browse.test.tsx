import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AiSetup } from '../../src/renderer/src/AiSetup'
import { buildReport } from '../../src/shared/library'
import type { RegistryServer, RepoGroup } from '../../src/shared/types'

const repo: RepoGroup = {
  key: '/dev/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/dev/rocket',
  sessionCount: 1,
  archivedCount: 0,
  heldCount: 0,
  lastActivity: 0,
  providers: ['claude'],
  hidden: false
}

/** A server that needs a token before it can run. */
const search: RegistryServer = {
  id: 'io.github.acme/search-mcp',
  version: '1.4.0',
  title: 'Acme Search',
  description: 'Searches the acme index.',
  repository: 'https://github.com/acme/search-mcp',
  kind: 'npm',
  what: '@acme/search-mcp',
  name: 'search-mcp',
  inputs: [
    { name: 'ACME_TOKEN', description: 'An API token', required: true, secret: true },
    { name: 'ACME_TIMEOUT', description: 'Seconds', required: false, secret: false, default: '30' }
  ],
  agents: [],
  unsupported: {}
}

/** One Cockpit can't write: a container image. */
const image: RegistryServer = {
  id: 'io.github.acme/image-mcp',
  version: '2.0.0',
  title: 'Acme Image',
  description: 'Runs in docker.',
  name: 'image-mcp',
  inputs: [],
  refusal: 'it runs from a container image — Cockpit adds npm, PyPI and remote servers',
  agents: [],
  unsupported: {}
}

async function openRegistry(): Promise<void> {
  vi.mocked(window.cockpit.getPanel).mockResolvedValue(buildReport(null, []))
  render(<AiSetup repos={[repo]} repoRoot={null} onScope={vi.fn()} onClose={vi.fn()} />)
  await userEvent.click(await screen.findByRole('tab', { name: /^Browse/ }))
  await userEvent.click(screen.getByRole('button', { name: 'MCP servers' }))
}

async function searchFor(q: string, servers: readonly RegistryServer[], next?: string): Promise<void> {
  vi.mocked(window.cockpit.searchMcpRegistry).mockResolvedValue({ servers, ...(next ? { next } : {}) })
  const box = screen.getByLabelText('Search the MCP Registry')
  await userEvent.clear(box)
  await userEvent.type(box, `${q}{Enter}`)
}

describe('Agents › Browse › MCP servers', () => {
  // first in the file: the view keeps its last search for the window's lifetime
  it('asks the registry nothing until a search is submitted', async () => {
    await openRegistry()
    expect(screen.getByRole('button', { name: 'MCP servers' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/search for a server by what it does/)).toBeInTheDocument()
    expect(window.cockpit.searchMcpRegistry).not.toHaveBeenCalled()
    await searchFor('acme', [search])
    expect(window.cockpit.searchMcpRegistry).toHaveBeenCalledWith('acme', undefined)
  })

  it('lists what the registry offers, and says who published it', async () => {
    await openRegistry()
    await searchFor('acme', [search, image])
    await userEvent.click(screen.getByRole('button', { name: /^Acme Search/ }))
    expect(screen.getByText('Searches the acme index.')).toBeInTheDocument()
    expect(screen.getByText('io.github.acme/search-mcp')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Its repository' }))
    expect(window.cockpit.openExternal).toHaveBeenCalledWith('https://github.com/acme/search-mcp')
  })

  it('asks for what a server needs before adding it, and sends only what was typed', async () => {
    await openRegistry()
    await searchFor('acme', [search])
    await userEvent.click(screen.getByRole('button', { name: 'Add Acme Search to Claude' }))
    // nothing is added without the token: the row opens onto the field instead
    expect(window.cockpit.addFromMcpRegistry).not.toHaveBeenCalled()
    expect(screen.getByText(/needs ACME_TOKEN before it can be added/)).toBeInTheDocument()
    const token = screen.getByLabelText('ACME_TOKEN')
    expect(token).toHaveAttribute('type', 'password')

    await userEvent.type(token, 'sk-1')
    await userEvent.click(screen.getByRole('button', { name: 'Add Acme Search to Claude' }))
    expect(window.cockpit.addFromMcpRegistry).toHaveBeenCalledWith({
      id: 'io.github.acme/search-mcp',
      version: '1.4.0',
      agent: 'claude',
      values: { ACME_TOKEN: 'sk-1' }
    })
  })

  it('will not add what Cockpit can’t write faithfully, and says why', async () => {
    await openRegistry()
    await searchFor('acme', [image])
    const chip = screen.getByRole('button', { name: 'Add Acme Image to Codex' })
    expect(chip).toBeDisabled()
    expect(chip.getAttribute('title')).toContain('container image')
    await userEvent.click(screen.getByRole('button', { name: /^Acme Image/ }))
    expect(screen.getByText(/Cockpit can’t add it: it runs from a container image/)).toBeInTheDocument()
  })

  it('shows a server this machine runs as lit, and adds it elsewhere without asking again', async () => {
    await openRegistry()
    await searchFor('acme', [{ ...search, name: 'search', agents: ['claude'] }])
    expect(screen.getByRole('button', { name: 'Acme Search is in Claude' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Add Acme Search to Copilot' }))
    expect(window.cockpit.addFromMcpRegistry).toHaveBeenCalledWith({
      id: 'io.github.acme/search-mcp',
      version: '1.4.0',
      agent: 'copilot',
      values: {}
    })
  })

  it('narrows the results with the card’s search, and reads more only when asked', async () => {
    await openRegistry()
    await searchFor('acme', [search, image], 'io.github.acme/image-mcp:2.0.0')
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search this scope' }), 'docker')
    const list = screen.getByText('Acme Image').closest('.pnl-list') as HTMLElement
    expect(within(list).queryByText('Acme Search')).not.toBeInTheDocument()
    // a narrowed list is not the page the cursor continues
    expect(screen.queryByRole('button', { name: 'More results' })).not.toBeInTheDocument()
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search this scope' }))
    await userEvent.click(screen.getByRole('button', { name: 'More results' }))
    expect(window.cockpit.searchMcpRegistry).toHaveBeenLastCalledWith('acme', 'io.github.acme/image-mcp:2.0.0')
  })
})
