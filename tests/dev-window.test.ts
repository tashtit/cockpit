import { describe, expect, it } from 'vitest'
import { centeredIn, readDevWindowPrefs } from '../src/main/dev-window'

describe('readDevWindowPrefs', () => {
  it('defaults to foreground on the OS-chosen display', () => {
    expect(readDevWindowPrefs({})).toEqual({ background: false, displayIndex: null })
  })

  it('treats any non-empty COCKPIT_DEV_BACKGROUND except "0" as on', () => {
    expect(readDevWindowPrefs({ COCKPIT_DEV_BACKGROUND: '1' }).background).toBe(true)
    expect(readDevWindowPrefs({ COCKPIT_DEV_BACKGROUND: 'true' }).background).toBe(true)
    expect(readDevWindowPrefs({ COCKPIT_DEV_BACKGROUND: '0' }).background).toBe(false)
    expect(readDevWindowPrefs({ COCKPIT_DEV_BACKGROUND: '' }).background).toBe(false)
  })

  it('parses COCKPIT_DEV_DISPLAY as a 0-based index', () => {
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: '0' }).displayIndex).toBe(0)
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: '2' }).displayIndex).toBe(2)
  })

  it('ignores a non-numeric or empty COCKPIT_DEV_DISPLAY', () => {
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: 'left' }).displayIndex).toBeNull()
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: '-1' }).displayIndex).toBeNull()
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: '' }).displayIndex).toBeNull()
  })
})

describe('centeredIn', () => {
  it('centers the window in the display work area', () => {
    const bounds = centeredIn({ x: 0, y: 25, width: 1920, height: 1055 }, 1100, 760)
    expect(bounds).toEqual({ x: 410, y: 173, width: 1100, height: 760 })
  })

  it('offsets by the display origin (secondary displays have non-zero origins)', () => {
    const bounds = centeredIn({ x: 1920, y: 0, width: 1920, height: 1080 }, 1100, 760)
    expect(bounds.x).toBe(1920 + 410)
    expect(bounds.y).toBe(160)
  })

  it('clamps the window to the work area when the display is smaller', () => {
    const bounds = centeredIn({ x: 0, y: 0, width: 1024, height: 640 }, 1100, 760)
    expect(bounds).toEqual({ x: 0, y: 0, width: 1024, height: 640 })
  })
})
