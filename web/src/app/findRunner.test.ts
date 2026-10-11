import { describe, expect, test, vi } from 'vitest'
import { EventBus } from '../alerts/bus'
import { CONFIG } from '../core/config'
import type { AlertEvent, EventMap, FindSnapshot, LocateResult, OrientationSample, Track } from '../core/types'
import { FIND_PHRASES } from '../find/phrases'
import type { Capture, LocateOutcome } from '../find/locateClient'
import { describeSnapshot, FindRunner } from './findRunner'

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
    ticks: 0,
    bitmaps: [] as { close: ReturnType<typeof vi.fn> }[],
  }
  const calls: { target: string; captures: Capture[] }[] = []
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
    getSettings: () => ({ eyeHeightM: 1.6, horizontalFovDeg: 65 }),
    grab: async () => {
      const bitmap = { width: 1280, height: 720, close: vi.fn() }
      state.bitmaps.push(bitmap)
      return bitmap as unknown as ImageBitmap
    },
    locator: {
      locate: async (target, captures) => {
        calls.push({ target, captures: [...captures] })
        return state.outcome
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
      phrase: `${FIND_PHRASES.privacy} Looking for a chair.`,
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
  async function sweepAround(t: ReturnType<typeof setup>) {
    t.state.outcome = { ok: true, result: notFoundResult }
    t.runner.request('exit')
    await t.flush()
    expect(t.runner.getSnapshot().state).toBe('sweeping')
    for (let heading = 45; heading <= 360; heading += 45) {
      t.state.heading = heading
      await t.frame()
    }
  }

  test('captures a frame with a tick for each 45 degrees and sends all 8 in one call', async () => {
    const t = setup()
    await sweepAround(t)
    expect(t.state.ticks).toBe(8)
    expect(t.calls).toHaveLength(2) // the first look, then the sweep
    expect(t.calls[1].captures).toHaveLength(8)
    expect(t.calls[1].captures.map((c) => c.heading)).toEqual([45, 90, 135, 180, 225, 270, 315, 360])
    expect(t.runner.getSnapshot().state).toBe('notFound')
  })

  test('every bitmap is closed after the sweep call', async () => {
    const t = setup()
    await sweepAround(t)
    expect(t.state.bitmaps).toHaveLength(9) // one for the look, eight for the sweep
    for (const bitmap of t.state.bitmaps) expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  test('the last frame is in the call even though capturing is asynchronous', async () => {
    const t = setup()
    t.state.outcome = { ok: true, result: notFoundResult }
    t.runner.request('exit')
    await t.flush()
    for (let heading = 45; heading <= 360; heading += 45) {
      t.state.heading = heading
      t.state.nowMs += 300
      t.bus.publish('tracks', []) // no await between frames
    }
    await t.flush()
    expect(t.calls.at(-1)?.captures).toHaveLength(8)
  })

  test('cancelling mid-sweep closes the held frames and says Find stopped', async () => {
    const t = setup()
    t.state.outcome = { ok: true, result: notFoundResult }
    t.runner.request('exit')
    await t.flush()
    t.state.heading = 50
    await t.frame()
    t.state.heading = 100
    await t.frame()
    t.runner.cancel()
    await t.flush()
    expect(t.runner.getSnapshot().state).toBe('idle')
    expect(t.alerts.at(-1)?.phrase).toBe(FIND_PHRASES.stopped)
    // The look's bitmap and the two sweep bitmaps: all closed.
    expect(t.state.bitmaps).toHaveLength(3)
    for (const bitmap of t.state.bitmaps) expect(bitmap.close).toHaveBeenCalled()
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

describe('describeSnapshot', () => {
  test('a short line for each state', () => {
    const base: FindSnapshot = { state: 'idle', target: null, bearingDeg: null, distanceM: null, source: null }
    expect(describeSnapshot(base)).toBe('')
    expect(describeSnapshot({ ...base, state: 'checking', target: 'chair' })).toBe('Looking for chair...')
    expect(describeSnapshot({ ...base, state: 'guiding', target: 'chair', bearingDeg: -20 })).toBe('chair: 20 degrees left.')
    expect(describeSnapshot({ ...base, state: 'guiding', target: 'chair', bearingDeg: 30 })).toBe('chair: 30 degrees right.')
    expect(describeSnapshot({ ...base, state: 'error', target: 'chair' })).toBe("Find isn't available right now.")
    for (const state of ['sweeping', 'sweepChecking', 'lost', 'arrived', 'notFound'] as const) {
      expect(describeSnapshot({ ...base, state, target: 'chair' })).not.toBe('')
    }
  })
})
