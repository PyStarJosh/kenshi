// The whole guiding chain, wired the way the app wires it: the Find runner publishes the snapshot on the bus, the beacon
// driver follows it, and the real Beacon schedules pulses on a (fake) AudioContext. This catches wiring mistakes that the
// unit tests of each piece cannot see.
import { describe, expect, test, vi } from 'vitest'
import { EventBus } from '../alerts/bus'
import { Beacon } from '../audio/beacon'
import type { EventMap, OrientationSample, Track } from '../core/types'
import { BeaconDriver } from './beaconDriver'
import { FindRunner } from './findRunner'

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    classId: 56,
    label: 'chair',
    status: 'confirmed',
    box: { x: 0.4, y: 0.3, width: 0.2, height: 0.3 },
    confidence: 0.9,
    recentHits: 3,
    firstSeenMs: 0,
    lastSeenMs: 0,
    clock: { position: 12, angleDeg: 0 },
    distanceM: 6,
    distanceSource: 'ground-plane',
    distanceGroundM: 6,
    distanceBoxM: null,
    elevation: 'body',
    inPath: true,
    approaching: false,
    closingSpeedMps: null,
    timeToContactS: null,
    ...overrides,
  }
}

function build() {
  const bus = new EventBus<EventMap>()
  const state = {
    nowMs: 1000,
    heading: 0 as number | null,
    tracks: [track()] as Track[],
    busy: false,
    urgent: false,
  }
  const starts: { hz: number; at: number }[] = []
  let ctxTime = 0
  let ctxState = 'running'
  const resumeCalls = { count: 0, autoResume: false }
  let wake: (() => void) | null = null
  const ctx = {
    get currentTime() {
      return ctxTime
    },
    get state() {
      return ctxState
    },
    setState(next: string) {
      ctxState = next
    },
    resume() {
      resumeCalls.count += 1
      if (resumeCalls.autoResume) ctxState = 'running'
      return Promise.resolve()
    },
    destination: {},
    createGain: () => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createOscillator: () => {
      const osc = { hz: 0 }
      return {
        frequency: { setValueAtTime: (hz: number) => (osc.hz = hz) },
        connect: vi.fn(),
        start: (at: number) => starts.push({ hz: osc.hz, at }),
        stop: vi.fn(),
        onended: null,
      }
    },
    createStereoPanner: () => ({ pan: { setValueAtTime: vi.fn() }, connect: vi.fn() }),
  }
  const beacon = new Beacon({
    ctx: ctx as unknown as AudioContext,
    speaker: { isBusy: () => state.busy, isUrgent: () => state.urgent },
    volume: () => 0.8,
    resume: () => void ctx.resume(),
    now: () => state.nowMs,
    setTimer: (callback) => {
      wake = callback
      return 1
    },
    clearTimer: () => {
      wake = null
    },
  })
  const sample = (): OrientationSample => ({
    pitchDeg: -5,
    rollDeg: 0,
    ...(state.heading === null ? {} : { headingDeg: state.heading }),
    timeMs: state.nowMs,
  })
  const runner = new FindRunner({
    bus,
    orientationAt: () => sample(),
    orientationLatest: () => sample(),
    isRunning: () => true,
    getTracks: () => state.tracks,
    getSettings: () => ({ eyeHeightM: 1.6, horizontalFovDeg: 65 }),
    grab: async () => ({ width: 1280, height: 720, close: () => {} }) as unknown as ImageBitmap,
    locator: { locate: async () => ({ ok: false, error: 'network', message: 'x', retryAfterMs: null }), canLocate: () => true },
    now: () => state.nowMs,
    tick: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  })
  runner.attach()
  new BeaconDriver(bus, () => beacon).attach()
  /** One step of real time: the detector publishes tracks (ticking the runner) and the audio scheduler wakes up. */
  const step = (ms: number) => {
    state.nowMs += ms
    if (ctxState === 'running') ctxTime += ms / 1000 // a suspended or interrupted context's clock does not move
    bus.publish('tracks', state.tracks)
    wake?.()
  }
  return { bus, state, runner, beacon, starts, step, ctx, resumeCalls, running: () => wake !== null, time: () => ctxTime }
}

describe('guiding to a chair the detector sees', () => {
  test('the beacon starts and keeps pulsing for as long as the guiding lasts', () => {
    const t = build()
    t.runner.request('chair')
    expect(t.runner.getSnapshot().state).toBe('guiding')
    expect(t.beacon.isRunning()).toBe(true)
    for (let i = 0; i < 200; i++) t.step(25) // five seconds
    expect(t.runner.getSnapshot().state).toBe('guiding')
    expect(t.beacon.isRunning()).toBe(true)
    expect(t.starts.length).toBeGreaterThanOrEqual(4) // a pulse every ~0.6 s at 6 m
  })

  test('the pulses speed up as the chair gets closer', () => {
    const t = build()
    t.runner.request('chair')
    for (let i = 0; i < 80; i++) t.step(25)
    const far = t.starts.length
    t.state.tracks = [track({ distanceM: 1.5 })]
    const before = t.starts.length
    for (let i = 0; i < 80; i++) t.step(25)
    const near = t.starts.length - before
    expect(far).toBeGreaterThan(0)
    expect(near).toBeGreaterThan(far)
  })

  test('facing away gives the low double pulse', () => {
    const t = build()
    t.runner.request('chair')
    t.state.heading = 170 // the user has turned around: the chair is behind them, so the detector no longer sees it
    t.state.tracks = []
    for (let i = 0; i < 80; i++) t.step(25)
    const low = t.starts.filter((s) => s.hz === 330)
    expect(low.length).toBeGreaterThanOrEqual(2)
  })

  test('arriving plays the chime and stops the pulses', () => {
    const t = build()
    t.runner.request('chair')
    for (let i = 0; i < 40; i++) t.step(25)
    t.state.tracks = [track({ distanceM: 0.6 })]
    for (let i = 0; i < 80; i++) t.step(25)
    expect(t.runner.getSnapshot().state).toBe('arrived')
    expect(t.beacon.isRunning()).toBe(false)
    const chime = t.starts.filter((s) => [523.25, 659.25, 783.99].includes(s.hz))
    expect(chime).toHaveLength(3)
  })
})

describe('an AudioContext that iOS suspends or interrupts (the failure seen on the phone)', () => {
  test('nothing is queued on a clock that is not running, so there is no stray pulse when it comes back', () => {
    const t = build()
    t.ctx.setState('interrupted')
    t.runner.request('chair')
    for (let i = 0; i < 80; i++) t.step(25) // two seconds with the clock frozen at zero
    expect(t.starts.length).toBe(0)
  })

  test('the beacon asks for the context to be resumed by itself, and pulses once it is running, with no catch-up burst', () => {
    const t = build()
    t.ctx.setState('interrupted')
    t.runner.request('chair')
    for (let i = 0; i < 40; i++) t.step(25)
    expect(t.resumeCalls.count).toBeGreaterThan(0)
    t.resumeCalls.autoResume = true // the next resume() succeeds
    for (let i = 0; i < 80; i++) t.step(25)
    const afterResume = t.starts.length
    expect(afterResume).toBeGreaterThanOrEqual(2)
    expect(afterResume).toBeLessThanOrEqual(5) // a pulse every ~0.6 s at 6 m for two seconds, not a backlog
  })

  test('a chime for an arrival that happens while the context is interrupted still plays, after it resumes', async () => {
    const t = build()
    t.resumeCalls.autoResume = true
    t.runner.request('chair')
    for (let i = 0; i < 20; i++) t.step(25)
    t.ctx.setState('interrupted')
    t.state.tracks = [track({ distanceM: 0.6 })]
    for (let i = 0; i < 80; i++) t.step(25)
    expect(t.runner.getSnapshot().state).toBe('arrived')
    await Promise.resolve()
    await Promise.resolve()
    expect(t.starts.filter((s) => [523.25, 659.25, 783.99].includes(s.hz))).toHaveLength(3)
  })
})
