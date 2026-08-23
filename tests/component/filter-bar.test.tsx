import { describe, expect, it, vi } from 'vitest'
import type { JSX } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  FilterBar,
  anyActive,
  groupActiveCount,
  matchesFilters,
  summarizeGroup,
  type FilterGroup
} from '../../src/renderer/src/FilterBar'

function group(over: Partial<FilterGroup> = {}): FilterGroup {
  return {
    id: 'project',
    label: 'Project',
    options: [
      { value: 'web', label: 'web' },
      { value: 'api', label: 'api' },
      { value: 'docs', label: 'docs' }
    ],
    included: [],
    excluded: [],
    onChange: vi.fn(),
    ...over
  }
}

describe('summarizeGroup', () => {
  it('reads "Any" when nothing is chosen', () => {
    expect(summarizeGroup(group())).toBe('Any')
  })

  it('names a single selection outright — worth more than a count', () => {
    expect(summarizeGroup(group({ included: ['web'] }))).toBe('web')
  })

  it('reads a single exclusion as "not x"', () => {
    expect(summarizeGroup(group({ excluded: ['docs'] }))).toBe('not docs')
  })

  it('counts once there is more than one', () => {
    expect(summarizeGroup(group({ included: ['web', 'api'] }))).toBe('2 selected')
    expect(summarizeGroup(group({ excluded: ['web', 'api'] }))).toBe('2 excluded')
  })

  it('reports both sides when they are mixed', () => {
    expect(summarizeGroup(group({ included: ['web', 'api'], excluded: ['docs'] }))).toBe(
      '2 selected, 1 excluded'
    )
  })

  it('falls back to the raw value when an option has since disappeared', () => {
    expect(summarizeGroup(group({ included: ['gone'] }))).toBe('gone')
  })
})

describe('groupActiveCount / anyActive', () => {
  it('counts both sides', () => {
    expect(groupActiveCount(group({ included: ['web'], excluded: ['docs'] }))).toBe(2)
  })

  it('sees an active dimension anywhere in the bar', () => {
    expect(anyActive([group(), group({ id: 'b', included: ['web'] })])).toBe(true)
    expect(anyActive([group(), group({ id: 'b' })])).toBe(false)
  })
})

describe('matchesFilters', () => {
  const groups = [
    group({ id: 'project', included: ['web', 'api'] }),
    group({ id: 'agent', included: ['claude'] })
  ]

  it('ORs within a dimension and ANDs across them', () => {
    expect(matchesFilters(groups, (id) => (id === 'project' ? ['api'] : ['claude']))).toBe(true)
    // right project, wrong agent
    expect(matchesFilters(groups, (id) => (id === 'project' ? ['api'] : ['codex']))).toBe(false)
    // right agent, wrong project
    expect(matchesFilters(groups, (id) => (id === 'project' ? ['docs'] : ['claude']))).toBe(false)
  })

  it('treats an empty dimension as no constraint, never as match-nothing', () => {
    expect(matchesFilters([group()], () => [])).toBe(true)
  })

  it('rejects a row carrying any excluded value', () => {
    const g = [group({ excluded: ['docs'] })]
    expect(matchesFilters(g, () => ['docs'])).toBe(false)
    expect(matchesFilters(g, () => ['web'])).toBe(true)
  })

  it('handles a dimension a row carries several values for', () => {
    const g = [group({ id: 'state', included: ['unpushed'] })]
    expect(matchesFilters(g, () => ['removable', 'unpushed'])).toBe(true)
  })
})

/** A bar wired to real state, so the pills drive something observable. */
function Harness({ onChange }: { onChange: (inc: string[], exc: string[]) => void }): JSX.Element {
  return (
    <FilterBar
      groups={[
        group({ onChange: (inc, exc) => onChange([...inc], [...exc]) }),
        group({ id: 'agent', label: 'Agent', options: [{ value: 'claude', label: 'Claude' }] })
      ]}
      defaultPinned={['project']}
    />
  )
}

describe('FilterBar', () => {
  it('shows pinned dimensions and hides the rest behind Add filter', async () => {
    render(<Harness onChange={() => {}} />)
    expect(screen.getByRole('button', { name: /^Project Any/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Agent/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeInTheDocument()
  })

  it('includes a value from the pill popover', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /^Project Any/ }))
    await user.click(screen.getByRole('button', { name: 'web' }))
    expect(onChange).toHaveBeenCalledWith(['web'], [])
  })

  it('excludes a value through the option’s own control', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /^Project Any/ }))
    await user.click(screen.getByRole('button', { name: 'Exclude docs' }))
    expect(onChange).toHaveBeenCalledWith([], ['docs'])
  })

  it('include and exclude are mutually exclusive for one value', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <FilterBar
        groups={[group({ included: ['web'], onChange: (i, e) => onChange([...i], [...e]) })]}
        defaultPinned={['project']}
      />
    )
    await user.click(screen.getByRole('button', { name: /^Project web/ }))
    await user.click(screen.getByRole('button', { name: 'Exclude web' }))
    expect(onChange).toHaveBeenCalledWith([], ['web'])
  })

  it('a dimension carrying a value stays on the bar even when unpinned', () => {
    render(
      <FilterBar
        groups={[group(), group({ id: 'agent', label: 'Agent', included: ['claude'] })]}
        defaultPinned={['project']}
      />
    )
    // unpinned, but it is shaping the list — hiding it would misrepresent the view
    expect(screen.getByRole('button', { name: /^Agent claude/ })).toBeInTheDocument()
  })

  it('offers Clear all only once something is active', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<Harness onChange={onChange} />)
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument()
    rerender(
      <FilterBar
        groups={[group({ included: ['web'], onChange: (i, e) => onChange([...i], [...e]) })]}
        defaultPinned={['project']}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onChange).toHaveBeenCalledWith([], [])
  })

  it('searches inside a long option list', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 12 }, (_, i) => ({ value: `p${i}`, label: `project-${i}` }))
    render(<FilterBar groups={[group({ options: many })]} defaultPinned={['project']} />)
    await user.click(screen.getByRole('button', { name: /^Project Any/ }))
    await user.type(screen.getByLabelText('Filter project options'), 'project-11')
    expect(screen.getByRole('button', { name: 'project-11' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'project-2' })).not.toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    render(<Harness onChange={() => {}} />)
    const pill = screen.getByRole('button', { name: /^Project Any/ })
    await user.click(pill)
    expect(screen.getByRole('dialog', { name: 'Project filter' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(pill).toHaveFocus()
  })

  it('pins a dimension from the Add filter menu', async () => {
    const user = userEvent.setup()
    render(<Harness onChange={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    await user.click(screen.getByRole('switch', { name: /Agent/ }))
    expect(screen.getByRole('button', { name: /^Agent Any/ })).toBeInTheDocument()
  })

  it('disables a dimension with nothing to offer', async () => {
    const user = userEvent.setup()
    render(
      <FilterBar
        groups={[group(), group({ id: 'empty', label: 'Empty', options: [] })]}
        defaultPinned={['project']}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Add filter' }))
    expect(screen.getByRole('switch', { name: /Empty/ })).toBeDisabled()
  })
})
