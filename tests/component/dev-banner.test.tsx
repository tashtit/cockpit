import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DevBanner } from '../../src/renderer/src/DevBanner'

describe('DevBanner', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('shows the source branch when the dev URL carries devBranch', () => {
    window.history.replaceState({}, '', '/?devBranch=titan%2Ffix-thing')
    render(<DevBanner />)

    const banner = screen.getByTitle('dev build running from branch titan/fix-thing')
    expect(banner).toHaveTextContent('titan/fix-thing')
  })

  it('renders nothing without the param (packaged app never carries it)', () => {
    const { container } = render(<DevBanner />)
    expect(container).toBeEmptyDOMElement()
  })
})
