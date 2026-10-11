import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { formatSpread, LatencyStats } from './latency'

describe('LatencyStats', () => {
  test('is empty before the first alert', () => {
    expect(new LatencyStats().view()).toEqual({ urgentTone: null, tone: null, speech: null })
    expect(formatSpread(null)).toBe('-')
  })

  test('reports p50 and p95 per stage, with urgent tones apart', () => {
    const stats = new LatencyStats()
    for (let i = 1; i <= 20; i++) stats.record('tone', 'normal', i * 10)
    stats.record('tone', 'urgent', 100)
    stats.record('tone', 'urgent', 300)
    for (const ms of [200, 400, 600]) stats.record('speech', 'normal', ms)
    const view = stats.view()
    expect(view.urgentTone).toEqual({ count: 2, p50: 100, p95: 300 })
    expect(view.tone).toMatchObject({ count: 22, p50: 100 })
    expect(view.speech).toEqual({ count: 3, p50: 400, p95: 600 })
    expect(formatSpread(view.speech)).toBe('400 / 600 ms (3)')
  })

  test('forgets the oldest samples past the limit', () => {
    const stats = new LatencyStats()
    for (let i = 0; i < CONFIG.debug.latencySamples + 5; i++) stats.record('speech', 'info', i)
    expect(stats.view().speech?.count).toBe(CONFIG.debug.latencySamples)
  })
})
