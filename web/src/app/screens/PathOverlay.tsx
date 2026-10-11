// The free-space path drawn over the camera picture (R7): the Find screen's camera inset and ?debug. A canvas that covers
// the picture, so it lines up with the detection boxes. It is a guide in image space, not a statement that the way is clear.
import { useEffect, useRef } from 'react'
import { CONFIG } from '../../core/config'
import type { FreeSpaceResult } from '../../core/types'
import type { Pipeline } from '../pipeline'
import { drawPath, maskToRgba } from './overlayDraw'

interface Props {
  pipeline: Pipeline
}

export default function PathOverlay({ pipeline }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const style = { opacity: CONFIG.freeSpace.overlayOpacity, lineWidthPx: CONFIG.freeSpace.overlayLineWidthPx }
    // The mask is painted once per result on a small canvas of its own, then stretched onto the overlay.
    const maskCanvas = document.createElement('canvas')
    let latest: { path: FreeSpaceResult; atMs: number } | null = null

    const draw = () => {
      // The canvas is as many pixels as it is on screen, so the line is drawn the width asked for.
      const width = Math.max(1, Math.round(canvas.clientWidth))
      const height = Math.max(1, Math.round(canvas.clientHeight))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const path = latest?.path ?? null
      let mask: HTMLCanvasElement | null = null
      if (path !== null) {
        const maskHeight = path.processHeight - path.roiStartRow
        if (maskHeight > 0 && path.freeMask.length >= path.processWidth * maskHeight) {
          maskCanvas.width = path.processWidth
          maskCanvas.height = maskHeight
          const maskCtx = maskCanvas.getContext('2d')
          if (maskCtx) {
            const pixels = maskToRgba(path.freeMask, style.opacity)
            maskCtx.putImageData(new ImageData(pixels, path.processWidth, maskHeight), 0, 0)
            mask = maskCanvas
          }
        }
      }
      drawPath(ctx, width, height, path, mask, style)
    }

    const stop = pipeline.bus.subscribe('path', (path) => {
      latest = { path, atMs: performance.now() }
      draw()
    })
    const resize = new ResizeObserver(draw)
    resize.observe(canvas)
    // A path that stopped arriving (Find ended, the camera stopped) is not left on the picture.
    const timer = setInterval(() => {
      if (latest && performance.now() - latest.atMs > CONFIG.freeSpace.maxAgeMs) {
        latest = null
        draw()
      }
    }, 500)
    return () => {
      stop()
      resize.disconnect()
      clearInterval(timer)
    }
  }, [pipeline])

  return <canvas ref={canvasRef} className="path-overlay" aria-hidden="true" />
}
