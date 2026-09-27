import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SidePanel } from '../../src/renderer/src/SidePanel'
import { panelBounds } from '../../src/renderer/src/panel'

const KEY = 'cockpit:panel-width'

// jsdom has no layout and no pointer capture. The deck is 1200 wide, so the panel may
// take 300–780 (the conversation keeps 420); the panel measures what the store says —
// what the stylesheet's clamp would make it — or 380 before anything was stored; and
// capture is a no-op, the events reach the sash by being fired at it.
const rect = (width: number): DOMRect =>
  ({ x: 0, y: 0, top: 0, left: 0, width, height: 700, right: width, bottom: 700, toJSON: () => ({}) }) as DOMRect
vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
  if (this.classList.contains('chat-deck')) return rect(1200)
  return rect(Number(window.localStorage.getItem(KEY)) || 380)
})
HTMLElement.prototype.setPointerCapture ??= () => {}
HTMLElement.prototype.releasePointerCapture ??= () => {}

const sash = (): HTMLElement => screen.getByRole('separator', { name: 'Work panel width' })
const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Work' })
const stored = (): string | null => window.localStorage.getItem(KEY)

function renderPanel(onClose = vi.fn()): void {
  render(
    <div className="chat-deck">
      <div className="chat-main" />
      <SidePanel id="work-panel" label="Work" onClose={onClose}>
        <p>the plan</p>
      </SidePanel>
    </div>
  )
}

describe('the side panel’s bounds', () => {
  it('never under 300, and always leaving the conversation 420 of the deck', () => {
    expect(panelBounds(1200)).toEqual({ min: 300, max: 780 })
    expect(panelBounds(720)).toEqual({ min: 300, max: 300 })
    // under 720 the panel covers the conversation and has no edge to drag; the bounds still hold
    expect(panelBounds(500)).toEqual({ min: 300, max: 300 })
  })
})

describe('the sash on the side panel', () => {
  it("is a vertical separator on the panel's left edge, valued at its width, bounded by what the conversation can spare", () => {
    renderPanel()
    expect(panel().firstElementChild).toBe(sash())
    expect(sash()).toHaveAttribute('aria-orientation', 'vertical')
    expect(sash()).toHaveAttribute('aria-controls', 'work-panel')
    expect(sash()).toHaveAttribute('aria-valuenow', '380')
    expect(sash()).toHaveAttribute('aria-valuemin', '300')
    expect(sash()).toHaveAttribute('aria-valuemax', '780')
    expect(stored()).toBeNull()
    expect(panel().style.getPropertyValue('--panel')).toBe('')
  })

  it('widens leftward a step per arrow key, four with shift, reaches the bounds on Home and End — and is remembered', async () => {
    const user = userEvent.setup()
    renderPanel()
    sash().focus()
    // the sash is the panel's left edge: moving it left widens the panel
    await user.keyboard('{ArrowLeft}')
    expect(stored()).toBe('396')
    expect(sash()).toHaveAttribute('aria-valuenow', '396')
    expect(panel().style.getPropertyValue('--panel')).toBe('396px')
    await user.keyboard('{ArrowRight}{ArrowRight}')
    expect(stored()).toBe('364')
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(stored()).toBe('428')
    await user.keyboard('{Home}')
    expect(stored()).toBe('300')
    await user.keyboard('{End}')
    expect(stored()).toBe('780')
    expect(sash()).toHaveAttribute('aria-valuenow', '780')
    expect(panel().style.getPropertyValue('--panel')).toBe('780px')
  })

  it('follows the pointer while dragged, moving the panel itself, and remembers where it was let go', () => {
    renderPanel()
    fireEvent.pointerDown(sash(), { button: 0, pointerId: 1, clientX: 800 })
    expect(document.body).toHaveClass('sash-dragging')
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 700 })
    expect(sash()).toHaveAttribute('aria-valuenow', '480')
    expect(panel().style.getPropertyValue('--panel')).toBe('480px')
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 0 })
    expect(sash()).toHaveAttribute('aria-valuenow', '780')
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 1200 })
    expect(sash()).toHaveAttribute('aria-valuenow', '300')
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 760 })
    expect(panel().style.getPropertyValue('--panel')).toBe('420px')
    // nothing is written while the drag runs — only where it ends
    expect(stored()).toBeNull()
    fireEvent.pointerUp(sash(), { pointerId: 1 })
    expect(document.body).not.toHaveClass('sash-dragging')
    expect(stored()).toBe('420')
    expect(panel().style.getPropertyValue('--panel')).toBe('420px')
    // a released pointer moves nothing
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 400 })
    expect(stored()).toBe('420')
  })

  it('hands the width back to the stylesheet on a double-click', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(KEY, '600')
    renderPanel()
    expect(panel().style.getPropertyValue('--panel')).toBe('600px')
    expect(sash()).toHaveAttribute('aria-valuenow', '600')
    await user.dblClick(sash())
    expect(stored()).toBeNull()
    expect(panel().style.getPropertyValue('--panel')).toBe('')
    expect(sash()).toHaveAttribute('aria-valuenow', '380')
  })

  it('closes on Escape from anywhere inside, the sash included', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderPanel(onClose)
    sash().focus()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
