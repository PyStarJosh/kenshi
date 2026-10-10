import { describe, expect, test } from 'vitest'
import type { FrameResult } from '../../core/types'
import { percentile, summarize } from './benchmarkStats'

describe('percentile', () => {
  const values = Array.from({ length: 100 }, (_, i) => 100 - i) // 100..1, unsorted

  test('uses nearest rank', () => {
    expect(percentile(values, 50)).toBe(50)
    expect(percentile(values, 95)).toBe(95)
    expect(percentile(values, 100)).toBe(100)
  })

  test('a single value is every percentile', () => {
    expect(percentile([7], 50)).toBe(7)
    expect(percentile([7], 95)).toBe(7)
  })

  test('rejects an empty list', () => {
    expect(() => percentile([], 50)).toThrow()
  })

  test('does not reorder its input', () => {
    const input = [3, 1, 2]
    percentile(input, 50)
    expect(input).toEqual([3, 1, 2])
  })
})

test('summarize reports each stage and the per-frame total', () => {
  const frame = (pre: number, inf: number, post: number) =>
    ({ timings: { preprocessMs: pre, inferenceMs: inf, postprocessMs: post } }) as FrameResult
  const stats = summarize([frame(1, 10, 2), frame(2, 20, 3), frame(3, 30, 4)], [15, 26, 38])
  expect(stats.inference).toEqual({ p50: 20, p95: 30 })
  expect(stats.total).toEqual({ p50: 25, p95: 37 })
  expect(stats.roundTrip).toEqual({ p50: 26, p95: 38 })
})
