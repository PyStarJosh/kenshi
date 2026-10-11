import { describe, expect, test, vi } from 'vitest'
import { EventBus } from '../alerts/bus'
import { CONFIG } from '../core/config'
import type { AlertEvent, EventMap, FindSnapshot, LocateResult, OrientationSample, Track } from '../core/types'
import { FIND_PHRASES } from '../find/phrases'
import type { Capture, LocateOutcome } from '../find/locateClient'
import { FindRunner } from './findRunner'

const foundResult = (frameIndex = 0, centerX = 0.5): LocateResult => ({
  found: true,
  frameIndex,
  box: { x0: centerX - 0.05, y0: 0.3, x1: centerX + 0.05, y1: 0.8 },
  label: 'chair',
  onFloor: true,
  distanceM: 3,
  confidence: 0.9,
  signHint: null,
  latencyMs: 900,
})
const notFoundResult: LocateResult = {
  found: false,
  frameIndex: null,
  box: null,
  label: '',
  onFloor: false,
  distanceM: null,
  confidence: 0,
  signHint: null,
  latencyMs: 900,
}

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    classId: 56,
    label: 'chair',
    status: 'confirmed',
    box: { x: 0.4, y: 0.5, width: 0.2, height: 0.3 },
    confidence: 0.9,
    recentHits: 3,
    firstSeenMs: 0,
    lastSeenMs: 0,
    clock: { position: 12, angleDeg: 0 },
    distanceM: 2.5,
    distanceSource: 'ground-plane',
    distanceGroundM: 2.5,
    distanceBoxM: null,
    elevation: 'body',
    inPath: true,
    approaching: false,
    closingSpeedMps: null,
    timeToContactS: null,
    ...overrides,
  }
}

function setup() {
  const bus = new EventBus<EventMap>()
  const alerts: AlertEvent[] = []
  const snapshots: FindSnapshot[] = []
  bus.subscribe('alert', (alert) => alerts.push(alert))
  bus.subscribe('find', (snapshot) => snapshots.push(snapshot))

  const state = {
    nowMs: 1000,
    heading: 0 as number | null,
    pitch: -5,
    running: true,
    tracks: [] as Track[],
    canLocate: true,
    outcome: { ok: true, result: foundResult() } as LocateOutcome,
    /** Answers to give to the next calls, in order, before falling back to `outcome`. */
    script: [] as LocateOutcome[],
    ticks: 0,
    /** The phone turns this many degrees while a frame is being grabbed. */
    turnDuringGrab: 0,
    bitmaps: [] as { close: ReturnType<typeof vi.fn> }[],
    /** What the path line says about the way ahead (R7). */
    pathDecision: null as 'left' | 'right' | 'straight' | null,
  }
  const calls: { target: string; captures: Capture[]; paced: boolean }[] = []
  const sample = (): OrientationSample => ({
    pitchDeg: state.pitch,
    rollDeg: 0,
    ...(state.heading === null ? {} : { headingDeg: state.heading }),
    timeMs: state.nowMs,
  })
  let timer: (() => void) | null = null
  const runner = new FindRunner({
    bus,
    orientationAt: () => sample(),
    orientationLatest: () => sample(),
    isRunning: () => state.running,
    getTracks: () => state.tracks,
    getPathDecision: () => state.pathDecision,
    getSettings: () => ({ eyeHeightM: 1.6, horizontalFovDeg: 65 }),
    grab: async () => {
      const bitmap = { width: 1280, height: 720, close: vi.fn() }
      state.bitmaps.push(bitmap)
      if (state.heading !== null) state.heading += state.turnDuringGrab
      return bitmap as unknown as ImageBitmap
    },
    locator: {
      locate: async (target, captures, options) => {
        calls.push({ target, captures: [...captures], paced: options?.paced ?? true })
        const scripted = state.script.shift()
        return scripted ?? state.outcome
      },
      canLocate: () => state.canLocate,
    },
    now: () => state.nowMs,
    tick: () => {
      state.ticks += 1
    },
    setTimer: (callback) => {
      timer = callback
      return 'timer'
    },
    clearTimer: () => {
      timer = null
    },
  })
  const detach = runner.attach()
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  /** One detected frame: the controller is ticked once per frame. */
  const frame = async (advanceMs = 300) => {
    state.nowMs += advanceMs
    bus.publish('tracks', state.tracks)
    await flush()
  }
  return { bus, runner, state, alerts, snapshots, calls, detach, flush, frame, hasTimer: () => timer !== null }
}

describe('a search from the quick-pick list or a voice command', () => {
  test('the request on the bus speaks the notice and the target, then makes one locate call with the frame, heading and pitch', async () => {
    const t = setup()
    t.state.heading = 40
    t.bus.publish('findRequest', { target: 'Chair', source: 'list' })
    await t.flush()
    expect(t.alerts[0]).toMatchObject({
      kind: 'find',
      priority: 'normal',
      pan: null,
      trackId: null,
      phrase: 'Looking for a chair.',
    })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].target).toBe('chair')
    expect(t.calls[0].captures).toHaveLength(1)
    expect(t.calls[0].captures[0]).toMatchObject({ heading: 40, pitch: -5 })
  })

  test('a found answer speaks the direction and starts guiding; the snapshot is published on the bus', async () => {
    const t = setup()
    t.bus.publish('findRequest', { target: 'chair', source: 'list' })
    await t.flush()
    expect(t.alerts.at(-1)?.phrase).toBe('Chair found, ahead.')
    expect(t.runner.getSnapshot()).toMatchObject({ state: 'guiding', target: 'chair', source: 'gemini' })
    expect(t.snapshots.map((s) => s.state)).toEqual(['checking', 'guiding'])
    expect(t.runner.isActive()).toBe(true)
  })

  test('the frame bitmap is closed once the call is done', async () => {
    const t = setup()
    t.bus.publish('findRequest', { target: 'chair', source: 'list' })
    await t.flush()
    expect(t.state.bitmaps).toHaveLength(1)
    expect(t.state.bitmaps[0].close).toHaveBeenCalledTimes(1)
  })

  test('a target the detector already sees skips the network', async () => {
    const t = setup()
    t.state.tracks = [track({ clock: { position: 12, angleDeg: 0 }, distanceM: 3 })]
    t.runner.request('Chair')
    await t.flush()
    expect(t.calls).toHaveLength(0)
    expect(t.runner.getSnapshot()).toMatchObject({ state: 'guiding', source: 'yolo' })
    expect(t.alerts.at(-1)?.phrase).toBe('Chair found, ahead.')
  })

  test('offline: says Find is not available, then goes idle', async () => {
    const t = setup()
    t.state.outcome = { ok: false, error: 'network', message: 'x', retryAfterMs: null }
    t.runner.request('chair')
    await t.flush()
    expect(t.alerts.at(-1)?.phrase).toBe(FIND_PHRASES.unavailable)
    expect(t.runner.getSnapshot().state).toBe('error')
    await t.frame(CONFIG.find.resultHoldMs + 100)
    expect(t.runner.getSnapshot().state).toBe('idle')
    expect(t.runner.isActive()).toBe(false)
  })
})

describe('the sweep', () => {
  const miss: LocateOutcome = { ok: true, result: notFoundResult }

  async function startSweep(t: ReturnType<typeof setup>) {
    t.state.outcome = miss
    t.runner.request('exit')
    await t.flush()
    expect(t.runner.getSnapshot().state).toBe('sweeping')
  }

  async function turnAround(t: ReturnType<typeof setup>) {
    for (let heading = 45; heading <= 360; heading += 45) {
      t.state.heading = heading
      await t.frame()
    }
  }

  test('each 45 degrees takes a frame with a tick and sends it at once as its own look', async () => {
    const t = setup()
    await startSweep(t)
    await turnAround(t)
    expect(t.state.ticks).toBe(8)
    expect(t.calls).toHaveLength(9) // the first look, then one look per frame
    for (const call of t.calls.slice(1)) {
      expect(call.captures).toHaveLength(1)
      expect(call.paced).toBe(false) // sweep looks skip the gap between calls
    }
    expect(t.calls[0].paced).toBe(true)
    expect(t.calls.slice(1).map((c) => c.captures[0].heading)).toEqual([45, 90, 135, 180, 225, 270, 315, 360])
    expect(t.runner.getSnapshot().state).toBe('notFound')
  })

  test('every bitmap is closed once its look is done', async () => {
    const t = setup()
    await startSweep(t)
    await turnAround(t)
    expect(t.state.bitmaps).toHaveLength(9)
    for (const bitmap of t.state.bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  test('the first look that finds it ends the search: no more frames are sent', async () => {
    const t = setup()
    t.state.script = [miss, miss, { ok: true, result: foundResult(0, 0.5) }]
    t.runner.request('exit')
    await t.flush()
    for (const heading of [45, 90]) {
      t.state.heading = heading
      await t.frame()
    }
    expect(t.runner.getSnapshot().state).toBe('guiding')
    expect(t.alerts.at(-1)?.phrase).toBe('Exit found, ahead.')
    const sent = t.calls.length
    t.state.heading = 135
    await t.frame()
    expect(t.calls).toHaveLength(sent) // nothing more goes to Gemini
  })

  test('a frame is not sent if the search was cancelled while it was being grabbed', async () => {
    const t = setup()
    await startSweep(t)
    t.state.heading = 50
    t.state.nowMs += 300
    t.bus.publish('tracks', []) // the capture starts...
    t.runner.cancel() // ...and the user cancels before it finishes
    await t.flush()
    expect(t.calls).toHaveLength(1) // only the first look
    for (const bitmap of t.state.bitmaps) expect(bitmap.close).toHaveBeenCalled()
  })

  test('staring after a turn takes one fresh look, also without waiting for the gap', async () => {
    const t = setup()
    t.state.outcome = miss
    t.runner.request('exit')
    await t.flush()
    expect(t.calls).toHaveLength(1)
    t.state.heading = 30 // less than a sweep step: no frame yet
    await t.frame(100)
    expect(t.calls).toHaveLength(1)
    await t.frame(CONFIG.find.sweepDwellMs + 200)
    expect(t.calls).toHaveLength(2)
    expect(t.calls[1].captures).toHaveLength(1)
    expect(t.calls[1].captures[0].heading).toBe(30)
    expect(t.calls[1].paced).toBe(false)
    expect(t.runner.getSnapshot().state).toBe('sweeping')
  })

  test('cancelling mid-sweep leaves nothing open and says Find stopped', async () => {
    const t = setup()
    await startSweep(t)
    t.state.heading = 50
    await t.frame()
    t.state.heading = 100
    await t.frame()
    t.runner.cancel()
    await t.flush()
    expect(t.runner.getSnapshot().state).toBe('idle')
    expect(t.alerts.at(-1)?.phrase).toBe(FIND_PHRASES.stopped)
    expect(t.state.bitmaps).toHaveLength(3) // the first look and two sweep frames
    for (const bitmap of t.state.bitmaps) expect(bitmap.close).toHaveBeenCalled()
  })
})

describe('reliability', () => {
  test('the heading a frame is sent with is the one from when the grab started, not after the phone moved on', async () => {
    const t = setup()
    t.state.heading = 40
    t.state.turnDuringGrab = 30
    t.runner.request('chair')
    await t.flush()
    expect(t.calls[0].captures[0].heading).toBe(40)
  })

  test('with two chairs in view it keeps to the one it started with, even when the other becomes the nearer', async () => {
    const t = setup()
    const first = track({ id: 1, distanceM: 3, clock: { position: 12, angleDeg: 0 } })
    const second = track({ id: 2, distanceM: 4, clock: { position: 1, angleDeg: 30 } })
    t.state.tracks = [first, second]
    t.runner.request('chair')
    await t.flush()
    expect(t.runner.getSnapshot()).toMatchObject({ state: 'guiding', source: 'yolo', bearingDeg: 0 })
    t.state.tracks = [track({ id: 1, distanceM: 3.5, clock: { position: 12, angleDeg: 2 } }), track({ id: 2, distanceM: 2, clock: { position: 1, angleDeg: 30 } })]
    await t.frame()
    expect(t.runner.getSnapshot().bearingDeg).toBe(2) // still the first chair
  })

  test('a hiccup on the first check is retried quietly and the search goes on', async () => {
    const t = setup()
    t.state.script = [{ ok: false, error: 'network', message: 'x', retryAfterMs: null }, { ok: true, result: foundResult() }]
    t.runner.request('chair')
    await t.flush()
    expect(t.calls).toHaveLength(2)
    expect(t.calls[0].paced).toBe(true)
    expect(t.calls[1].paced).toBe(false)
    expect(t.runner.getSnapshot().state).toBe('guiding')
    expect(t.alerts.map((a) => a.phrase)).not.toContain(FIND_PHRASES.unavailable)
  })
})

describe('guiding', () => {
  test('re-checks only when the limiter allows', async () => {
    const t = setup()
    t.runner.request('chair')
    await t.flush()
    t.state.canLocate = false
    await t.frame(CONFIG.find.recheckIntervalMs + 100)
    expect(t.calls).toHaveLength(1)
    t.state.canLocate = true
    await t.frame(100)
    expect(t.calls).toHaveLength(2)
  })

  test('the long-lived timer also ticks the controller, so timers run on a still camera', async () => {
    const t = setup()
    expect(t.hasTimer()).toBe(true)
    t.state.outcome = { ok: false, error: 'network', message: 'x', retryAfterMs: null }
    t.runner.request('chair')
    await t.flush()
    expect(t.runner.getSnapshot().state).toBe('error')
  })
})

describe('stopping', () => {
  test('when detection stops or pauses, the search is cancelled at the next tick', async () => {
    const t = setup()
    t.runner.request('chair')
    await t.flush()
    t.state.running = false
    await t.frame()
    expect(t.runner.getSnapshot().state).toBe('idle')
  })

  test('a cancel request on the bus stops it', async () => {
    const t = setup()
    t.runner.request('chair')
    await t.flush()
    t.bus.publish('findCancel', undefined)
    expect(t.runner.getSnapshot().state).toBe('idle')
  })

  test('an answer that arrives after cancelling is ignored', async () => {
    const t = setup()
    let release: (outcome: LocateOutcome) => void = () => {}
    const slow = new FindRunner({
      bus: t.bus,
      orientationAt: () => ({ pitchDeg: 0, rollDeg: 0, headingDeg: 0, timeMs: 0 }),
      orientationLatest: () => ({ pitchDeg: 0, rollDeg: 0, headingDeg: 0, timeMs: 0 }),
      isRunning: () => true,
      getTracks: () => [],
      getSettings: () => ({ eyeHeightM: 1.6, horizontalFovDeg: 65 }),
      grab: async () => ({ width: 640, height: 360, close: () => {} }) as unknown as ImageBitmap,
      locator: { locate: () => new Promise<LocateOutcome>((resolve) => (release = resolve)), canLocate: () => true },
      now: () => 1000,
      tick: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    })
    slow.request('chair')
    await t.flush()
    slow.cancel()
    release({ ok: true, result: foundResult() })
    await t.flush()
    expect(slow.getSnapshot().state).toBe('idle')
  })

  test('detaching cancels and removes the timer and the bus listeners', async () => {
    const t = setup()
    t.runner.request('chair')
    await t.flush()
    t.detach()
    expect(t.hasTimer()).toBe(false)
    expect(t.runner.getSnapshot().state).toBe('idle')
    t.bus.publish('findRequest', { target: 'door', source: 'voice' })
    await t.flush()
    expect(t.runner.getSnapshot().state).toBe('idle')
  })
})

describe('the path line (R7)', () => {
  async function guide(t: ReturnType<typeof setup>, centerX: number) {
    t.state.outcome = { ok: true, result: foundResult(0, centerX) }
    t.runner.request('chair')
    await t.flush()
    expect(t.runner.getSnapshot().state).toBe('guiding')
  }

  test('straight ahead, a path that bends left makes the instruction "Bear left around the obstacle"', async () => {
    const t = setup()
    await guide(t, 0.5)
    t.state.pathDecision = 'left'
    await t.frame(CONFIG.find.guideSpeechCooldownMs + 500)
    expect(t.alerts.at(-1)?.phrase).toBe('Bear left around the obstacle.')
  })

  test('and right for a path that bends right', async () => {
    const t = setup()
    await guide(t, 0.5)
    t.state.pathDecision = 'right'
    await t.frame(CONFIG.find.guideSpeechCooldownMs + 500)
    expect(t.alerts.at(-1)?.phrase).toBe('Bear right around the obstacle.')
  })

  test('a straight path or no opinion changes nothing', async () => {
    const t = setup()
    await guide(t, 0.5)
    const before = t.alerts.length
    t.state.pathDecision = 'straight'
    await t.frame(CONFIG.find.guideSpeechCooldownMs + 500)
    t.state.pathDecision = null
    await t.frame(CONFIG.find.guideSpeechCooldownMs + 500)
    // (a distance countdown may still come; no instruction does)
    expect(t.alerts.slice(before).map((a) => a.phrase).filter((p) => /Bear|Turn|Straight|obstacle/.test(p))).toEqual([])
  })

  test('only while roughly aligned: with the target well off to one side the turn comes first', async () => {
    const t = setup()
    await guide(t, 0.9) // about 26 degrees to the right, past pathAlignedDeg
    t.state.pathDecision = 'left'
    await t.frame(CONFIG.find.guideSpeechCooldownMs + 500)
    expect(t.alerts.map((a) => a.phrase).some((p) => p.includes('obstacle'))).toBe(false)
  })

  test('the target column steers the path: 0.5 plus bearing over field of view, only while guiding', async () => {
    const t = setup()
    expect(t.runner.getTargetColumn()).toBeNull()
    await guide(t, 0.75) // 16.25 degrees right of straight ahead on a 65 degree lens
    expect(t.runner.getTargetColumn()).toBeCloseTo(0.75, 6)
    t.state.heading = 90 // turned right away from it: out of view
    expect(t.runner.getTargetColumn()).toBeNull()
    t.state.heading = 0
    t.runner.cancel()
    expect(t.runner.getTargetColumn()).toBeNull()
  })
})
