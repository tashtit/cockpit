import { describe, expect, it } from 'vitest'
import {
  clampZoom,
  restoredBounds,
  WINDOW_FLOOR,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomedFloor,
  type WindowPlacement
} from '../src/shared/window'

// A 27" display: big enough that nothing here is clamped by the screen.
const ROOM = { width: 2560, height: 1440 }

describe('clampZoom', () => {
  it('keeps a level the user can reach', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(1.25)).toBe(1.25)
  })

  it('holds the ends — 200% is WCAG 1.4.4, below 70% the chrome stops being legible', () => {
    expect(clampZoom(4)).toBe(ZOOM_MAX)
    expect(clampZoom(0.1)).toBe(ZOOM_MIN)
  })

  it('answers 100% for a number that is not one', () => {
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('zoomedFloor', () => {
  it('is the floor itself at 100%', () => {
    expect(zoomedFloor(1, ROOM)).toEqual({ width: 560, height: 420 })
  })

  it('grows with the zoom, so the layout keeps its floor in CSS pixels', () => {
    // the bug this exists for: a 560pt window at 150% lays out 373 CSS px wide
    expect(zoomedFloor(1.5, ROOM)).toEqual({ width: 840, height: 630 })
    expect(zoomedFloor(ZOOM_MAX, ROOM)).toEqual({ width: 1120, height: 840 })
    for (const z of [1.1, 1.25, 1.5, 1.75, 2]) {
      const min = zoomedFloor(z, ROOM)
      expect(min.width / z).toBeGreaterThanOrEqual(WINDOW_FLOOR.width - 1)
      expect(min.height / z).toBeGreaterThanOrEqual(WINDOW_FLOOR.height - 1)
    }
  })

  it('does not shrink below 100% — zooming out only ever hands the layout more pixels', () => {
    expect(zoomedFloor(ZOOM_MIN, ROOM)).toEqual({ width: 560, height: 420 })
  })

  it('never asks for a window the display cannot hold', () => {
    // a 1280x800 laptop at 200%: the width fits, the height does not, and a minimum
    // taller than the work area is a window nobody can move
    expect(zoomedFloor(2, { width: 1280, height: 760 })).toEqual({ width: 1120, height: 760 })
    expect(zoomedFloor(2, { width: 800, height: 600 })).toEqual({ width: 800, height: 600 })
  })

  it('stays a usable size against a nonsense work area', () => {
    expect(zoomedFloor(1, { width: 0, height: 0 })).toEqual({ width: 1, height: 1 })
  })
})

describe('restoredBounds', () => {
  // a laptop with an external display to its left, the way the OS lays them out
  const LAPTOP = { x: 0, y: 25, width: 1512, height: 920 }
  const EXTERNAL = { x: -2560, y: 0, width: 2560, height: 1415 }
  const saved = (over: Partial<WindowPlacement> = {}): WindowPlacement => ({
    x: 120,
    y: 80,
    width: 1100,
    height: 760,
    fullScreen: false,
    ...over
  })

  it('opens where it was', () => {
    expect(restoredBounds(saved(), [LAPTOP])).toEqual({ x: 120, y: 80, width: 1100, height: 760 })
  })

  it('keeps the screen it was on, not the one the OS would pick', () => {
    const onExternal = saved({ x: -2000, y: 200, width: 1600, height: 1000 })
    expect(restoredBounds(onExternal, [LAPTOP, EXTERNAL])).toEqual({
      x: -2000,
      y: 200,
      width: 1600,
      height: 1000
    })
    // unplug that display and the same placement is unreachable
    expect(restoredBounds(onExternal, [LAPTOP])).toBeNull()
  })

  it('falls back when the window would no longer fit the screen it lands on', () => {
    expect(restoredBounds(saved({ width: 2400, height: 1400 }), [LAPTOP])).toBeNull()
  })

  it('refuses a placement with nothing left to grab', () => {
    // dragged nearly off the right edge, then reopened: 132px of window is enough
    // to grab and drag back, 62px is a window the user would have to go hunting for
    expect(restoredBounds(saved({ x: 1380 }), [LAPTOP])).toEqual(
      { x: 1380, y: 80, width: 1100, height: 760 }
    )
    expect(restoredBounds(saved({ x: 1450 }), [LAPTOP])).toBeNull()
    expect(restoredBounds(saved({ y: -800 }), [LAPTOP])).toBeNull()
  })

  it('refuses anything that is not a placement, and the first launch that has none', () => {
    expect(restoredBounds(undefined, [LAPTOP])).toBeNull()
    expect(restoredBounds(saved({ x: Number.NaN }), [LAPTOP])).toBeNull()
    expect(restoredBounds({ ...saved(), width: 'wide' as unknown as number }, [LAPTOP])).toBeNull()
    // below the supported floor: a hand-edited config must not open an unusable window
    expect(restoredBounds(saved({ width: WINDOW_FLOOR.width - 1 }), [LAPTOP])).toBeNull()
  })

  it('says nothing about full screen — that is restored as a flag, not as bounds', () => {
    expect(restoredBounds(saved({ fullScreen: true }), [LAPTOP])).toEqual({
      x: 120,
      y: 80,
      width: 1100,
      height: 760
    })
  })
})
