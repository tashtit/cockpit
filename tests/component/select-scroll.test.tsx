import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select } from '../../src/renderer/src/Select'

// jsdom has no scrollIntoView; Select's open-popup effect calls it
window.HTMLElement.prototype.scrollIntoView = vi.fn()

const options = Array.from({ length: 30 }, (_, i) => ({ value: `m${i}`, label: `model-${i}` }))

/**
 * The trigger names itself label-then-value ("Model model-0") so a screen reader
 * announces what the control is *and* what it currently holds. Match the label
 * prefix rather than the whole name — the selected value is not what these tests
 * are about, and pinning it would break again the moment a fixture changes.
 */
const trigger = (): HTMLElement => screen.getByRole('button', { name: /^Model\b/ })

describe('Select popup scrolling', () => {
  it('stays open while the listbox scrolls its own overflow', async () => {
    render(<Select ariaLabel="Model" value="m0" options={options} onChange={vi.fn()} />)
    await userEvent.click(trigger())
    const list = screen.getByRole('listbox')
    act(() => {
      list.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('closes when the page scrolls outside the listbox', async () => {
    render(<Select ariaLabel="Model" value="m0" options={options} onChange={vi.fn()} />)
    await userEvent.click(trigger())
    act(() => {
      document.body.dispatchEvent(new Event('scroll'))
    })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})
