import { describe, expect, test } from 'vitest'
import type { HealthState } from '../core/types'
import { heartbeatDue } from './heartbeat'
import type { HeartbeatInput } from './heartbeat'

const healthy: HealthState = {
  status: 'healthy',
  issues: [],
  fps: 12,
  lastFrameAgeMs: 50,
  backend: 'wasm',
  paused: false,
  updatedTimeMs: 0,
}

const input = (patch: Partial<HeartbeatInput> = {}): HeartbeatInput => ({
  nowMs: 10_000,
  lastTickMs: 7_000,
  intervalMs: 2000,
  health: healthy,
  speaking: false,
  toneBusyUntilMs: 0,
  ...patch,
})

describe('heartbeatDue', () => {
  test('ticks when healthy, quiet, and the interval has passed', () => {
    expect(heartbeatDue(input())).toBe(true)
    expect(heartbeatDue(input({ lastTickMs: -Infinity }))).toBe(true)
  })

  test('waits for the interval', () => {
    expect(heartbeatDue(input({ lastTickMs: 8_500 }))).toBe(false)
  })

  test('never overlaps speech or a tone', () => {
    expect(heartbeatDue(input({ speaking: true }))).toBe(false)
    expect(heartbeatDue(input({ toneBusyUntilMs: 10_050 }))).toBe(false)
  })

  test('silent unless healthy and running', () => {
    expect(heartbeatDue(input({ health: null }))).toBe(false)
    expect(heartbeatDue(input({ health: { ...healthy, status: 'degraded', issues: ['low-light'] } }))).toBe(false)
    expect(heartbeatDue(input({ health: { ...healthy, status: 'stopped' } }))).toBe(false)
    expect(heartbeatDue(input({ health: { ...healthy, paused: true } }))).toBe(false)
  })
})
