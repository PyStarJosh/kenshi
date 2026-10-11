import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { AlertEvent, AlertOutcome, HealthState } from '../core/types'
import { AudioEngine, screenAlert } from './engine'
import { Speaker } from './speech'
import type { UtteranceLike } from './speech'
import type { TonePlan } from './tones'

const alert = (patch: Partial<AlertEvent> = {}): AlertEvent => ({
  id: 'a1',
  kind: 'obstacle',
  priority: 'normal',
  trackId: 7,
  phrase: 'Backpack, 1 o\'clock, about 2 meters, on the floor.',
  pan: 0.5,
  frameTimeMs: 1000,
  createdTimeMs: 1100,
  ...patch,
})

const healthy: HealthState = {
  status: 'healthy',
  issues: [],
  fps: 12,
  lastFrameAgeMs: 50,
  backend: 'wasm',
  paused: false,
  updatedTimeMs: 0,
}

describe('screenAlert', () => {
  const tracks = (id: number) => (id === 7 ? { distanceM: 2 } : null)

  test('fresh alert with a live track passes', () => {
    expect(screenAlert(alert(), 1000 + CONFIG.alerts.staleLimitMs, tracks)).toBe('ok')
  })

  test('older than the stale limit is dropped', () => {
    expect(screenAlert(alert(), 1001 + CONFIG.alerts.staleLimitMs, tracks)).toBe('dropped-stale')
  })

  test('Find speech may wait longer than an obstacle alert before it is dropped', () => {
    const find = alert({ kind: 'find', trackId: null, pan: null })
    expect(screenAlert(find, 1000 + CONFIG.alerts.staleLimitMs + 500, tracks)).toBe('ok')
    expect(screenAlert(find, 1000 + CONFIG.find.speechStaleMs, tracks)).toBe('ok')
    expect(screenAlert(find, 1001 + CONFIG.find.speechStaleMs, tracks)).toBe('dropped-stale')
  })

  test('a gone track is dropped; alerts without a track skip the check', () => {
    expect(screenAlert(alert({ trackId: 9 }), 1200, tracks)).toBe('dropped-track-gone')
    expect(screenAlert(alert({ trackId: null, kind: 'status' }), 1200, tracks)).toBe('ok')
  })
})

function setup() {
  let now = 1200
  const tones: { plan: TonePlan; volume: number; atMs: number }[] = []
  const outcomes: string[] = []
  const spoken: UtteranceLike[] = []
  const timers: (() => void)[] = []
  let toneEndMs = 0
  let stops = 0
  const speaker = new Speaker({
    synth: { speak: (u) => spoken.push(u), cancel: () => {} },
    createUtterance: (text) => ({ text, rate: 1, voice: null, onstart: null, onend: null, onerror: null }),
    now: () => now,
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
  })
  const engine = new AudioEngine({
    tones: {
      play: (plan, volume) => {
        tones.push({ plan, volume, atMs: now })
        toneEndMs = now + 100
        return { startMs: now + 10, endMs: toneEndMs }
      },
      stop: () => {
        stops += 1
        toneEndMs = 0
      },
      busyUntilMs: () => toneEndMs,
    },
    speaker,
    getTrack: (id) => (id === 7 ? { distanceM: 1 } : null),
    now: () => now,
    onOutcome: (a: AlertEvent, outcome: AlertOutcome, latencyMs: number | null) =>
      outcomes.push(`${a.id} ${outcome}${latencyMs === null ? '' : ` ${latencyMs}`}`),
    onError: (message) => outcomes.push(`error ${message}`),
  })
  return {
    engine,
    tones,
    outcomes,
    spoken,
    timers,
    stops: () => stops,
    setNow: (t: number) => (now = t),
    flushTimers: () => timers.splice(0).forEach((callback) => callback()),
  }
}

describe('AudioEngine', () => {
  test('tone first, then the phrase after the gap; latency is measured from the frame', () => {
    const s = setup()
    s.engine.handleAlert(alert())
    expect(s.tones).toHaveLength(1)
    expect(s.tones[0].plan.pan).toBe(0.5)
    expect(s.outcomes).toEqual(['a1 started 210'])
    expect(s.engine.getTiming()).toMatchObject({ alertToToneMs: 110, frameToToneMs: 210 })
    expect(s.spoken).toHaveLength(0)
    s.flushTimers()
    expect(s.spoken.map((u) => u.text)).toEqual([alert().phrase])
    s.setNow(1500)
    s.spoken[0].onstart?.()
    expect(s.engine.getTiming()?.frameToSpeechMs).toBe(500)
  })

  test('a stale alert makes no sound', () => {
    const s = setup()
    s.setNow(1000 + CONFIG.alerts.staleLimitMs + 1)
    s.engine.handleAlert(alert())
    expect(s.tones).toHaveLength(0)
    expect(s.outcomes).toEqual(['a1 dropped-stale'])
  })

  test('urgent stops the tone and speech in progress and plays its own pulses', () => {
    const s = setup()
    s.engine.handleAlert(alert())
    s.engine.handleAlert(alert({ id: 'u1', priority: 'urgent', pan: -1 }))
    expect(s.stops()).toBe(1)
    expect(s.outcomes).toEqual(['a1 started 210', 'a1 preempted', 'u1 started 210'])
    expect(s.tones[1].plan.notes).toHaveLength(CONFIG.audio.urgentPulseCount)
    expect(s.tones[1].plan.pan).toBe(-1)
  })

  test('a health warning plays the two-tone warning and preempts', () => {
    const s = setup()
    s.engine.handleAlert(alert())
    s.engine.announceHealth({ kind: 'warning', issue: 'low-light', phrase: 'Too dark to detect reliably.' })
    expect(s.outcomes).toContain('a1 preempted')
    expect(s.tones[1].plan.notes).toHaveLength(2)
    expect(s.tones[1].plan.pan).toBe(0)
  })

  test('heartbeat ticks while healthy and stays quiet during speech', () => {
    const s = setup()
    s.engine.tickHeartbeat()
    expect(s.tones).toHaveLength(0)
    s.engine.setHealth(healthy)
    s.engine.tickHeartbeat()
    expect(s.tones).toHaveLength(1)
    expect(s.tones[0].volume).toBe(CONFIG.settings.heartbeatVolume)

    s.setNow(1200 + CONFIG.audio.heartbeatIntervalMs)
    s.engine.handleAlert(alert({ frameTimeMs: 1200 + CONFIG.audio.heartbeatIntervalMs }))
    s.setNow(1200 + 2 * CONFIG.audio.heartbeatIntervalMs)
    s.engine.tickHeartbeat()
    expect(s.tones).toHaveLength(2)
  })
})
