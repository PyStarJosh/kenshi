import { describe, expect, test } from 'vitest'
import type { FrameResult } from '../core/types'
import { createBitmapGrabber, FrameScheduler } from './scheduler'
import type { SchedulerOptions } from './scheduler'

const bitmap = (id: number) => ({ id, close() {} }) as unknown as ImageBitmap
const frameResult = (frameId: number) => ({ frameId }) as FrameResult

/** A hand-driven clock and frame source, so tests control exactly when frames arrive. */
function setup(overrides: Partial<SchedulerOptions> = {}) {
  let time = 0
  let pendingFrame: (() => void) | null = null
  const sent: number[] = []
  const results: number[] = []
  const errors: number[] = []
  const detects: Array<(r: FrameResult | null) => void> = []
  const scheduler = new FrameScheduler({
    maxFps: 10, // one frame per 100 ms
    frameGapTolerance: 1,
    requestFrame: (callback) => {
      pendingFrame = callback
      return () => {
        pendingFrame = null
      }
    },
    grab: async () => bitmap(sent.length),
    detect: (_bitmap, frameId) => {
      sent.push(frameId)
      return new Promise((resolve) => detects.push(resolve))
    },
    now: () => time,
    onResult: (r) => results.push(r.frameId),
    onError: (_e, count) => errors.push(count),
    ...overrides,
  })
  return {
    scheduler,
    sent,
    results,
    errors,
    /** Advance the clock and deliver one video frame. */
    frame(atMs: number) {
      time = atMs
      const callback = pendingFrame
      pendingFrame = null
      callback?.()
    },
    setTime(atMs: number) {
      time = atMs
    },
    finishDetect(index: number, frameId: number) {
      detects[index](frameResult(frameId))
    },
    hasPendingFrame: () => pendingFrame !== null,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('FrameScheduler', () => {
  test('sends a frame only when the detector is idle (never queues)', async () => {
    const t = setup()
    t.scheduler.start()
    t.frame(0)
    await settle()
    expect(t.sent).toEqual([0])
    t.frame(200) // detector still busy with frame 0
    await settle()
    expect(t.sent).toEqual([0])
    t.finishDetect(0, 0)
    await settle()
    t.frame(300)
    await settle()
    expect(t.sent).toEqual([0, 1])
    expect(t.results).toEqual([0])
  })

  test('respects the maximum rate', async () => {
    const t = setup()
    t.scheduler.start()
    t.frame(0)
    await settle()
    t.finishDetect(0, 0)
    await settle()
    t.frame(50) // detector idle, but only 50 ms since the last capture
    await settle()
    expect(t.sent).toEqual([0])
    t.frame(100)
    await settle()
    expect(t.sent).toEqual([0, 1])
  })

  test('timing jitter on a 30 fps camera does not halve a 15 fps cap', async () => {
    const t = setup({ maxFps: 15, frameGapTolerance: 0.9 })
    t.scheduler.start()
    // Camera frames every 33.3 ms with +-1 ms jitter, detector instant: the cap allows one per 66.7 ms.
    const jitter = [0, -1, 1, -1, 1, 0, -1, 1, 0, -1, 1, -1]
    for (let i = 0; i < jitter.length; i++) {
      t.frame(i * 33.3 + jitter[i])
      await settle()
      if (t.sent.length > 0) t.finishDetect(t.sent.length - 1, t.sent.length - 1)
      await settle()
    }
    // 12 frames over about 366 ms at 15 fps is 6 sent; strict 66.7 ms spacing would have sent only 4.
    expect(t.sent.length).toBeGreaterThanOrEqual(6)
  })

  test('still enforces the cap on a fast camera', async () => {
    const t = setup({ maxFps: 15, frameGapTolerance: 0.9 })
    t.scheduler.start()
    for (let i = 0; i < 60; i++) {
      t.frame(i * 16.7) // 60 fps camera for one second
      await settle()
      if (t.sent.length > 0) t.finishDetect(t.sent.length - 1, t.sent.length - 1)
      await settle()
    }
    expect(t.sent.length).toBeLessThanOrEqual(16)
    expect(t.sent.length).toBeGreaterThanOrEqual(14)
  })

  test('a detector slower than two camera frames does not drop the rate to a third', async () => {
    const t = setup({ maxFps: 15, frameGapTolerance: 0.9 })
    t.scheduler.start()
    t.frame(0)
    await settle()
    expect(t.sent).toEqual([0])
    // The detector takes 70 ms. No new camera frame has been delivered yet, but the next capture
    // must start immediately instead of waiting for one.
    t.setTime(70)
    t.finishDetect(0, 0)
    await settle()
    expect(t.sent).toEqual([0, 1])
  })

  test('does not capture again on completion while the minimum gap has not passed', async () => {
    const t = setup({ maxFps: 10, frameGapTolerance: 1 })
    t.scheduler.start()
    t.frame(0)
    await settle()
    t.setTime(40) // detector finished fast, but 100 ms have not passed
    t.finishDetect(0, 0)
    await settle()
    expect(t.sent).toEqual([0])
    t.frame(100)
    await settle()
    expect(t.sent).toEqual([0, 1])
  })

  test('keeps listening for frames after each one', async () => {
    const t = setup()
    t.scheduler.start()
    t.frame(0)
    expect(t.hasPendingFrame()).toBe(true)
  })

  test('stop cancels the loop and drops a late result', async () => {
    const t = setup()
    t.scheduler.start()
    t.frame(0)
    await settle()
    t.scheduler.stop()
    expect(t.hasPendingFrame()).toBe(false)
    t.finishDetect(0, 0)
    await settle()
    expect(t.results).toEqual([])
  })

  test('does not send anything when the video has no frame yet', async () => {
    const t = setup({ grab: async () => null })
    t.scheduler.start()
    t.frame(0)
    await settle()
    expect(t.sent).toEqual([])
  })

  test('counts consecutive errors and resets after a success', async () => {
    let fail = true
    const t = setup({
      detect: async (_b, frameId) => {
        if (fail) throw new Error('bad frame')
        return frameResult(frameId)
      },
    })
    t.scheduler.start()
    for (const at of [0, 100, 200]) {
      t.frame(at)
      await settle()
    }
    expect(t.errors).toEqual([1, 2, 3])
    fail = false
    t.frame(300)
    await settle()
    fail = true
    t.frame(400)
    await settle()
    expect(t.errors).toEqual([1, 2, 3, 1])
  })
})

describe('createBitmapGrabber', () => {
  const video = (overrides: Partial<HTMLVideoElement> = {}) =>
    ({ readyState: 4, videoWidth: 1280, videoHeight: 720, ...overrides }) as HTMLVideoElement

  test('returns null until the video has a frame', async () => {
    const grab = createBitmapGrabber(video({ readyState: 0 }), {
      createBitmap: async () => bitmap(1),
      createCanvas: () => ({}) as HTMLCanvasElement,
    })
    expect(await grab()).toBeNull()
  })

  test('uses the video directly when that works', async () => {
    const sources: unknown[] = []
    const v = video()
    const grab = createBitmapGrabber(v, {
      createBitmap: async (source) => {
        sources.push(source)
        return bitmap(1)
      },
      createCanvas: () => {
        throw new Error('should not be needed')
      },
    })
    await grab()
    expect(sources).toEqual([v])
  })

  test('falls back to a canvas when the bitmap cannot be made from the video, and keeps using it', async () => {
    const drawn: unknown[] = []
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (source: unknown) => drawn.push(source) }),
    } as unknown as HTMLCanvasElement
    const sources: unknown[] = []
    const v = video()
    const grab = createBitmapGrabber(v, {
      createBitmap: async (source) => {
        sources.push(source)
        if (source === v) throw new Error('not supported')
        return bitmap(2)
      },
      createCanvas: () => canvas,
    })
    await grab()
    await grab()
    expect(drawn).toEqual([v, v])
    expect(canvas.width).toBe(1280)
    expect(canvas.height).toBe(720)
    // The video is tried once; every later frame goes through the canvas.
    expect(sources.filter((s) => s === v)).toHaveLength(1)
  })

  test('the fallback canvas is sized once, not reallocated on every frame', async () => {
    let resized = 0
    let width = 0
    let height = 0
    const canvas = {
      get width() {
        return width
      },
      set width(value: number) {
        width = value
        resized += 1
      },
      get height() {
        return height
      },
      set height(value: number) {
        height = value
        resized += 1
      },
      getContext: () => ({ drawImage: () => {} }),
    } as unknown as HTMLCanvasElement
    const v = video()
    const grab = createBitmapGrabber(v, {
      createBitmap: async (source) => {
        if (source === v) throw new Error('not supported')
        return bitmap(2)
      },
      createCanvas: () => canvas,
    })
    for (let i = 0; i < 5; i++) await grab()
    expect(resized).toBe(2) // width and height, once
  })
})
