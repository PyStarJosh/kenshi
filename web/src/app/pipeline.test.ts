import { describe, expect, test } from 'vitest'
import { EventBus } from '../alerts/bus'
import { AlertPolicy } from '../alerts/policy'
import type { TrackLookup } from '../audio/engine'
import { CONFIG } from '../core/config'
import type {
  AlertEvent,
  AlertOutcome,
  ClassInfo,
  EventMap,
  FrameResult,
  HealthState,
  OrientationSample,
  Track,
  VoiceIntent,
} from '../core/types'
import { Pipeline } from './pipeline'
import type { PipelineLink, PipelineSession, PipelineTracker } from './pipeline'
import type { SessionState } from './session'

const A = CONFIG.alerts

const klass = (id: number, label: string): ClassInfo => ({
  id,
  label,
  spokenName: label,
  typicalHeightM: null,
  groundContact: true,
  alertable: true,
})
const CLASSES = [klass(0, 'person'), klass(1, 'chair'), klass(2, 'backpack')]

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
  summarizer: (() => string) | null = null
  throwOnAlert = false
  private outcomeListeners = new Set<(alert: AlertEvent, outcome: AlertOutcome) => void>()
  private healthListeners = new Set<(health: HealthState) => void>()
  recorded: number[] = []
  private intentListeners = new Set<(intent: VoiceIntent) => void>()

  handleAlert(alert: AlertEvent) {
    this.alerts.push(alert)
    if (this.throwOnAlert) throw new Error('speaker broke')
  }
  setSummarizer(summarizer: (() => string) | null) {
    this.summarizer = summarizer
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
    policy: new AlertPolicy(CLASSES),
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
  test('a frame goes out as frame, then tracks, then an alert, and the audio link receives the alert', () => {
    const t = setup()
    t.send([track()])
    expect(t.events).toEqual(['frame', 'tracks', 'alert'])
    expect(t.link.alerts).toHaveLength(1)
    expect(t.link.alerts[0].phrase).toBe("Chair, 12 o'clock, about 2.5 meters.")
    expect(t.pipeline.getTracks()).toHaveLength(1)
  })

  test('the tracker gets the tilt from when the frame was captured, and the current settings', () => {
    const t = setup()
    t.send([track()], 70)
    expect(t.session.tiltRequests).toEqual([1000 - 70])
    expect(t.tracker.updates).toEqual([{ tiltTimeMs: 930, eye: 1.6 }])
  })

  test('sent alerts are kept as captions with the reason they were raised', () => {
    const t = setup()
    t.send([track()])
    const [caption] = t.pipeline.getCaptions()
    expect(caption.reason).toBe('first')
    expect(caption.alert.phrase).toMatch(/^Chair/)
    expect(caption.atMs).toBe(1000)
  })

  test('only the latest few captions are kept', () => {
    const t = setup()
    for (let id = 1; id <= 12; id++) {
      t.clock.nowMs += 5000
      t.send([track({ id, classId: 2, label: 'backpack' })])
      t.link.report(t.link.alerts.at(-1)!, 'finished')
    }
    expect(t.pipeline.getCaptions().length).toBeLessThanOrEqual(6)
    expect(t.pipeline.getCaptions().at(-1)!.alert.trackId).toBe(12)
  })

  test('a frame with nothing worth announcing produces no alert', () => {
    const t = setup()
    t.send([track({ inPath: false })])
    expect(t.link.alerts).toHaveLength(0)
    expect(t.events).toEqual(['frame', 'tracks'])
  })
})

describe('the audio link feeds back', () => {
  test('the next alert waits until the first is reported finished, and the minimum gap has passed', () => {
    const t = setup()
    const both = [track({ id: 1 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 3 })]
    t.send(both)
    expect(t.link.alerts).toHaveLength(1)
    t.clock.nowMs += 3000
    t.send(both)
    expect(t.link.alerts).toHaveLength(1) // still being spoken as far as the policy knows
    t.link.report(t.link.alerts[0], 'finished')
    t.clock.nowMs += A.minGapMs + 100
    t.send(both)
    expect(t.link.alerts).toHaveLength(2)
    expect(t.link.alerts[1].trackId).toBe(2)
  })

  test('a "started" report does not free the speaker', () => {
    const t = setup()
    const both = [track({ id: 1 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 3 })]
    t.send(both)
    t.link.report(t.link.alerts[0], 'started')
    t.clock.nowMs += 3000
    t.send(both)
    expect(t.link.alerts).toHaveLength(1)
  })
})

describe('an alert that was not heard', () => {
  test('is sent again when the audio engine reports it dropped, because the user never heard it', () => {
    const t = setup()
    t.send([track()])
    t.link.report(t.link.alerts[0], 'dropped-stale') // for example it waited behind the greeting
    t.clock.nowMs += A.minGapMs + 100
    t.send([track()])
    expect(t.link.alerts).toHaveLength(2)
    expect(t.link.alerts[1].trackId).toBe(1)
  })

  test('is not sent again once it has finished', () => {
    const t = setup()
    t.send([track()])
    t.link.report(t.link.alerts[0], 'finished')
    for (let i = 0; i < 5; i++) {
      t.clock.nowMs += 2000
      t.send([track()])
    }
    expect(t.link.alerts).toHaveLength(1)
  })
})

describe('the track lookup and the summary', () => {
  test('the audio link can look up live tracks, and a track that has gone is no longer found', () => {
    const t = setup()
    t.send([track({ id: 4, distanceM: 2.1 })])
    expect(t.link.lookup!(4)).toMatchObject({ distanceM: 2.1 })
    t.send([])
    expect(t.link.lookup!(4)).toBeNull()
  })

  test("the summary says what's around from the current tracks", () => {
    const t = setup()
    t.send([track({ id: 1, inPath: false, distanceM: 2 })])
    expect(t.link.summarizer!()).toBe("Chair, 12 o'clock, about 2 meters.")
    t.send([])
    expect(t.link.summarizer!()).toMatch(/I can miss things/)
  })
})

describe('drops are announced on the bus', () => {
  test('an alert dropped for old frames is reported as dropped-stale', () => {
    const t = setup()
    const both = [track({ id: 1 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 3 })]
    t.send(both) // alert-1 goes out and is never reported finished
    t.clock.nowMs += 200
    t.send(both) // alert for track 2 waits behind it
    t.clock.nowMs += 200
    t.send(both, A.staleLimitMs + 500) // a frame captured long ago
    expect(t.outcomes).toEqual([{ id: expect.any(String), outcome: 'dropped-stale' }])
  })

  test('an alert whose track vanished while it waited is reported as dropped-track-gone', () => {
    const t = setup()
    const both = [track({ id: 1 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 3 })]
    t.send(both)
    t.clock.nowMs += 200
    t.send(both)
    t.clock.nowMs += 200
    t.send([track({ id: 1 })])
    expect(t.outcomes.map((o) => o.outcome)).toEqual(['dropped-track-gone'])
  })

  test('drops that the shared outcome type cannot express are not put on the bus', () => {
    const t = setup()
    const busy = track({ id: 1 })
    t.send([busy])
    t.clock.nowMs += 200
    t.send([busy, track({ id: 2, classId: 2, label: 'backpack', distanceM: 3 })])
    t.clock.nowMs += 200
    t.send([busy, track({ id: 2, classId: 2, label: 'backpack', distanceM: 3, inPath: false })]) // no longer in the path
    expect(t.outcomes).toEqual([])
  })
})

describe('pause, resume, and detaching', () => {
  test('pausing resets the tracker and the policy, so the same object is announced again afterwards', () => {
    const t = setup()
    t.send([track({ id: 1 })])
    expect(t.link.alerts).toHaveLength(1)
    t.link.report(t.link.alerts[0], 'finished')
    t.session.setState('paused')
    expect(t.tracker.resets).toBeGreaterThanOrEqual(1)
    expect(t.pipeline.getTracks()).toHaveLength(0)
    expect(t.link.lookup!(1)).toBeNull()
    t.session.setState('running')
    t.clock.nowMs += 3000
    t.send([track({ id: 1 })])
    expect(t.link.alerts).toHaveLength(2)
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
    expect(t.link.alerts).toHaveLength(0)
    expect(t.link.lookup).toBeNull()
    expect(t.link.summarizer).toBeNull()
  })
})

describe('failures', () => {
  test('an audio link that throws does not stop the frame loop, and the error is reported', () => {
    const errors: string[] = []
    const t = setup({ onBusError: (topic, error) => errors.push(`${topic}: ${(error as Error).message}`) })
    t.link.throwOnAlert = true
    t.send([track()])
    expect(errors).toEqual(['alert: speaker broke'])
    t.clock.nowMs += 200
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

describe('voice goes on the bus', () => {
  test('voice intents reach bus subscribers', () => {
    const t = setup()
    const intents: VoiceIntent[] = []
    t.bus.subscribe('voice', (intent) => intents.push(intent))
    t.link.say('whats-around')
    expect(intents).toEqual(['whats-around'])
  })
})
