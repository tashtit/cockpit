import { useCallback, useEffect, useRef, useState } from 'react'
import { clampZoom } from '../../shared/window'
import { api } from './api'

type Zoom = {
  /** The window's zoom level, to two places — 1 is 100% */
  readonly zoom: number
  /** Back to 100% */
  readonly resetZoom: () => void
}

/**
 * The window's zoom, kept in step. Zoom has no event of its own — the menu's ⌘+/- acts in
 * main and the chip's reset in preload — but every change resizes the layout viewport, so
 * one resize listener sees all of them (the poll this replaced left the chip up to 1.2s
 * stale). A window drag fires the same event, hence the ref: work is done only when the
 * level really moved.
 */
export function useZoom(): Zoom {
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(1)

  const syncZoom = useCallback((): void => {
    const z = clampZoom(api.getZoomFactor())
    if (z !== api.getZoomFactor()) api.setZoomFactor(z)
    const level = Math.round(z * 100) / 100
    if (level === zoomRef.current) return
    zoomRef.current = level
    setZoom(level)
    // the traffic lights are drawn by the OS at a fixed size while everything in the
    // stylesheet is in CSS pixels — `--traffic-clear` divides by this to keep the one
    // measurement that has to meet them in the same units they are
    document.documentElement.style.setProperty('--zoom', String(level))
    // main keeps the window's minimum size in step: the floor is written in CSS pixels,
    // and the further in this is zoomed the fewer of them the same window holds
    void api.reportZoom(level)
  }, [])

  useEffect(() => {
    syncZoom()
    window.addEventListener('resize', syncZoom)
    return () => window.removeEventListener('resize', syncZoom)
  }, [syncZoom])

  const resetZoom = useCallback((): void => {
    api.setZoomFactor(1)
    // webFrame is synchronous, so the chip and main settle now rather than on the
    // resize this triggers — which then sees the level already where it left it
    syncZoom()
  }, [syncZoom])

  return { zoom, resetZoom }
}
