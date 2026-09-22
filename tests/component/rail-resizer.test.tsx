import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import { RailResizer } from '../../src/renderer/src/RailResizer'

const KEY = 'cockpit:rail-width'

// jsdom has no layout and no pointer capture. The rail measures what the store says —
// what the stylesheet's clamp would make it — or 260 before anything was stored; and
// capture is a no-op, the events reach the sash by being fired at it.
const rect = (width: number): DOMRect =>
  ({ x: 0, y: 0, top: 0, left: 0, width, height: 700, right: width, bottom: 700, toJSON: () => ({}) }) as DOMRect
vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
  rect(Number(window.localStorage.getItem(KEY)) || 260)
)
HTMLElement.prototype.setPointerCapture ??= () => {}
HTMLElement.prototype.releasePointerCapture ??= () => {}

const sash = (): HTMLElement => screen.getByRole('separator', { name: 'Sidebar width' })
const stored = (): string | null => window.localStorage.getItem(KEY)

describe('the sash on the rail', () => {
  it("is a vertical separator valued at the rail's width, bounded by what the deck can spare", () => {
    render(
      <aside>
        <RailResizer />
      </aside>
    )
    expect(sash()).toHaveAttribute('aria-orientation', 'vertical')
    expect(sash()).toHaveAttribute('aria-valuenow', '260')
    expect(sash()).toHaveAttribute('aria-valuemin', '200')
    // jsdom's window is 1024 wide: 664 would leave the deck its 360, so the ceiling holds at 600
    expect(sash()).toHaveAttribute('aria-valuemax', '600')
    expect(stored()).toBeNull()
  })

  it('moves a step per arrow key, four with shift, to the bounds on Home and End — and is remembered', async () => {
    const user = userEvent.setup()
    render(
      <aside>
        <RailResizer />
      </aside>
    )
    sash().focus()
    await user.keyboard('{ArrowRight}')
    expect(stored()).toBe('276')
    expect(sash()).toHaveAttribute('aria-valuenow', '276')
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(stored()).toBe('244')
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(stored()).toBe('308')
    await user.keyboard('{Home}')
    expect(stored()).toBe('200')
    await user.keyboard('{End}')
    expect(stored()).toBe('600')
    expect(sash()).toHaveAttribute('aria-valuenow', '600')
  })

  it('follows the pointer while dragged and holds at the bounds', () => {
    render(
      <aside>
        <RailResizer />
      </aside>
    )
    fireEvent.pointerDown(sash(), { button: 0, pointerId: 1, clientX: 260 })
    expect(document.body).toHaveClass('rail-dragging')
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 340 })
    expect(stored()).toBe('340')
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 1000 })
    expect(stored()).toBe('600')
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 40 })
    expect(stored()).toBe('200')
    fireEvent.pointerUp(sash(), { pointerId: 1 })
    expect(document.body).not.toHaveClass('rail-dragging')
    // a released pointer moves nothing
    fireEvent.pointerMove(sash(), { pointerId: 1, clientX: 400 })
    expect(stored()).toBe('200')
  })

  it('a stored width lands on the grid as --rail, and a double-click hands it back to the stylesheet', async () => {
    const user = userEvent.setup()
    render(<App />)
    const s = await screen.findByRole('separator', { name: 'Sidebar width' })
    const app = document.querySelector<HTMLElement>('.app')!
    expect(app.style.getPropertyValue('--rail')).toBe('')
    s.focus()
    await user.keyboard('{End}')
    expect(app.style.getPropertyValue('--rail')).toBe('600px')
    await user.dblClick(s)
    expect(app.style.getPropertyValue('--rail')).toBe('')
    expect(stored()).toBeNull()
  })
})
