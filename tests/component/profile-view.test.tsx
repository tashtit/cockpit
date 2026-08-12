import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ProfileView } from '../../src/renderer/src/ProfileView'
import type { ActivityDay, ProfileStats } from '../../src/shared/types'

function day(d: string, sessions: number, byProvider: ActivityDay['byProvider'] = {}): ActivityDay {
  return { day: d, sessions, byProvider }
}

function profile(over: Partial<ProfileStats> = {}): ProfileStats {
  return {
    at: Date.now(),
    login: 'octocat',
    since: Date.parse('2026-01-15T00:00:00Z'),
    totalSessions: 42,
    activeDays: 12,
    currentStreak: 3,
    longestStreak: 9,
    busiestDay: day('2026-08-09', 7, { claude: 5, codex: 2 }),
    days: [day('2026-08-08', 0), day('2026-08-09', 7, { claude: 5, codex: 2 })],
    providers: [
      {
        provider: 'claude',
        sessions: 30,
        activeDays: 10,
        avgTurns: 24,
        linesAdded: 1234,
        linesRemoved: 567,
        filesTouched: 89,
        tools: [{ name: 'Bash', count: 40 }, { name: 'Edit', count: 12 }],
        models: [{ name: 'claude-opus-5', count: 30 }]
      },
      {
        provider: 'codex',
        sessions: 12,
        activeDays: 4,
        avgTurns: 0,
        linesAdded: 0,
        linesRemoved: 0,
        filesTouched: 0,
        tools: [],
        models: []
      }
    ],
    languages: [{ ext: 'ts', files: 20, linesAdded: 900 }],
    repos: [{ key: 'a', name: 'alpha', sessions: 30, lastActivity: Date.now() }],
    models: [
      { name: 'claude-opus-5', count: 30, byProvider: { claude: 22, copilot: 8 } },
      { name: 'gpt-5.6-sol', count: 12, byProvider: { codex: 12 } }
    ],
    accounts: [
      { provider: 'claude', label: 'claude', identity: 'dev@example.com', sessions: 30, lastActivity: Date.now() },
      { provider: 'codex', label: 'codex', identity: null, sessions: 12, lastActivity: Date.now() }
    ],
    hourCounts: (() => {
      const h = new Array(24).fill(0)
      h[9] = 4
      h[14] = 7
      h[23] = 1
      return h
    })(),
    ...over
  }
}

describe('ProfileView', () => {
  it('shows a loading state until the profile resolves', () => {
    vi.mocked(window.cockpit.getProfile).mockReturnValue(new Promise(() => {}))
    render(<ProfileView onClose={() => {}} />)
    expect(screen.getByText(/reading your session history/i)).toBeTruthy()
  })

  it('renders headline stats, agents, languages and repos', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)

    expect(await screen.findByText('octocat')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy() // sessions
    expect(screen.getByText('sessions')).toBeTruthy()
    expect(screen.getByText('day streak')).toBeTruthy()
    // lines edited is summed across agents
    expect(screen.getByText('1,234')).toBeTruthy()

    expect(screen.getByText('Claude')).toBeTruthy()
    expect(screen.getByText('+1,234')).toBeTruthy()
    expect(screen.getByText('−567')).toBeTruthy()
    // the model name renders as an agent chip AND a model bar — assert the chip
    expect(screen.getAllByText('claude-opus-5').length).toBeGreaterThan(0)

    expect(screen.getByText('.ts')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText(/busiest day/i)).toBeTruthy()
  })

  it('labels the heatmap and gives every day a readable tooltip', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')

    expect(screen.getByRole('img', { name: /activity over the last 2 days/i })).toBeTruthy()
    const titles = [...container.querySelectorAll('.pv-sq[title]')].map((el) =>
      el.getAttribute('title')
    )
    expect(titles.some((t) => t?.includes('no sessions'))).toBe(true)
    expect(titles.some((t) => t?.includes('7 sessions') && t.includes('5 Claude'))).toBe(true)
  })

  it('tints a day with the agent that ran most', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    const busy = [...container.querySelectorAll('.pv-sq')].find((el) =>
      el.getAttribute('title')?.includes('7 sessions')
    )
    // claude led that day (5 vs 2), so the square carries the claude hue
    expect(busy?.getAttribute('style')).toContain('--claude-rgb')
  })

  it('explains a zero-edit agent instead of showing a bare +0', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    // codex edits through shell commands, so it has sessions but no countable lines
    const codexRow = container.querySelector('.pv-agent.tint-codex')
    expect(codexRow?.textContent).toContain('no measurable edits')
    expect(codexRow?.textContent).not.toContain('+0')
    expect(codexRow?.textContent).not.toContain('0 files')
  })

  it('renders model bars split by the agents that served each model', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    const names = [...container.querySelectorAll('.pv-model-name')].map((el) => el.textContent)
    expect(names).toEqual(['claude-opus-5', 'gpt-5.6-sol'])
    // opus is served by two agents → its bar splits into two tinted segments
    const opusRow = container.querySelector('.pv-models-list li')
    expect(opusRow?.querySelectorAll('.pv-bar-split i').length).toBe(2)
    expect(opusRow?.getAttribute('title')).toContain('Claude 22')
    expect(opusRow?.getAttribute('title')).toContain('Copilot 8')
  })

  it('lists accounts with their signed-in identity or an honest gap', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    expect(screen.getByText('dev@example.com')).toBeTruthy()
    expect(screen.getByText('not signed in')).toBeTruthy()
  })

  it('shows the daily rhythm with its peak hour named', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    expect(screen.getByRole('img', { name: /busiest around 14:00/i })).toBeTruthy()
    expect(screen.getByText(/Busiest around 14:00/)).toBeTruthy()
  })

  it('shows the empty state when nothing is indexed', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(
      profile({
        totalSessions: 0,
        days: [],
        providers: [],
        languages: [],
        repos: [],
        models: [],
        accounts: []
      })
    )
    render(<ProfileView onClose={() => {}} />)
    expect(await screen.findByText(/no sessions indexed yet/i)).toBeTruthy()
  })

  it('surfaces a per-agent deep-parse failure without hiding its session count', async () => {
    const base = profile()
    const p = profile({
      providers: [base.providers[0], { ...base.providers[1], deepUnavailable: 'logs unreadable' }]
    })
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(p)
    const { container } = render(<ProfileView onClose={() => {}} />)
    expect(await screen.findByText('logs unreadable')).toBeTruthy()
    // the session count comes off the index, so it survives a failed deep parse
    const codexRow = container.querySelector('.pv-agent.tint-codex')
    expect(codexRow?.querySelector('.repo-count')?.textContent).toBe('12')
    expect(codexRow?.textContent).not.toContain('+0')
  })

  it('reports an error instead of spinning forever', async () => {
    vi.mocked(window.cockpit.getProfile).mockRejectedValue(new Error('boom'))
    render(<ProfileView onClose={() => {}} />)
    expect(await screen.findByText(/boom/)).toBeTruthy()
  })
})
