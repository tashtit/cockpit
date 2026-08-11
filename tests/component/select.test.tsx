import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fireEvent } from '@testing-library/dom'
import { Select } from '../../src/renderer/src/Select'

const options = Array.from({ length: 30 }, (_, i) => ({
  value: `r${i}`,
  label: `repo-${i}`
}))

function renderSelect() {
  const onChange = vi.fn()
  render(<Select value="r0" options={options} onChange={onChange} ariaLabel="Repository" />)
  return onChange
}

describe('Select', () => {
  it('stays open while scrolling inside its own list', async () => {
    const user = userEvent.setup()
    renderSelect()
    await user.click(screen.getByRole('button', { name: 'Repository' }))

    const list = screen.getByRole('listbox', { name: 'Repository' })
    fireEvent.scroll(list)

    expect(screen.queryByRole('listbox', { name: 'Repository' })).not.toBeNull()
  })

  it('closes when an ancestor scrolls', async () => {
    const user = userEvent.setup()
    renderSelect()
    await user.click(screen.getByRole('button', { name: 'Repository' }))
    expect(screen.queryByRole('listbox', { name: 'Repository' })).not.toBeNull()

    fireEvent.scroll(document)

    expect(screen.queryByRole('listbox', { name: 'Repository' })).toBeNull()
  })
})
