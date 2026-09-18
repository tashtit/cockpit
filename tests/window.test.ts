import { describe, expect, it } from 'vitest'
import { clampZoom, WINDOW_FLOOR, ZOOM_MAX, ZOOM_MIN, zoomedFloor } from '../src/shared/window'

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
