import { describe, expect, test } from 'vitest'
import { EventBus } from '../alerts/bus'
import type { TrackLookup } from '../audio/engine'
import type {
  AlertEvent,
  AlertOutcome,
  EventMap,
  FindRequest,
  FrameResult,
  FreeSpaceResult,
  HealthState,
  OrientationSample,
  Track,
  VoiceIntent,
} from '../core/types'
import { CONFIG } from '../core/config'
import { Pipeline } from './pipeline'
import type { PipelineLink, PipelineSession, PipelineTracker } from './pipeline'
import type { SessionState } from './session'


function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    classId: 1,
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

const frame = (captureTimeMs: number) => ({ frameId: captureTimeMs, captureTimeMs }) as FrameResult

class FakeSession implements PipelineSession {
  state: SessionState = 'running'
  tiltRequests: number[] = []
  private results = new Set<(result: FrameResult) => void>()
  private listeners = new Set<() => void>()

  onResult(listener: (result: FrameResult) => void) {
    this.results.add(listener)
    return () => this.results.delete(listener)
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot() {
    return { state: this.state }
  }
  getOrientationAt(timeMs: number): OrientationSample | null {
    this.tiltRequests.push(timeMs)
    return { pitchDeg: -5, rollDeg: 0, timeMs }
  }
  emit(result: FrameResult) {
    for (const listener of [...this.results]) listener(result)
  }
  setState(state: SessionState) {
    this.state = state
    for (const listener of [...this.listeners]) listener()
  }
}

class FakeLink implements PipelineLink {
  alerts: AlertEvent[] = []
  lookup: TrackLookup | null = null
  throwOnAlert = false
  private outcomeListeners = new Set<(alert: AlertEvent, outcome: AlertOutcome) => void>()
  private healthListeners = new Set<(health: HealthState) => void>()
  private findListeners = new Set<(request: FindRequest) => void>()
  private cancelListeners = new Set<() => void>()
  recorded: number[] = []
  private intentListeners = new Set<(intent: VoiceIntent) => void>()

  handleAlert(alert: AlertEvent) {
    this.alerts.push(alert)
    if (this.throwOnAlert) throw new Error('speaker broke')
  }
  setTrackLookup(lookup: TrackLookup | null) {
    this.lookup = lookup
  }
  onAlertOutcome(listener: (alert: AlertEvent, outcome: AlertOutcome) => void) {
    this.outcomeListeners.add(listener)
    return () => this.outcomeListeners.delete(listener)
  }
  recordFrame(result: FrameResult) {
    this.recorded.push(result.frameId)
  }
  onVoiceIntent(listener: (intent: VoiceIntent) => void) {
    this.intentListeners.add(listener)
    return () => this.intentListeners.delete(listener)
  }
  onFindRequest(listener: (request: FindRequest) => void) {
    this.findListeners.add(listener)
    return () => this.findListeners.delete(listener)
  }
  onFindCancel(listener: () => void) {
    this.cancelListeners.add(listener)
    return () => this.cancelListeners.delete(listener)
  }
  requestFind(request: FindRequest) {
    for (const listener of [...this.findListeners]) listener(request)
  }
  cancelFind() {
    for (const listener of [...this.cancelListeners]) listener()
  }
  onHealth(listener: (health: HealthState) => void) {
    this.healthListeners.add(listener)
    return () => this.healthListeners.delete(listener)
  }
  report(alert: AlertEvent, outcome: AlertOutcome) {
    for (const listener of [...this.outcomeListeners]) listener(alert, outcome)
  }
  reportHealth(health: HealthState) {
    for (const listener of [...this.healthListeners]) listener(health)
  }
  say(intent: VoiceIntent) {
    for (const listener of [...this.intentListeners]) listener(intent)
  }
}

function setup(options: { onBusError?: (topic: string, error: unknown) => void } = {}) {
  const session = new FakeSession()
  const link = new FakeLink()
  let current: Track[] = []
  const tracker = {
    updates: [] as { tiltTimeMs: number | null; eye: number }[],
    resets: 0,
    throwNext: false as boolean,
    update(_result, tilt, settings) {
      if (this.throwNext) throw new Error('tracker broke')
      this.updates.push({ tiltTimeMs: tilt?.timeMs ?? null, eye: settings.eyeHeightM })
      return current
    },
    reset() {
      this.resets += 1
    },
  } satisfies PipelineTracker & { updates: unknown[]; resets: number; throwNext: boolean }
  const clock = { nowMs: 1000 }
  const bus = new EventBus<EventMap>(options.onBusError)
  const pipeline = new Pipeline({
    session,
    link,
    tracker,
    getSettings: () => ({ eyeHeightM: 1.6, horizontalFovDeg: 65 }),
    now: () => clock.nowMs,
    bus,
  })
  const detach = pipeline.attach()
  /** Deliver one frame captured `ageMs` ago, with these tracks. */
  const send = (tracks: Track[], ageMs = 50) => {
    current = tracks
    session.emit(frame(clock.nowMs - ageMs))
  }
  const events: string[] = []
  bus.subscribe('frame', () => events.push('frame'))
  bus.subscribe('tracks', () => events.push('tracks'))
  bus.subscribe('alert', () => events.push('alert'))
  const outcomes: { id: string; outcome: AlertOutcome }[] = []
  bus.subscribe('alertOutcome', ({ alert, outcome }) => outcomes.push({ id: alert.id, outcome }))
  return { session, link, tracker, clock, bus, pipeline, detach, send, events, outcomes }
}

describe('the live path', () => {
  test('a frame goes out as frame, then tracks, and nothing is announced about the objects', () => {
    const t = setup()
    t.send([track(), track({ id: 2, distanceM: 0.8, inPath: true })])
    expect(t.events).toEqual(['frame', 'tracks'])
    expect(t.link.alerts).toHaveLength(0)
    expect(t.pipeline.getTracks()).toHaveLength(2)
  })

  test('no number of frames or tracks makes the detector speak', () => {
    const t = setup()
    for (let i = 0; i < 20; i++) {
      t.clock.nowMs += 500
      t.send([track({ id: i + 1, distanceM: 1 })])
    }
    expect(t.link.alerts).toHaveLength(0)
    expect(t.events.filter((e) => e === 'alert')).toHaveLength(0)
  })

  test('the tracker gets the tilt from when the frame was captured, and the current settings', () => {
    const t = setup()
    t.send([track()], 70)
    expect(t.session.tiltRequests).toEqual([1000 - 70])
    expect(t.tracker.updates).toEqual([{ tiltTimeMs: 930, eye: 1.6 }])
  })
})

describe('alerts from other modules', () => {
  const alert = (id: string): AlertEvent => ({
    id,
    kind: 'status',
    priority: 'normal',
    trackId: null,
    phrase: 'Turn left.',
    pan: null,
    frameTimeMs: 0,
    createdTimeMs: 0,
  })

  test('an alert put on the bus reaches the audio link, and its outcome comes back on the bus', () => {
    const t = setup()
    t.bus.publish('alert', alert('find-1'))
    expect(t.link.alerts.map((a) => a.id)).toEqual(['find-1'])
    t.link.report(t.link.alerts[0], 'finished')
    expect(t.outcomes).toEqual([{ id: 'find-1', outcome: 'finished' }])
  })
})

describe('the track lookup', () => {
  test('the audio link can look up live tracks, and a track that has gone is no longer found', () => {
    const t = setup()
    t.send([track({ id: 4, distanceM: 2.1 })])
    expect(t.link.lookup!(4)).toMatchObject({ distanceM: 2.1 })
    t.send([])
    expect(t.link.lookup!(4)).toBeNull()
  })
})

describe('pause, resume, and detaching', () => {
  test('pausing resets the tracker and clears the tracks', () => {
    const t = setup()
    t.send([track({ id: 1 })])
    t.session.setState('paused')
    expect(t.tracker.resets).toBeGreaterThanOrEqual(1)
    expect(t.pipeline.getTracks()).toHaveLength(0)
    expect(t.link.lookup!(1)).toBeNull()
  })

  test('changes that keep the state the same do not reset anything', () => {
    const t = setup()
    t.send([track()])
    const resets = t.tracker.resets
    t.session.setState('running')
    t.session.setState('running')
    expect(t.tracker.resets).toBe(resets)
    expect(t.pipeline.getTracks()).toHaveLength(1)
  })

  test('detaching stops everything and clears the hooks it gave the audio link', () => {
    const t = setup()
    t.detach()
    t.send([track()])
    expect(t.events).toEqual([])
    expect(t.link.lookup).toBeNull()
  })
})

describe('failures', () => {
  test('an audio link that throws does not stop the frame loop, and the error is reported', () => {
    const errors: string[] = []
    const t = setup({ onBusError: (topic, error) => errors.push(`${topic}: ${(error as Error).message}`) })
    t.link.throwOnAlert = true
    t.bus.publish('alert', {
      id: 'x',
      kind: 'status',
      priority: 'normal',
      trackId: null,
      phrase: 'x',
      pan: null,
      frameTimeMs: 0,
      createdTimeMs: 0,
    })
    expect(errors).toEqual(['alert: speaker broke'])
    t.send([track()])
    t.send([track()])
    expect(t.events.filter((e) => e === 'tracks')).toHaveLength(2)
  })

  test('a frame counts for the health monitor only after the whole pipeline handled it', () => {
    const t = setup()
    t.send([track()])
    expect(t.link.recorded).toHaveLength(1)
    t.tracker.throwNext = true
    expect(() => t.send([track()])).toThrow('tracker broke')
    expect(t.link.recorded).toHaveLength(1)
  })
})

describe('Find requests go on the bus', () => {
  test('a request to find something and a cancel reach bus subscribers', () => {
    const t = setup()
    const seen: string[] = []
    t.bus.subscribe('findRequest', (request) => seen.push(`${request.source}:${request.target}`))
    t.bus.subscribe('findCancel', () => seen.push('cancel'))
    t.link.requestFind({ target: 'chair', source: 'voice' })
    t.link.cancelFind()
    expect(seen).toEqual(['voice:chair', 'cancel'])
  })

  test('detaching stops listening for them', () => {
    const t = setup()
    const seen: string[] = []
    t.bus.subscribe('findRequest', () => seen.push('request'))
    t.detach()
    t.link.requestFind({ target: 'chair', source: 'voice' })
    expect(seen).toEqual([])
  })
})

describe('voice goes on the bus', () => {
  test('voice intents reach bus subscribers', () => {
    const t = setup()
    const intents: VoiceIntent[] = []
    t.bus.subscribe('voice', (intent) => intents.push(intent))
    t.link.say('pause')
    expect(intents).toEqual(['pause'])
  })
})

describe('the free-space path (R7)', () => {
  const pathOf = (decision: FreeSpaceResult['decision']): FreeSpaceResult => ({
    points: [],
    lookahead: null,
    decision,
    processWidth: 320,
    processHeight: 180,
    roiStartRow: 72,
    freeMask: new Uint8Array(0),
  })
  const sendPath = (t: ReturnType<typeof setup>, decision: FreeSpaceResult['decision']) => {
    t.clock.nowMs += 100
    t.session.emit({ ...frame(t.clock.nowMs - 50), freeSpace: pathOf(decision) } as FrameResult)
  }

  test('a frame with a path puts it on the bus after the tracks; a frame without one does not', () => {
    const t = setup()
    const seen: string[] = []
    t.bus.subscribe('tracks', () => seen.push('tracks'))
    t.bus.subscribe('path', (p) => seen.push(`path ${p.decision}`))
    sendPath(t, 'left')
    t.send([track()])
    expect(seen).toEqual(['tracks', 'path left', 'tracks'])
  })

  test('the decision for guidance is the most common of the last few', () => {
    const t = setup()
    for (const d of ['left', 'left', 'right', 'left', 'right'] as const) sendPath(t, d)
    expect(t.pipeline.getPathDecision(t.clock.nowMs)).toBe('left')
    sendPath(t, 'right') // the oldest 'left' drops out: left, right, left, right, right
    expect(t.pipeline.getPathDecision(t.clock.nowMs)).toBe('right')
    expect(CONFIG.freeSpace.decisionHistory).toBe(5)
  })

  test('no result yet, a stale one, or "none" gives no opinion', () => {
    const t = setup()
    expect(t.pipeline.getPathDecision(t.clock.nowMs)).toBeNull()
    sendPath(t, 'straight')
    expect(t.pipeline.getPathDecision(t.clock.nowMs)).toBe('straight')
    expect(t.pipeline.getPathDecision(t.clock.nowMs + CONFIG.freeSpace.maxAgeMs + 1)).toBeNull()
    for (let i = 0; i < 5; i++) sendPath(t, 'none')
    expect(t.pipeline.getPathDecision(t.clock.nowMs)).toBeNull()
  })

  test('a pause forgets the old decisions', () => {
    const t = setup()
    sendPath(t, 'left')
    t.session.setState('paused')
    expect(t.pipeline.getPathDecision(t.clock.nowMs)).toBeNull()
  })
})
