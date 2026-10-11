import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { Detection, HealthState, OrientationSample, TelemetryEvent, Track } from '../core/types'
import { TelemetryLogger } from './logger'
import type { SessionMeta, TelemetryConfig } from './logger'

const ORIGIN = 50_000

const META: SessionMeta = {
  appVersion: '0.0.0',
  gitCommit: 'abc1234',
  model: 'yolo26n-416.onnx',
  provider: 'auto',
  backend: 'webgpu',
  inputSize: 416,
  crossOriginIsolated: true,
  settings: { eyeHeightM: 1.6, horizontalFovDeg: 65, speechRate: 1, spokenFeedback: true, toneVolume: 0.8, heartbeatVolume: 0.3, testMode: true },
  device: {
    userAgent: 'test',
    platform: 'test',
    language: 'en',
    hardwareConcurrency: 6,
    deviceMemoryGb: null,
    screenWidth: 100,
    screenHeight: 200,
    devicePixelRatio: 3,
  },
}

function setup(cfg: Partial<TelemetryConfig> = {}) {
  const clock = { nowMs: ORIGIN }
  const tilt: { sample: OrientationSample | null } = { sample: null }
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = []
  const logger = new TelemetryLogger({
    now: () => clock.nowMs,
    getOrientation: () => tilt.sample,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    cfg: { ...CONFIG.telemetry, ...cfg },
  })
  const events = () => logger.getLines().map((l) => JSON.parse(l) as TelemetryEvent)
  return { logger, clock, tilt, timers, events }
}

const detection: Detection = { classId: 24, label: 'backpack', confidence: 0.8, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }
const frameAt = (timeMs: number, frameId = 1): TelemetryEvent => ({
  kind: 'frame',
  timeMs,
  frameId,
  timings: { preprocessMs: 1, inferenceMs: 2, postprocessMs: 3 },
  captureTimeMs: timeMs - 40,
  receivedTimeMs: timeMs - 10,
  frameWidth: 1280,
  frameHeight: 720,
  meanLuma: 0.4,
  fps: 12,
  pipelineMs: 40,
  detections: [detection],
  orientation: { pitchDeg: -10.123456789, rollDeg: 0.5, timeMs: timeMs - 40 },
})
const trackAt = (id: number): Track =>
  ({ id, firstSeenMs: ORIGIN + 100, lastSeenMs: ORIGIN + 200, distanceM: 2.123456789, box: { x: 0, y: 0, width: 1, height: 1 } }) as Track

describe('when Test mode is off', () => {
  test('nothing is logged until a log begins', () => {
    const t = setup()
    t.logger.handle(frameAt(ORIGIN + 100))
    expect(t.logger.getLines()).toEqual([])
    expect(t.logger.getView()).toEqual({ status: 'off', hasLog: false, message: null })
    expect(t.timers).toHaveLength(0)
  })

  test('nothing is logged after the log stops', () => {
    const t = setup()
    t.logger.begin(META, ORIGIN)
    t.logger.stop()
    const count = t.logger.getLines().length
    t.logger.handle(frameAt(ORIGIN + 100))
    expect(t.logger.getLines()).toHaveLength(count)
    expect(t.timers[0].cleared).toBe(true)
  })
})

describe('a log', () => {
  test('starts with the session entry: version, build, model, settings, device, and the config in force', () => {
    const t = setup()
    t.clock.nowMs = ORIGIN + 5
    t.logger.begin(META, ORIGIN)
    const [session, runState] = t.events()
    expect(session).toMatchObject({
      kind: 'session',
      timeMs: 5,
      version: 1,
      gitCommit: 'abc1234',
      model: 'yolo26n-416.onnx',
      inputSize: 416,
      settings: { eyeHeightM: 1.6, horizontalFovDeg: 65 },
      device: { devicePixelRatio: 3 },
      config: { alerts: { staleLimitMs: CONFIG.alerts.staleLimitMs } },
    })
    expect(Number.isNaN(Date.parse((session as { startedAtIso: string }).startedAtIso))).toBe(false)
    expect(runState).toMatchObject({ kind: 'run-state', state: 'running', timeMs: 5 })
  })

  test('puts every time on the session clock, where zero is the Start tap', () => {
    const t = setup()
    t.logger.begin(META, ORIGIN)
    t.logger.handle(frameAt(ORIGIN + 1000))
    t.logger.handle({
      kind: 'alert',
      timeMs: ORIGIN + 1100,
      outcome: 'finished',
      latencyMs: null,
      toneStartMs: ORIGIN + 1050,
      speechStartMs: ORIGIN + 1200,
      alert: { id: 'a', kind: 'obstacle', priority: 'normal', trackId: 1, phrase: 'x', pan: 0, frameTimeMs: ORIGIN + 960, createdTimeMs: ORIGIN + 1000 },
    })
    const [, , frame, alert] = t.events()
    expect(frame).toMatchObject({ timeMs: 1000, captureTimeMs: 960, receivedTimeMs: 990, orientation: { timeMs: 960 } })
    expect(alert).toMatchObject({ timeMs: 1100, toneStartMs: 1050, speechStartMs: 1200, alert: { frameTimeMs: 960, createdTimeMs: 1000 } })
  })

  test('keeps replay inputs at full precision', () => {
    const t = setup()
    t.logger.begin(META, ORIGIN)
    t.logger.handle(frameAt(ORIGIN + 1000))
    const frame = t.events()[2] as Extract<TelemetryEvent, { kind: 'frame' }>
    expect(frame.orientation?.pitchDeg).toBe(-10.123456789)
  })

  test('logs only every Nth frame when asked to', () => {
    const t = setup({ frameLogEvery: 3 })
    t.logger.begin(META, ORIGIN)
    for (let i = 0; i < 7; i++) t.logger.handle(frameAt(ORIGIN + 100 * (i + 1), i))
    expect(t.events().filter((e) => e.kind === 'frame').map((e) => (e as { frameId: number }).frameId)).toEqual([0, 3, 6])
  })

  test('samples the tilt about ten times a second and skips a reading it already logged', () => {
    const t = setup()
    t.logger.begin(META, ORIGIN)
    expect(t.timers[0].ms).toBe(CONFIG.telemetry.orientationSampleMs)
    t.tilt.sample = { pitchDeg: -9.87654, rollDeg: 1, timeMs: ORIGIN + 90 }
    t.clock.nowMs = ORIGIN + 100
    t.timers[0].callback()
    t.clock.nowMs = ORIGIN + 200
    t.timers[0].callback() // the sensor has not moved on
    t.tilt.sample = { pitchDeg: -9.5, rollDeg: 1, timeMs: ORIGIN + 190 }
    t.clock.nowMs = ORIGIN + 300
    t.timers[0].callback()
    expect(t.events().filter((e) => e.kind === 'orientation')).toMatchObject([
      { timeMs: 100, sample: { pitchDeg: -9.877, timeMs: 90 } },
      { timeMs: 300, sample: { pitchDeg: -9.5, timeMs: 190 } },
    ])
  })

  test('keeps track snapshots to a few a second and logs the empty scene once', () => {
    const t = setup()
    t.logger.begin(META, ORIGIN)
    const snapshot = (ms: number, tracks: Track[]): TelemetryEvent => ({ kind: 'tracks', timeMs: ORIGIN + ms, frameId: ms, tracks })
    t.logger.handle(snapshot(100, []))
    t.logger.handle(snapshot(200, [trackAt(1)]))
    t.logger.handle(snapshot(300, [trackAt(1)]))
    t.logger.handle(snapshot(800, [trackAt(1)]))
    t.logger.handle(snapshot(900, []))
    t.logger.handle(snapshot(1000, []))
    const logged = t.events().filter((e) => e.kind === 'tracks') as Extract<TelemetryEvent, { kind: 'tracks' }>[]
    expect(logged.map((e) => [e.timeMs, e.tracks.length])).toEqual([
      [200, 1],
      [800, 1],
      [900, 0],
    ])
    expect(logged[0].tracks[0]).toMatchObject({ distanceM: 2.123, firstSeenMs: 100, lastSeenMs: 200 })
  })

  test('keeps health changes, not every report', () => {
    const t = setup()
    t.logger.begin(META, ORIGIN)
    const health = (status: HealthState['status'], fps: number, issues: HealthState['issues'] = []): TelemetryEvent => ({
      kind: 'health',
      timeMs: ORIGIN + 10,
      health: { status, issues, fps, lastFrameAgeMs: 0, backend: 'webgpu', paused: false, updatedTimeMs: ORIGIN + 10 },
    })
    t.logger.handle(health('healthy', 12))
    t.logger.handle(health('healthy', 11))
    t.logger.handle(health('degraded', 4, ['low-fps']))
    t.logger.handle(health('degraded', 3, ['low-fps']))
    t.logger.handle(health('healthy', 12))
    expect(t.events().filter((e) => e.kind === 'health').map((e) => (e as { health: HealthState }).health.status)).toEqual([
      'healthy',
      'degraded',
      'healthy',
    ])
  })

  test('a new begin discards the old log', () => {
    const t = setup()
    t.logger.begin(META, ORIGIN)
    t.logger.handle(frameAt(ORIGIN + 100))
    t.logger.begin(META, ORIGIN + 5000)
    expect(t.events().map((e) => e.kind)).toEqual(['session', 'run-state'])
  })
})

describe('the memory cap', () => {
  test('warns when the log nears the cap, then stops recording at the cap with a closing entry', () => {
    const t = setup({ maxBytes: 6000, warnAtFraction: 0.5 })
    t.logger.begin(META, ORIGIN, {})
    let notified = 0
    t.logger.subscribe(() => notified++)
    let i = 0
    while (t.logger.getView().status === 'recording' && i < 100) t.logger.handle(frameAt(ORIGIN + 100 * ++i, i))
    expect(t.logger.getView().status).toBe('near-full')
    expect(t.logger.getView().message).toMatch(/almost full/)
    while (t.logger.getView().status === 'near-full' && i < 100) t.logger.handle(frameAt(ORIGIN + 100 * ++i, i))
    expect(t.logger.getView().status).toBe('full')
    expect(t.logger.getView().message).toMatch(/full/)
    expect(t.logger.getView().hasLog).toBe(true)
    expect(notified).toBeGreaterThanOrEqual(2)

    const count = t.logger.getLines().length
    t.logger.handle(frameAt(ORIGIN + 99_999))
    expect(t.logger.getLines()).toHaveLength(count)
    expect(t.events().at(-1)).toMatchObject({ kind: 'error', source: 'telemetry' })
    expect(t.logger.getStats().bytes).toBeLessThan(6000 + 300)
    expect(t.timers[0].cleared).toBe(true)
  })

  test('the default cap is about 20 MB', () => {
    expect(CONFIG.telemetry.maxBytes).toBeGreaterThanOrEqual(15_000_000)
    expect(CONFIG.telemetry.maxBytes).toBeLessThanOrEqual(25_000_000)
  })
})
