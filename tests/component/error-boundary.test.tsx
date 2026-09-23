import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { JSX } from 'react'
import { ErrorBoundary } from '../../src/renderer/src/ErrorBoundary'
import { Markdown } from '../../src/renderer/src/Markdown'

/*
 * The renderer's last resort. Without it, a throw anywhere in the tree leaves an
 * Electron window showing a black rectangle with no reload button to press — and the
 * data this tree renders comes from three other vendors' log formats, which drift.
 */

function Boom({ when }: { when: boolean }): JSX.Element {
  if (when) throw new Error('parser fell over')
  return <p>all fine</p>
}

// React logs the caught error itself; that noise is expected here, not a failure
const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
afterEach(() => quiet.mockClear())

describe('ErrorBoundary', () => {
  it('renders its children untouched while nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom when={false} />
      </ErrorBoundary>
    )
    expect(screen.getByText('all fine')).toBeInTheDocument()
  })

  it('keeps the window when a child throws, and says what happened', () => {
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('parser fell over')).toBeInTheDocument()
  })

  it('offers the two things a person can actually do about it', () => {
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>
    )
    expect(screen.getByRole('button', { name: 'Reload the window' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument()
  })

  it('writes the failure to the console, the only place a lost tree can report from', () => {
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>
    )
    expect(quiet.mock.calls.some((c) => String(c[0]).includes('[renderer] crashed:'))).toBe(true)
  })
})

describe('ErrorBoundary with a fallback — one part of the window, not all of it', () => {
  it('draws the fallback in the failed part’s place, and tries again when its key changes', () => {
    const { rerender } = render(
      <ErrorBoundary fallback={<p>plain text instead</p>} resetKey="a">
        <Boom when />
      </ErrorBoundary>
    )
    expect(screen.getByText('plain text instead')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(
      <ErrorBoundary fallback={<p>plain text instead</p>} resetKey="b">
        <Boom when={false} />
      </ErrorBoundary>
    )
    expect(screen.getByText('all fine')).toBeInTheDocument()
  })
})

describe('Markdown', () => {
  it('shows a reply the pipeline cannot draw as its own text, and keeps the window', async () => {
    // three thousand nested quotes overflow the stack inside the markdown pipeline;
    // before, that throw reached the root and replaced the whole window
    const nested = '>'.repeat(3000) + ' deep'
    // the pipeline is a lazy chunk, and its loading fallback is the same plain text —
    // wait until it draws, so what follows is its failure and not its loading
    const warm = render(<Markdown text="**loaded**" />)
    await waitFor(() => expect(document.querySelector('strong')).not.toBeNull())
    warm.unmount()
    render(
      <ErrorBoundary>
        <p>the rest of the window</p>
        <div className="markdown">
          <Markdown text={nested} />
        </div>
      </ErrorBoundary>
    )
    expect(screen.getByText('the rest of the window')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.querySelector('.md-plain')?.textContent).toBe(nested)
  })

  it('renders a reply past the size cap as plain text, without the pipeline', () => {
    const long = '| a | b |\n|---|---|\n' + '| x | y |\n'.repeat(8000)
    render(<Markdown text={long} />)
    expect(document.querySelector('.md-plain')?.textContent).toBe(long)
    expect(document.querySelector('table')).toBeNull()
  })
})
