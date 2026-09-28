import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { LiveDot, ProviderLogo } from '../../src/renderer/src/logos'
import { SESSION_PROVIDERS } from '../../src/shared/providers'
import type { SessionProvider } from '../../src/shared/types'

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

/** The rules of style.css, parsed by jsdom — which matches `:is()` and `:has()` too. */
function styleRules(): CSSStyleRule[] {
  const style = document.createElement('style')
  style.textContent = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'style.css'), 'utf8')
  document.head.appendChild(style)
  const rules = [...(style.sheet?.cssRules ?? [])].filter((r): r is CSSStyleRule => r instanceof CSSStyleRule)
  style.remove()
  return rules
}

/** What `el` gets for `prop` from rules naming an agent — the livery, not the rule every agent shares. */
function livery(rules: readonly CSSStyleRule[], el: Element, prop: string): string[] {
  const agents = new RegExp(`-(${SESSION_PROVIDERS.join('|')})\\b`)
  return rules
    .filter((r) => agents.test(r.selectorText) && r.style.getPropertyValue(prop) !== '' && el.matches(r.selectorText))
    .map((r) => r.style.getPropertyValue(prop))
}

function element(html: string): Element {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host.firstElementChild!
}

describe('every agent’s livery', () => {
  const rules = styleRules()
  const token = (p: SessionProvider): string => (p === 'claude' || p === 'codex' || p === 'copilot' || p === 'gemini' ? p : 'mono-mark')

  it('lights its live dot, and the board row it flies or lands in', () => {
    for (const p of SESSION_PROVIDERS) {
      const { container, unmount } = render(<LiveDot p={p} />)
      const dot = container.querySelector('.pulse')!
      expect(livery(rules, dot, 'background'), p).toEqual([`var(--${token(p)})`])
      unmount()

      const flying = element(
        `<div class="board-row flying"><span class="board-agent board-agent-${p}"></span><span class="pulse pulse-${p}"></span></div>`
      )
      expect(livery(rules, flying, 'background').join(), p).toContain(`var(--${token(p)}-rgb)`)
      expect(livery(rules, flying.querySelector('.board-agent')!, 'color'), p).toEqual([`var(--${token(p)})`])
      for (const state of ['landed', 'asks']) {
        const row = element(`<div class="board-row ${state}"><span class="plogo plogo-${p}"></span></div>`)
        expect(livery(rules, row, 'box-shadow'), `${p} ${state}`).toEqual([`inset 2px 0 0 var(--${token(p)})`])
      }
      document.body.innerHTML = ''
    }
  })

  it('marks it chosen in the home composer and the new-session form, not by opacity alone', () => {
    for (const p of SESSION_PROVIDERS) {
      const chip = element(`<button class="composer-agent plogo-${p} active"></button>`)
      expect(livery(rules, chip, 'box-shadow').join(), p).toContain(`var(--${token(p)})`)
      const card = element(`<button class="ns-provider ns-${p} active"></button>`)
      expect(livery(rules, card, 'border-color'), p).toEqual([`var(--${token(p)})`])
      document.body.innerHTML = ''
    }
  })
})
