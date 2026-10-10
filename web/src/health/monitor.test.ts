import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { FrameResult } from '../core/types'
import { HEALTH_PHRASES, HealthMonitor } from './monitor'

const cfg = CONFIG.health
const FRAME_GAP_MS = 100 // 10 fps

function frame(receivedTimeMs: number, meanLuma = 0.5): FrameResult {
  return {
    frameId: 0,
    captureTimeMs: receivedTimeMs - 60,
    receivedTimeMs,
    frameWidth: 1280,
    frameHeight: 720,
    inputSize: 416,
    backend: 'wasm',
    timings: { preprocessMs: 5, inferenceMs: 50, postprocessMs: 2 },
    meanLuma,
    detections: [],
  }
}

/** Feed frames every gapMs from fromMs (exclusive) to toMs, calling update after each; returns all announcements. */
function run(monitor: HealthMonitor, fromMs: number, toMs: number, options: { gapMs?: number; luma?: number } = {}) {
  const gap = options.gapMs ?? FRAME_GAP_MS
  const said: string[] = []
  let last = monitor.update(fromMs)
  for (let t = fromMs + gap; t <= toMs; t += gap) {
    monitor.recordFrame(frame(t, options.luma))
    last = monitor.update(t)
    said.push(...last.announcements.map((a) => a.phrase))
  }
  return { said, state: last.state }
}

function started(atMs = 0): HealthMonitor {
  const monitor = new HealthMonitor()
  monitor.setRunState('running', atMs)
  return monitor
}

describe('HealthMonitor', () => {
  test('stopped before start, healthy with steady frames', () => {
    const monitor = new HealthMonitor()
    expect(monitor.update(0).state.status).toBe('stopped')
    monitor.setRunState('running', 0)
    const { said, state } = run(monitor, 0, 5000)
    expect(said).toEqual([])
    expect(state.status).toBe('healthy')
    expect(state.issues).toEqual([])
    expect(state.fps).toBeCloseTo(10)
    expect(state.backend).toBe('wasm')
  })

  test('stall: warns the moment frames stop, repeats at a limited rate, recovers once', () => {
    const monitor = started()
    run(monitor, 0, 1000)
    // No frames from 1000 ms on.
    expect(monitor.update(1000 + cfg.stalledAfterMs).announcements).toEqual([])
    const enter = monitor.update(1001 + cfg.stalledAfterMs)
    expect(enter.state.status).toBe('stopped')
    expect(enter.state.issues).toEqual(['stalled'])
    expect(enter.announcements).toEqual([{ kind: 'warning', issue: 'stalled', phrase: HEALTH_PHRASES.stalled }])

    const enteredAt = 1001 + cfg.stalledAfterMs
    expect(monitor.update(enteredAt + cfg.warningRepeatMs - 1).announcements).toEqual([])
    expect(monitor.update(enteredAt + cfg.warningRepeatMs).announcements.map((a) => a.phrase)).toEqual([HEALTH_PHRASES.stalled])

    // Frames come back: still a warning until recoverAfterMs of good readings, then "Detection back." once.
    const back = enteredAt + cfg.warningRepeatMs + 100
    const { said, state } = run(monitor, back, back + cfg.recoverAfterMs + 500)
    expect(said).toEqual([HEALTH_PHRASES.recovered])
    expect(state.status).toBe('healthy')
  })

  test('no frame at all after start counts as a stall', () => {
    const monitor = started(1000)
    expect(monitor.update(1000 + cfg.stalledAfterMs + 1).state.issues).toEqual(['stalled'])
  })

  test('low frame rate only after a full window', () => {
    const monitor = started()
    const slowGap = 1000 / (cfg.lowFpsThreshold - 1)
    const early = run(monitor, 0, cfg.fpsWindowMs - slowGap, { gapMs: slowGap })
    expect(early.said).toEqual([])
    const late = run(monitor, cfg.fpsWindowMs - slowGap, cfg.fpsWindowMs + 1000, { gapMs: slowGap })
    expect(late.said).toEqual([HEALTH_PHRASES['low-fps']])
    expect(late.state.status).toBe('degraded')
  })

  test('low light after the hold time, not before', () => {
    const monitor = started()
    run(monitor, 0, 1000)
    const brief = run(monitor, 1000, 1000 + cfg.lowLightHoldMs - FRAME_GAP_MS, { luma: 0.02 })
    expect(brief.said).toEqual([])
    const held = run(monitor, 1000 + cfg.lowLightHoldMs - FRAME_GAP_MS, 1000 + cfg.lowLightHoldMs + 200, { luma: 0.02 })
    expect(held.said).toEqual([HEALTH_PHRASES['low-light']])
    expect(held.state.issues).toEqual(['low-light'])
  })

  test('one bright frame resets the low-light hold', () => {
    const monitor = started()
    run(monitor, 0, 1500, { luma: 0.02 })
    monitor.recordFrame(frame(1600, 0.5))
    const { said } = run(monitor, 1600, 1600 + cfg.lowLightHoldMs - FRAME_GAP_MS, { luma: 0.02 })
    expect(said).toEqual([])
  })

  test('phone lowered or raised, with the matching phrase', () => {
    const lowered = started()
    lowered.recordOrientation({ pitchDeg: cfg.phoneLoweredPitchDeg - 10, rollDeg: 0, timeMs: 100 })
    expect(run(lowered, 0, 100 + cfg.phoneLoweredHoldMs - FRAME_GAP_MS).said).toEqual([])
    expect(run(lowered, 100 + cfg.phoneLoweredHoldMs - FRAME_GAP_MS, 1500 + cfg.phoneLoweredHoldMs).said).toEqual([
      HEALTH_PHRASES.phoneLowered,
    ])

    const raised = started()
    raised.recordOrientation({ pitchDeg: cfg.phoneRaisedPitchDeg + 10, rollDeg: 0, timeMs: 0 })
    expect(run(raised, 0, cfg.phoneLoweredHoldMs + 200).said).toEqual([HEALTH_PHRASES.phoneRaised])
  })

  test('level again clears the tilt warning after the recovery time', () => {
    const monitor = started()
    monitor.recordOrientation({ pitchDeg: -60, rollDeg: 0, timeMs: 0 })
    run(monitor, 0, 2000)
    monitor.recordOrientation({ pitchDeg: 0, rollDeg: 0, timeMs: 2000 })
    const { said, state } = run(monitor, 2000, 2000 + cfg.recoverAfterMs + 200)
    expect(said).toEqual([HEALTH_PHRASES.recovered])
    expect(state.status).toBe('healthy')
  })

  test('a second problem is announced at once, the most important one repeats', () => {
    const monitor = started()
    run(monitor, 0, 1000)
    run(monitor, 1000, 1000 + cfg.lowLightHoldMs + 100, { luma: 0.02 })
    monitor.setFault('audio-blocked', true)
    const t = 1000 + cfg.lowLightHoldMs + 200
    expect(monitor.update(t).announcements.map((a) => a.phrase)).toEqual([HEALTH_PHRASES['audio-blocked']])
    const repeat = monitor.update(t + cfg.warningRepeatMs)
    expect(repeat.state.issues).toEqual(['stalled', 'audio-blocked', 'low-light'])
    expect(repeat.announcements.map((a) => a.phrase)).toEqual([HEALTH_PHRASES.stalled])
  })

  test('pausing drops warnings silently and does not announce recovery', () => {
    const monitor = started()
    expect(monitor.update(cfg.stalledAfterMs + 1).state.issues).toEqual(['stalled'])
    monitor.setRunState('paused', 2000)
    const paused = monitor.update(2100)
    expect(paused.announcements).toEqual([])
    expect(paused.state).toMatchObject({ status: 'stopped', paused: true, issues: [] })
    // Frames are ignored while paused, and the stall clock restarts on resume.
    monitor.recordFrame(frame(2200))
    monitor.setRunState('running', 5000)
    expect(monitor.update(5000 + cfg.stalledAfterMs).announcements).toEqual([])
  })

  test('a fault warns even when stopped and clears after the recovery time', () => {
    const monitor = new HealthMonitor()
    monitor.setFault('no-camera', true)
    expect(monitor.update(0).announcements.map((a) => a.phrase)).toEqual([HEALTH_PHRASES['no-camera']])
    monitor.setFault('no-camera', false)
    expect(monitor.update(100).announcements).toEqual([])
    expect(monitor.update(100 + cfg.recoverAfterMs).announcements.map((a) => a.phrase)).toEqual([HEALTH_PHRASES.recovered])
  })
})
