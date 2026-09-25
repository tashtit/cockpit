import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { MarkdownPipeline } from '../../src/renderer/src/MarkdownPipeline'

// counted, not changed: the highlighter's attacher builds a lowlight (every grammar)
// each time it runs, and remark-gfm's runs once per document the pipeline parses
vi.mock('rehype-highlight', async (importOriginal) => {
  const real = await importOriginal<typeof import('rehype-highlight')>()
  return { default: vi.fn(real.default) }
})
vi.mock('remark-gfm', async (importOriginal) => {
  const real = await importOriginal<typeof import('remark-gfm')>()
  return { default: vi.fn(real.default) }
})

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

describe('the pipeline’s own cost', () => {
  it('highlights every reply with the one highlighter built when the pipeline loaded', () => {
    render(<MarkdownPipeline text={'```ts\nconst one = 1\n```'} />)
    render(<MarkdownPipeline text={'```ts\nconst two = 2\n```'} />)
    render(<MarkdownPipeline text={'```js\nlet three = 3\n```'} />)
    expect(document.querySelectorAll('.hljs-keyword').length).toBeGreaterThanOrEqual(3)
    expect(rehypeHighlight).not.toHaveBeenCalled()
  })

  it('draws a reply it drew lately without parsing it again', () => {
    const text = 'a reply that is **drawn** twice, from a transcript opened twice'
    const first = render(<MarkdownPipeline text={text} />)
    const parsed = vi.mocked(remarkGfm).mock.calls.length
    first.unmount()
    render(<MarkdownPipeline text={text} />)
    expect(screen.getByText('drawn').tagName).toBe('STRONG')
    expect(vi.mocked(remarkGfm).mock.calls.length).toBe(parsed)
    render(<MarkdownPipeline text="something it has not drawn" />)
    expect(vi.mocked(remarkGfm).mock.calls.length).toBe(parsed + 1)
  })
})
