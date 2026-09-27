import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ProviderLogo } from '../../src/renderer/src/logos'
import { SESSION_PROVIDERS } from '../../src/shared/providers'

/** Every `url(#…)` a mark's parts point at, and whether each one is defined inside that mark. */
function references(svg: SVGSVGElement): Array<{ readonly id: string; readonly found: boolean }> {
  const out: Array<{ id: string; found: boolean }> = []
  for (const el of svg.querySelectorAll('*')) {
    for (const attr of ['fill', 'mask', 'filter']) {
      const m = /^url\(#(.+)\)$/.exec(el.getAttribute(attr) ?? '')
      if (m) out.push({ id: m[1], found: svg.querySelector(`[id="${m[1]}"]`) !== null })
    }
  }
  return out
}

describe('agent marks', () => {
  it('draws every agent’s mark, and points only at what it defines itself', () => {
    for (const p of SESSION_PROVIDERS) {
      const { container, unmount } = render(<ProviderLogo p={p} />)
      const svg = container.querySelector('svg')!
      expect(svg, p).not.toBeNull()
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      for (const ref of references(svg)) expect(ref.found, `${p} → #${ref.id}`).toBe(true)
      unmount()
    }
  })

  // a gradient or mask shared by id would draw from whichever copy came first, and a copy
  // inside a hidden panel draws nothing at all
  it('gives two copies of a coloured mark ids of their own', () => {
    const { container } = render(
      <>
        <ProviderLogo p="gemini" />
        <ProviderLogo p="gemini" />
        <ProviderLogo p="antigravity" />
        <ProviderLogo p="antigravity" />
      </>
    )
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('draws the brands that have colours in them, from the palette tokens', () => {
    const marks = (p: 'gemini' | 'antigravity' | 'cursor' | 'opencode'): string[] => {
      const { container, unmount } = render(<ProviderLogo p={p} />)
      const found = [...container.querySelectorAll('[class*="mark-"]')].map((el) => el.getAttribute('class')!)
      unmount()
      return found
    }
    expect(marks('gemini')).toEqual(
      expect.arrayContaining(['mark-google-blue', 'mark-stop-google-green', 'mark-stop-google-red'])
    )
    expect(marks('antigravity')).toEqual(expect.arrayContaining(['mark-google-blue', 'mark-google-red']))
    expect(marks('cursor')).toEqual(expect.arrayContaining(['mark-cursor-shade-1', 'mark-cursor-edge']))
    expect(marks('opencode')).toEqual(['mark-opencode-frame', 'mark-opencode-core'])
  })

  it('draws in one colour on a solid fill, for every agent', () => {
    for (const p of SESSION_PROVIDERS) {
      const { container, unmount } = render(<ProviderLogo p={p} mono />)
      expect(container.querySelector('[class*="mark-"]'), p).toBeNull()
      expect(container.querySelector('defs, mask, filter'), p).toBeNull()
      for (const path of container.querySelectorAll('path')) expect(path.getAttribute('fill'), p).toBe('currentColor')
      unmount()
    }
  })
})
