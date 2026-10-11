// A synthetic walk, run through the real pipeline and logger, to make a small test log with known ground truth.
// It is not a field recording: boxes come from the camera model in geometry.ts, with a little deterministic
// jitter. Used by the replay tests and by scripts/make-fixture.ts, which writes field-tests/fixture/.
import { AlertPolicy } from '../alerts/policy'
import { Pipeline } from '../app/pipeline'
import type { PipelineLink, PipelineSession } from '../app/pipeline'
import type { AlertTimes } from '../audio/engine'
import { CONFIG } from '../core/config'
import type { AlertEvent, AlertOutcome, FrameResult, HealthState, OrientationSample, Settings, TelemetryEvent, VoiceIntent } from '../core/types'
import { CLASSES } from '../detection/classes'
import { cameraModel } from '../geometry/geometry'
import { Tracker } from '../tracking/tracker'
import type { VoiceSource } from '../voice/control'
import { TelemetryLogger } from './logger'

export const FIXTURE_WALK_ID = 'walk-fixture'

const FRAME = { width: 1280, height: 720 }
const FRAME_GAP_MS = 83.25 // multiples of a quarter millisecond keep every time exact in binary
const ORIGIN_MS = 123_456.5
const PITCH_DEG = -10
const WALK_SPEED_MPS = 1.2
const SETTINGS: Settings = {
  eyeHeightM: 1.6,
  horizontalFovDeg: 65,
  speechRate: 1,
  spokenFeedback: true,
  toneVolume: 0.8,
  heartbeatVolume: 0.3,
  testMode: true,
}

export interface LabelRow {
  walk_id: string
  obstacle_id: string
  spoken_name: string
  t_visible_s: number
  t_reached_s: number
  in_path: 'yes' | 'no'
  notes: string
}

interface Obstacle {
  id: string
  classId: number
  heightM: number
  widthM: number
  lateralM: number
  /** Ground distance from the phone in meters at session time `tS` seconds. */
  distanceAt: (tS: number) => number
  /** Seen from here to here (seconds); the model loses an object nearer than minDistanceM. */
  fromS: number
  toS: number
}

const walkerAdvance = (tS: number) => WALK_SPEED_MPS * Math.min(tS, 4.2)

const OBSTACLES: Obstacle[] = [
  // A backpack on the floor, straight ahead; the walker stops for it at about 1 m.
  { id: 'backpack-1', classId: 24, heightM: 0.45, widthM: 0.35, lateralM: 0.1, distanceAt: (t) => 6 - walkerAdvance(t), fromS: 0, toS: 15 },
  // A chair at 1 o'clock, off the path.
  { id: 'chair-1', classId: 56, heightM: 0.9, widthM: 0.5, lateralM: 1.8, distanceAt: (t) => 4.5 - walkerAdvance(t) * 0.5, fromS: 5, toS: 15 },
  // A person walking toward the stationary walker, who stops 1.2 m away and stays there.
  { id: 'person-1', classId: 0, heightM: 1.7, widthM: 0.5, lateralM: 0.05, distanceAt: (t) => Math.max(1.2, 8 - 1.0 * (t - 6.5)), fromS: 6.5, toS: 17.5 },
]
const MIN_DISTANCE_M = 1
const MAX_DISTANCE_M = 5.5
const PAUSE_AT_S = 15
const RESUME_AT_S = 16
const END_S = 18

/** Deterministic noise in [-1, 1). */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

/** The pixel row of a point `drop` meters below the camera at ground distance d, for a camera pitched by PITCH_DEG. */
function rowOf(dropM: number, distanceM: number): number {
  const cam = cameraModel(FRAME, SETTINGS.horizontalFovDeg)
  const pitch = (PITCH_DEG * Math.PI) / 180
  const tan = dropM / distanceM
  const v = (tan * Math.cos(pitch) + Math.sin(pitch)) / (Math.cos(pitch) - tan * Math.sin(pitch))
  return cam.cy + cam.focalPx * v
}

function boxOf(o: Obstacle, distanceM: number, seed: number) {
  const cam = cameraModel(FRAME, SETTINGS.horizontalFovDeg)
  const bottom = rowOf(SETTINGS.eyeHeightM, distanceM) + noise(seed) * 2
  const top = rowOf(SETTINGS.eyeHeightM - o.heightM, distanceM) + noise(seed + 1) * 2
  const widthPx = (cam.focalPx * o.widthM) / distanceM
  const centerPx = cam.cx + (cam.focalPx * o.lateralM) / distanceM + noise(seed + 2) * 2
  const x0 = Math.max(0, centerPx - widthPx / 2)
  const x1 = Math.min(FRAME.width, centerPx + widthPx / 2)
  const y0 = Math.max(0, top)
  const y1 = Math.min(FRAME.height, bottom)
  return { x: x0 / FRAME.width, y: y0 / FRAME.height, width: (x1 - x0) / FRAME.width, height: (y1 - y0) / FRAME.height }
}

export interface FixtureWalk {
  lines: string[]
  events: TelemetryEvent[]
  labels: LabelRow[]
}

/** Run the synthetic walk and return the log it produced, plus ground-truth labels for the evaluation script. */
export function simulateWalk(): FixtureWalk {
  let clock = ORIGIN_MS
  const timers: { at: number; run: () => void; every?: number }[] = []
  const schedule = (at: number, run: () => void, every?: number) => timers.push({ at, run, every })
  // Fire every due timer in time order, with the clock set to its moment.
  const advanceTo = (target: number) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > target) break
      clock = Math.max(clock, next.at)
      if (next.every !== undefined) next.at += next.every
      else timers.shift()
      next.run()
    }
    clock = Math.max(clock, target)
  }

  const run: { state: 'idle' | 'starting' | 'running' | 'paused' } = { state: 'running' }
  let tilt: OrientationSample | null = null
  const resultListeners = new Set<(r: FrameResult) => void>()
  const stateListeners = new Set<() => void>()
  const session: PipelineSession = {
    onResult: (l) => (resultListeners.add(l), () => resultListeners.delete(l)),
    subscribe: (l) => (stateListeners.add(l), () => stateListeners.delete(l)),
    getSnapshot: () => ({ state: run.state }),
    getOrientationAt: () => tilt,
  }
  const setState = (next: typeof run.state) => {
    run.state = next
    stateListeners.forEach((l) => l())
  }

  type Outcome = (alert: AlertEvent, outcome: AlertOutcome, latencyMs: number | null, times?: AlertTimes) => void
  const outcomeListeners = new Set<Outcome>()
  const healthListeners = new Set<(h: HealthState) => void>()
  const voiceListeners = new Set<(i: VoiceIntent, s: VoiceSource) => void>()
  const link: PipelineLink = {
    // A phone that answers in the usual way: tone about 100 ms after the alert, speech 200 ms later.
    handleAlert(alert) {
      const toneStartMs = clock + 100
      const speechStartMs = toneStartMs + 200
      const finishMs = speechStartMs + alert.phrase.length * 65
      schedule(toneStartMs, () => outcomeListeners.forEach((l) => l(alert, 'started', toneStartMs - alert.frameTimeMs, { toneStartMs, speechStartMs: null })))
      schedule(finishMs, () => outcomeListeners.forEach((l) => l(alert, 'finished', null, { toneStartMs, speechStartMs })))
    },
    setSummarizer() {},
    setTrackLookup() {},
    recordFrame() {},
    onVoiceIntent: () => () => {},
    onAlertOutcome: (l) => (outcomeListeners.add(l), () => outcomeListeners.delete(l)),
    onHealth: (l) => (healthListeners.add(l), () => healthListeners.delete(l)),
    onVoice: (l) => (voiceListeners.add(l), () => voiceListeners.delete(l)),
  }

  const pipeline = new Pipeline({
    session,
    link,
    tracker: new Tracker(CLASSES),
    policy: new AlertPolicy(CLASSES),
    getSettings: () => SETTINGS,
    now: () => clock,
  })
  const logger = new TelemetryLogger({
    now: () => clock,
    getOrientation: () => tilt,
    setTimer: (callback, ms) => {
      const entry = { at: clock + ms, run: callback, every: ms }
      timers.push(entry)
      return entry
    },
    clearTimer: (handle) => {
      const i = timers.indexOf(handle as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    },
  })
  pipeline.bus.subscribe('telemetry', (event) => logger.handle(event))
  pipeline.attach()

  tilt = { pitchDeg: PITCH_DEG, rollDeg: 0, timeMs: clock }
  logger.begin(
    {
      appVersion: 'fixture',
      gitCommit: 'fixture',
      model: 'yolo26n-416.onnx',
      provider: 'auto',
      backend: 'webgpu',
      inputSize: 416,
      crossOriginIsolated: true,
      settings: SETTINGS,
      device: {
        userAgent: 'synthetic fixture (not a field recording)',
        platform: 'fixture',
        language: 'en',
        hardwareConcurrency: null,
        deviceMemoryGb: null,
        screenWidth: 1179,
        screenHeight: 2556,
        devicePixelRatio: 3,
      },
    },
    ORIGIN_MS,
    JSON.parse(JSON.stringify(CONFIG)),
  )
  const health = (status: HealthState['status'], paused: boolean): HealthState => ({
    status,
    issues: [],
    fps: 12,
    lastFrameAgeMs: 0,
    backend: 'webgpu',
    paused,
    updatedTimeMs: clock,
  })
  healthListeners.forEach((l) => l(health('healthy', false)))

  const labels: LabelRow[] = []
  const seen = new Map<string, { first: number; last: number }>()
  const frameCount = Math.floor((END_S * 1000) / FRAME_GAP_MS)
  let frameId = 0
  for (let k = 1; k <= frameCount; k++) {
    const sessionMs = k * FRAME_GAP_MS
    const tS = sessionMs / 1000
    const captureMs = ORIGIN_MS + sessionMs
    advanceTo(captureMs)
    if (tS >= PAUSE_AT_S && tS < RESUME_AT_S && run.state === 'running') {
      voiceListeners.forEach((l) => l('pause', 'long-press'))
      setState('paused')
      healthListeners.forEach((l) => l(health('stopped', true)))
    }
    if (tS >= RESUME_AT_S && run.state === 'paused') {
      voiceListeners.forEach((l) => l('resume', 'long-press'))
      setState('starting')
      setState('running')
      healthListeners.forEach((l) => l(health('healthy', false)))
    }
    if (run.state !== 'running') continue

    tilt = { pitchDeg: PITCH_DEG + noise(k * 7) * 1.5, rollDeg: noise(k * 11) * 1, timeMs: captureMs }
    const detections = OBSTACLES.flatMap((o, i) => {
      if (tS < o.fromS || tS > o.toS) return []
      const d = o.distanceAt(tS)
      if (d < MIN_DISTANCE_M || d > MAX_DISTANCE_M) return []
      const range = seen.get(o.id)
      seen.set(o.id, { first: range?.first ?? tS, last: tS })
      return [
        {
          classId: o.classId,
          label: CLASSES[o.classId].label,
          confidence: 0.8 + noise(k * 3 + i) * 0.1,
          box: boxOf(o, d, k * 5 + i * 1000),
        },
      ]
    })
    const inferenceMs = 38 + noise(k) * 6
    const result: FrameResult = {
      frameId: frameId++,
      captureTimeMs: captureMs,
      receivedTimeMs: captureMs + inferenceMs + 12,
      frameWidth: FRAME.width,
      frameHeight: FRAME.height,
      inputSize: 416,
      backend: 'webgpu',
      timings: { preprocessMs: 6, inferenceMs, postprocessMs: 2 },
      meanLuma: 0.42,
      detections,
    }
    advanceTo(result.receivedTimeMs)
    resultListeners.forEach((l) => l(result))
  }
  advanceTo(ORIGIN_MS + END_S * 1000 + 3000)
  logger.stop()

  const reached: Record<string, number> = { 'backpack-1': 4.2, 'chair-1': 9, 'person-1': 13.3 }
  for (const o of OBSTACLES) {
    const range = seen.get(o.id)
    if (!range) continue
    const name = CLASSES[o.classId].spokenName
    labels.push({
      walk_id: FIXTURE_WALK_ID,
      obstacle_id: o.id,
      spoken_name: name,
      t_visible_s: Number(range.first.toFixed(1)),
      t_reached_s: reached[o.id],
      in_path: o.lateralM < 0.5 ? 'yes' : 'no',
      notes: 'synthetic',
    })
  }
  const lines = [...logger.getLines()]
  return { lines, events: lines.map((l) => JSON.parse(l) as TelemetryEvent), labels }
}
