import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MarkdownPipeline } from '../../src/renderer/src/MarkdownPipeline'

/*
 * Links in a transcript. The window is not allowed to navigate — main's
 * `will-navigate` prevents every one, because this renderer holds `window.cockpit`
 * and can spawn CLIs — so an anchor that is left to the browser is a control that
 * looks live and does nothing. Agents emit URLs constantly (a PR, a doc, a source
 * line), which makes this the most-clicked dead control the app could ship.
 */

beforeEach(() => {
  vi.mocked(window.cockpit.openExternal).mockClear()
})

describe('a link in rendered markdown', () => {
  it('opens in the real browser instead of navigating the window', () => {
    render(<MarkdownPipeline text="see [the PR](https://github.com/o/r/pull/1) for context" />)
    const link = screen.getByRole('link', { name: 'the PR' })
    const click = fireEvent.click(link)
    // the default is prevented, so nothing asks the window to go anywhere
    expect(click).toBe(false)
    expect(window.cockpit.openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/1')
  })

  it('carries the destination in its tooltip, since the status bar of a browser is absent', () => {
    render(<MarkdownPipeline text="[docs](https://example.com/a)" />)
    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'title',
      'https://example.com/a'
    )
  })

  it('leaves a bare autolink clickable too', () => {
    render(<MarkdownPipeline text="https://example.com/raw" />)
    fireEvent.click(screen.getByRole('link', { name: 'https://example.com/raw' }))
    expect(window.cockpit.openExternal).toHaveBeenCalledWith('https://example.com/raw')
  })

  it('renders what main would refuse as text, not as a link nothing happens on', () => {
    // main only opens http(s); anything else would be a focusable control that
    // swallows its own click
    render(<MarkdownPipeline text="[a file](./src/main.ts) and [mail](mailto:a@b.c)" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(/a file/)).toBeInTheDocument()
    expect(screen.getByText(/mail/)).toBeInTheDocument()
  })

  it('still renders a code block with its copy button', () => {
    render(<MarkdownPipeline text={'```js\nconst a = 1\n```'} />)
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  })
})
