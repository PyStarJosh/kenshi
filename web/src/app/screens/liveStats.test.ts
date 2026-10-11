import { describe, expect, test } from 'vitest'
import { CONFIG } from '../../core/config'
import type { FrameResult } from '../../core/types'
import { LiveStats } from './liveStats'

const result = (receivedTimeMs: number, inferenceMs: number) =>
  ({ receivedTimeMs, timings: { preprocessMs: 0, inferenceMs, postprocessMs: 0 } }) as FrameResult

describe('LiveStats', () => {
  test('is all zeros before any result', () => {
    expect(new LiveStats().view(1000)).toEqual({ fps: 0, inferenceP50: 0, inferenceP95: 0 })
  })

  test('computes the frame rate from result arrival times', () => {
    const stats = new LiveStats()
    for (let i = 0; i < 11; i++) stats.push(result(i * 100, 30)) // 10 results per second
    expect(stats.view(1000).fps).toBeCloseTo(10, 6)
  })

  test('the frame rate falls to zero when results stop arriving', () => {
    const stats = new LiveStats()
    for (let i = 0; i < 11; i++) stats.push(result(i * 100, 30))
    expect(stats.view(1000 + CONFIG.health.fpsWindowMs + 1).fps).toBe(0)
  })

  test('reports inference percentiles', () => {
    const stats = new LiveStats()
    const n = CONFIG.debug.statsSamples
    for (let i = 1; i <= n; i++) stats.push(result(i * 10, i)) // inference times 1..n ms
    const view = stats.view(n * 10)
    expect(view.inferenceP50).toBe(Math.ceil(n * 0.5))
    expect(view.inferenceP95).toBe(Math.ceil(n * 0.95))
  })

  test('keeps only the most recent samples', () => {
    const stats = new LiveStats()
    for (let i = 0; i < CONFIG.debug.statsSamples; i++) stats.push(result(i, 1000)) // old and slow
    for (let i = 0; i < CONFIG.debug.statsSamples; i++) stats.push(result(10_000 + i, 10)) // recent and fast
    expect(stats.view(10_100).inferenceP95).toBe(10)
  })
})
