import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { ErrorBoundary } from '../../src/renderer/src/ErrorBoundary'

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
