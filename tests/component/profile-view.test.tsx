import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
        readSessions: 30,
        prompts: 90,
        toolCalls: 540,
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
        readSessions: 12,
        prompts: 18,
        toolCalls: 0,
        linesAdded: 0,
        linesRemoved: 0,
        filesTouched: 0,
        tools: [],
        models: []
      }
    ],
    languages: [{ ext: 'ts', files: 20, linesAdded: 900, byProvider: { claude: 700, codex: 200 } }],
    repos: [
      {
        key: 'a',
        name: 'alpha',
        fullName: 'acme/alpha',
        sessions: 30,
        byProvider: { claude: 25, codex: 5 },
        lastActivity: Date.now()
      },
      { key: 'general', name: 'General', fullName: null, sessions: 1, byProvider: { claude: 1 }, lastActivity: Date.now() }
    ],
    models: [
      { name: 'claude-opus-5', count: 30, byProvider: { claude: 22, copilot: 8 } },
      { name: 'gpt-5.6-sol', count: 12, byProvider: { codex: 12 } }
    ],
    accounts: [
      { provider: 'claude', label: 'claude', identity: 'dev@example.com', sessions: 30, lastActivity: Date.now() },
      { provider: 'codex', label: 'codex', identity: null, sessions: 12, lastActivity: Date.now() }
    ],
    hours: (() => {
      const h = Array.from({ length: 24 }, () => ({ prompts: 0, byProvider: {} }))
      h[9] = { prompts: 4, byProvider: { claude: 4 } }
      h[14] = { prompts: 7, byProvider: { claude: 5, codex: 2 } }
      h[23] = { prompts: 1, byProvider: { codex: 1 } }
      return h
    })(),
    roundtables: null,
    ...over
  }
}

/** Each group lives on its own tab now — open the one an assertion reads. */
const openTab = async (name: string): Promise<void> => {
  await userEvent.click(await screen.findByRole('tab', { name }))
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
    // lines edited is summed across agents, both ways
    const lines = screen.getByText('lines edited').closest('.pv-stat')!
    expect(lines.textContent).toContain('+1,234')
    expect(lines.textContent).toContain('−567')
    expect(screen.getByText(/busiest day/i)).toBeTruthy()

    await openTab('Agents')
    expect(screen.getByRole('columnheader', { name: 'Claude' })).toBeTruthy()
    expect(screen.getByRole('table').textContent).toContain('+1,234')
    expect(screen.getAllByText('claude-opus-5').length).toBeGreaterThan(0)

    await openTab('Code')
    expect(screen.getByText('.ts')).toBeTruthy()
    // a repo reads as owner/name, like the sidebar; the no-repo bucket as Chats
    expect(screen.getByText('acme/').closest('li')?.textContent).toContain('acme/alpha')
    expect(screen.getByText('Chats')).toBeTruthy()
  })

  it('keys every agent color with the sessions-by-agent share in the headline', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)
    const key = await screen.findByRole('list', { name: 'Sessions by agent' })
    // 30 of 42 and 12 of 42, in the order main ranked them
    expect([...key.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Claude 71%',
      'Codex 29%'
    ])
  })

  it('compares the agents side by side, one measure per row', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)
    await openTab('Agents')
    const cells = (label: string): string[] => {
      const row = screen.getByRole('rowheader', { name: label }).closest('tr')!
      return [...row.querySelectorAll('td')].map((td) => td.textContent ?? '')
    }
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Claude', 'Codex'])
    expect(cells('Sessions')).toEqual(['30', '12'])
    // prompts per session read the same way for every agent: 90/30 and 18/12
    expect(cells('Prompts per session')).toEqual(['3', '1.5'])
    // 540 calls over 90 prompts; codex ran none, which is a count, not a gap
    expect(cells('Tool calls per prompt')).toEqual(['6', '0'])
    expect(cells('Files edited')).toEqual(['89', '—'])
    expect(cells('Top tools')[0]).toContain('Bash')
  })

  it('pages its groups in tabs, under headline numbers that stay put', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')

    // opens on when you work; the agents and code groups are not rendered at all
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Activity')
    expect(screen.queryByRole('table')).toBeNull()

    await openTab('Agents')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /activity over the last/i })).toBeNull()
    // the headline is the glance every tab keeps
    expect(screen.getByText('day streak')).toBeInTheDocument()
  })

  it('drops the Code tab when nothing edited or indexed can fill it', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile({ languages: [], repos: [] }))
    render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Activity', 'Agents'])
  })

  it('labels the heatmap and gives every day a readable tooltip', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')

    // the hues in words too: color alone must not carry which agent led
    expect(
      screen.getByRole('img', { name: 'Activity over the last 2 days: 1\u00a0active day — Claude led 1' })
    ).toBeTruthy()
    const titles = [...container.querySelectorAll('.pv-sq[title]')].map((el) =>
      el.getAttribute('title')
    )
    expect(titles.some((t) => t?.includes('no sessions'))).toBe(true)
    expect(titles).toContain('Aug 9, 2026 — 7\u00a0sessions (Claude 5 · Codex 2)')
  })

  it('keeps a light day visible beside one outlier, on a square-root scale', async () => {
    const days = [day('2026-08-07', 1, { codex: 1 }), day('2026-08-08', 4, { claude: 4 }), day('2026-08-09', 16, { claude: 16 })]
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile({ days }))
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    const alpha = (d: string): string | undefined =>
      [...container.querySelectorAll<HTMLElement>('.pv-grid .pv-sq')]
        .find((el) => el.title.startsWith(d))
        ?.style.background.match(/, ([\d.]+)\)$/)?.[1]
    // linear, 1 and 4 of 16 both landed on the faintest step; now they are told apart
    expect([alpha('Aug 7'), alpha('Aug 8'), alpha('Aug 9')]).toEqual(['0.3', '0.5', '0.95'])
    // the legend shows intensity in the hue most squares wear — the leading agent's
    const swatches = [...container.querySelectorAll<HTMLElement>('.pv-scale .pv-sq')]
    expect(swatches[4].style.background).toContain('--claude-rgb')
  })

  it('marks a long grid, which sheds its labels in a narrow card, and never lets a month overhang', async () => {
    // a year to the day before a Wednesday the 3rd: the last month label has 1 week of room
    const start = new Date(2025, 8, 3)
    const days = Array.from({ length: 366 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      return day(key, i % 9 === 0 ? 1 : 0, i % 9 === 0 ? { claude: 1 } : {})
    })
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile({ days }))
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    expect(container.querySelector('.pv-heat-scroll')?.classList.contains('pv-heat-long')).toBe(true)
    // Sep 3 2026 falls in the grid's last week: no room for "Sep" there
    const months = [...container.querySelectorAll('.pv-months span')].map((s) => s.textContent)
    expect(months[months.length - 1]).toBe('Aug')
  })

  it('leaves a short grid its labels at every width', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    expect(container.querySelector('.pv-heat-scroll')?.classList.contains('pv-heat-long')).toBe(false)
  })

  it('tints a day with the agent that ran most', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    const busy = [...container.querySelectorAll('.pv-sq')].find((el) =>
      el.getAttribute('title')?.includes('7\u00a0sessions')
    )
    // claude led that day (5 vs 2), so the square carries the claude hue
    expect(busy?.getAttribute('style')).toContain('--claude-rgb')
  })

  it("reports roundtable seats apart, since a seat's prompts are not the person's", async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(
      profile({ roundtables: { tables: 2, sessions: 5, byProvider: { claude: 2, codex: 3 } } })
    )
    render(<ProfileView onClose={() => {}} />)
    await openTab('Agents')
    const note = screen.getByRole('heading', { name: 'Roundtables' }).nextElementSibling
    expect(note?.textContent?.replace(/\s+/g, ' ')).toMatch(
      /^2 tables ran 5 seat sessions \(Claude 2 · Codex 3\)\. They are counted apart/
    )
  })

  it('shows no roundtables group when no table has run a seat', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)
    await openTab('Agents')
    expect(screen.queryByRole('heading', { name: 'Roundtables' })).toBeNull()
  })

  it('explains a zero-edit agent instead of showing a bare +0', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)
    await openTab('Agents')
    // an agent editing through shell commands has sessions but no countable lines
    const row = screen.getByRole('rowheader', { name: 'Lines edited' }).closest('tr')!
    const codex = row.querySelectorAll('td')[1]
    expect(codex.textContent).toBe('none measured')
    expect(codex.querySelector('.pv-untracked')?.getAttribute('title')).toMatch(/shell commands/)
    expect(row.textContent).not.toContain('+0')
  })

  it('renders model bars split by the agents that served each model', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await openTab('Agents')
    const rows = [...container.querySelectorAll('.pv-bars li')]
    expect(rows.map((li) => li.querySelector('.pv-bar-name')?.textContent)).toEqual([
      'claude-opus-5',
      'gpt-5.6-sol'
    ])
    // opus is served by two agents → its bar splits into two tinted segments
    expect(rows[0].querySelectorAll('.pv-bar-fill i').length).toBe(2)
    expect(rows[0].getAttribute('title')).toContain('Claude 22')
    expect(rows[0].getAttribute('title')).toContain('Copilot 8')
  })

  it('lists accounts with their signed-in identity or an honest gap', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    render(<ProfileView onClose={() => {}} />)
    await openTab('Agents')
    expect(screen.getByText('dev@example.com')).toBeTruthy()
    expect(screen.getByText('not signed in')).toBeTruthy()
  })

  it('shows the daily rhythm with its peak hour named, each hour split by agent', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(profile())
    const { container } = render(<ProfileView onClose={() => {}} />)
    await screen.findByText('octocat')
    expect(screen.getByRole('img', { name: /busiest around 14:00/i })).toBeTruthy()
    expect(screen.getByText(/Busiest around 14:00/)).toBeTruthy()
    const hours = container.querySelectorAll('.pv-hour')
    expect(hours).toHaveLength(24)
    // prompts, not session starts: when you were actually at it
    expect(hours[14].getAttribute('title')).toBe('14:00 — 7\u00a0prompts (Claude 5 · Codex 2)')
    expect(hours[14].querySelectorAll('.pv-hour-fill i')).toHaveLength(2)
    // an empty hour keeps its slot but paints nothing
    expect(hours[0].querySelector('.pv-hour-fill')).toBeNull()
  })

  it('splits languages and repos by agent, with counts that agree with their nouns', async () => {
    vi.mocked(window.cockpit.getProfile).mockResolvedValue(
      profile({ languages: [{ ext: 'tsx', files: 1, linesAdded: 1, byProvider: { codex: 1 } }] })
    )
    const { container } = render(<ProfileView onClose={() => {}} />)
    await openTab('Code')
    const lang = container.querySelector('.pv-bars li')!
    // "1 lines · 1 files" read as a bug
    expect(lang.querySelector('.pv-bar-n')?.textContent).toMatch(/^1\u00a0line · 1\u00a0file,/)
    const repo = [...container.querySelectorAll('.pv-bars li')].find((li) => li.textContent?.includes('alpha'))!
    expect(repo.querySelectorAll('.pv-bar-fill i')).toHaveLength(2)
    // the split in words for a screen reader, not only in color
    expect(repo.querySelector('.sr-only')?.textContent).toBe(', Claude 25 · Codex 5')
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
    render(<ProfileView onClose={() => {}} />)
    await openTab('Agents')
    expect(await screen.findByText('logs unreadable')).toBeTruthy()
    // the session count comes off the index, so it survives a failed deep parse
    const col = (label: string): string =>
      screen.getByRole('rowheader', { name: label }).closest('tr')!.querySelectorAll('td')[1].textContent ?? ''
    expect(col('Sessions')).toBe('12')
    // and a rate with nothing read under it is a gap, never a zero
    expect(col('Prompts per session')).toBe('—')
    expect(col('Lines edited')).not.toContain('+0')
  })

  it('reports an error instead of spinning forever', async () => {
    vi.mocked(window.cockpit.getProfile).mockRejectedValue(
      new Error("Error invoking remote method 'profile:get': Error: boom")
    )
    render(<ProfileView onClose={() => {}} />)
    // main's message, without the wrapper Electron puts around it
    expect(await screen.findByText("Couldn't build the profile — boom")).toBeTruthy()
  })
})
