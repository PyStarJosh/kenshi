import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { AlertOutcome, ClassInfo, Track } from '../core/types'
import { SUMMARY_NONE } from './phrases'
import { AlertPolicy, bandIndex, panFor, priorityFor } from './policy'
import type { DropRecord, EmittedAlert } from './policy'

const A = CONFIG.alerts

const klass = (id: number, label: string, alertable = true): ClassInfo => ({
  id,
  label,
  spokenName: label,
  typicalHeightM: null,
  groundContact: true,
  alertable,
})
const CLASSES = [klass(0, 'person'), klass(1, 'chair'), klass(2, 'backpack'), klass(3, 'pole'), klass(4, 'tv', false)]

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

/** Drives a policy frame by frame, and plays the audio engine: each alert is reported finished a little later. */
class Harness {
  policy = new AlertPolicy(CLASSES)
  nowMs = 0
  stepMs = 80
  /** How long an alert takes to speak; null means the audio engine never reports back. */
  speakMs: number | null = 600
  emitted: (EmittedAlert & { atMs: number })[] = []
  drops: DropRecord[] = []
  private finishing: { id: string; atMs: number }[] = []

  step(tracks: Track[], frameAgeMs = 50): EmittedAlert[] {
    this.finishing = this.finishing.filter((f) => {
      if (f.atMs > this.nowMs) return true
      this.policy.notifyOutcome(f.id, 'finished', f.atMs)
      return false
    })
    const result = this.policy.update(tracks, this.nowMs, this.nowMs - frameAgeMs)
    for (const e of result.emitted) {
      this.emitted.push({ ...e, atMs: this.nowMs })
      if (this.speakMs !== null) this.finishing.push({ id: e.alert.id, atMs: this.nowMs + this.speakMs })
    }
    this.drops.push(...result.drops)
    this.nowMs += this.stepMs
    return result.emitted
  }

  /** Run for a duration; `tracksAt` gives the tracks at each time (ms since the start of this run). */
  run(durationMs: number, tracksAt: (tMs: number) => Track[]): void {
    const start = this.nowMs
    while (this.nowMs - start < durationMs) this.step(tracksAt(this.nowMs - start))
  }

  outcome(id: string, outcome: AlertOutcome): void {
    this.policy.notifyOutcome(id, outcome, this.nowMs)
  }
}

describe('priorityFor', () => {
  test('a track that is not confirmed is never announced', () => {
    expect(priorityFor(track({ status: 'tentative' }))).toBeNull()
  })

  test('a track that is neither in the path nor approaching is not announced', () => {
    expect(priorityFor(track({ inPath: false }))).toBeNull()
  })

  test('in path is normal, and urgent at the urgent distance or closer', () => {
    expect(priorityFor(track({ distanceM: 3 }))).toBe('normal')
    expect(priorityFor(track({ distanceM: A.urgentDistanceM + 0.01 }))).toBe('normal')
    expect(priorityFor(track({ distanceM: A.urgentDistanceM }))).toBe('urgent')
    expect(priorityFor(track({ distanceM: 0.8 }))).toBe('urgent')
  })

  test('in path with a short time-to-contact is urgent even when still far', () => {
    expect(priorityFor(track({ distanceM: 3.5, timeToContactS: A.urgentTtcS }))).toBe('urgent')
    expect(priorityFor(track({ distanceM: 3.5, timeToContactS: A.urgentTtcS + 0.1 }))).toBe('normal')
  })

  test('approaching outside the path is info, only under the time-to-contact limit', () => {
    const approaching = { inPath: false, approaching: true }
    expect(priorityFor(track({ ...approaching, timeToContactS: A.approachMaxTtcS }))).toBe('info')
    expect(priorityFor(track({ ...approaching, timeToContactS: A.approachMaxTtcS + 0.1 }))).toBeNull()
    expect(priorityFor(track({ ...approaching, timeToContactS: null }))).toBeNull()
    expect(priorityFor(track({ inPath: false, approaching: false, timeToContactS: 1 }))).toBeNull()
  })

  test('urgent never applies outside the path', () => {
    expect(priorityFor(track({ inPath: false, approaching: true, distanceM: 0.8, timeToContactS: 1 }))).toBe('info')
  })

  test('an in-path track beyond the corridor depth falls back to the approaching rule', () => {
    const far = track({ distanceM: CONFIG.geometry.corridorDepthM + 0.5 })
    expect(priorityFor(far)).toBeNull()
  })
})

describe('panFor', () => {
  test('straight ahead is centered, and the sign follows the side', () => {
    expect(panFor(0)).toBe(0)
    expect(panFor(15)).toBeCloseTo(0.5, 9)
    expect(panFor(-15)).toBeCloseTo(-0.5, 9)
  })

  test('full pan at the configured angle, and no further', () => {
    expect(panFor(A.panFullAngleDeg)).toBe(1)
    expect(panFor(-A.panFullAngleDeg)).toBe(-1)
    expect(panFor(80)).toBe(1)
    expect(panFor(-80)).toBe(-1)
  })

  test('a bad angle pans to the center', () => {
    expect(panFor(Number.NaN)).toBe(0)
  })
})

describe('bandIndex', () => {
  test.each([
    [0.5, 0],
    [1.5, 0],
    [1.51, 1],
    [3, 1],
    [3.01, 2],
    [4, 2],
    [4.5, 3],
  ])('%f m is in band %i', (distance, expected) => {
    expect(bandIndex(distance, A.distanceBandsM)).toBe(expected)
  })
})

describe('chatter limits', () => {
  test('a stationary chair produces one alert while you stand still', () => {
    const h = new Harness()
    h.run(60_000, () => [track({ distanceM: 2.5 })])
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0].alert.phrase).toBe("Chair, 12 o'clock, about 2.5 meters.")
    expect(h.emitted[0].reason).toBe('first')
  })

  test('a stationary object that jitters a little still produces one alert', () => {
    const h = new Harness()
    h.run(30_000, (t) => [track({ distanceM: 2.5 + 0.2 * Math.sin(t / 300) })])
    expect(h.emitted).toHaveLength(1)
  })

  test('several stationary objects are each announced once', () => {
    const h = new Harness()
    h.run(30_000, () => [
      track({ id: 1, distanceM: 2.5, clock: { position: 12, angleDeg: 0 } }),
      track({ id: 2, classId: 2, label: 'backpack', distanceM: 3.2, clock: { position: 1, angleDeg: 20 } }),
    ])
    expect(h.emitted.map((e) => e.alert.trackId).sort()).toEqual([1, 2])
  })

  test('a track that disappears and returns under a new id is announced again', () => {
    const h = new Harness()
    h.run(3000, () => [track({ id: 1 })])
    h.run(3000, () => [])
    h.run(3000, () => [track({ id: 2 })])
    expect(h.emitted.map((e) => e.alert.trackId)).toEqual([1, 2])
  })

  test('objects the app does not announce are ignored', () => {
    const h = new Harness()
    h.run(5000, () => [track({ classId: 4, label: 'tv' })])
    expect(h.emitted).toHaveLength(0)
  })

  test('an unconfirmed track is not announced until it is confirmed', () => {
    const h = new Harness()
    h.run(2000, () => [track({ status: 'tentative' })])
    expect(h.emitted).toHaveLength(0)
    h.run(1000, () => [track({ status: 'confirmed' })])
    expect(h.emitted).toHaveLength(1)
  })
})

describe('escalation', () => {
  test('walking up to a chair goes from normal to urgent, once', () => {
    const h = new Harness()
    const speed = 1.2 // meters per second
    h.run(3500, (t) => [track({ distanceM: Math.max(0.6, 3.8 - (speed * t) / 1000), closingSpeedMps: speed })])
    const priorities = h.emitted.map((e) => e.alert.priority)
    expect(priorities[0]).toBe('normal')
    expect(priorities.at(-1)).toBe('urgent')
    expect(priorities.filter((p) => p === 'urgent')).toHaveLength(1)
    const urgent = h.emitted.find((e) => e.alert.priority === 'urgent')!
    expect(urgent.reason).toBe('urgent')
    expect(urgent.atMs).toBeLessThanOrEqual(2100) // 3.8 - 1.2 * t reaches the 1.5 m urgent distance at about 1.9 s
    expect(h.emitted.length).toBeLessThanOrEqual(4)
  })

  test('the urgent alert reaches the speaker while the earlier normal one is still being spoken', () => {
    const h = new Harness()
    h.speakMs = null // the audio engine never finishes anything on its own
    h.step([track({ distanceM: 3 })])
    expect(h.emitted[0].alert.priority).toBe('normal')
    const second = h.step([track({ distanceM: 1.2 })])
    expect(second).toHaveLength(1)
    expect(second[0].alert.priority).toBe('urgent')
    expect(second[0].reason).toBe('urgent')
  })

  test('becoming urgent through time-to-contact alone also escalates', () => {
    const h = new Harness()
    h.step([track({ distanceM: 3.5 })])
    h.nowMs += 2000
    h.step([track({ distanceM: 3.5, timeToContactS: 1.8 })])
    expect(h.emitted.at(-1)?.alert.priority).toBe('urgent')
  })

  test('after backing off below urgent, becoming urgent again is a new escalation (after the cooldown)', () => {
    const h = new Harness()
    h.step([track({ distanceM: 1.2 })]) // urgent
    h.nowMs += A.urgentCooldownMs
    h.step([track({ distanceM: 3 })]) // back to normal: nothing new to say
    h.nowMs += A.urgentCooldownMs
    h.step([track({ distanceM: 1.2 })]) // urgent again
    expect(h.emitted.filter((e) => e.alert.priority === 'urgent')).toHaveLength(2)
  })

  test('urgent again within the cooldown is not repeated', () => {
    const h = new Harness()
    h.step([track({ distanceM: 1.2 })])
    h.nowMs += 200
    h.step([track({ distanceM: 3 })])
    h.nowMs += 200
    h.step([track({ distanceM: 1.2 })])
    expect(h.emitted.filter((e) => e.alert.priority === 'urgent')).toHaveLength(1)
  })
})

describe('re-announcement rules', () => {
  test('moving into a closer band announces again, but only after the cooldown', () => {
    const h = new Harness()
    h.step([track({ distanceM: 3.5 })]) // band 2
    h.nowMs += A.closerBandCooldownMs - 100
    h.step([track({ distanceM: 2.8 })]) // band 1, too soon
    expect(h.emitted).toHaveLength(1)
    h.nowMs += 200
    h.step([track({ distanceM: 2.8 })]) // still band 1, cooldown over
    expect(h.emitted).toHaveLength(2)
    expect(h.emitted[1].reason).toBe('closer')
  })

  test('backing away and returning to the same band does not announce again', () => {
    const h = new Harness()
    h.step([track({ distanceM: 2.8 })]) // band 1
    h.nowMs += 5000
    h.step([track({ distanceM: 3.6 })]) // band 2: farther, nothing to say
    h.nowMs += 5000
    h.step([track({ distanceM: 2.8 })]) // band 1 again
    expect(h.emitted).toHaveLength(1)
  })

  test('entering the path announces a track that was announced while outside it', () => {
    const h = new Harness()
    const outside = { inPath: false, approaching: true, timeToContactS: 3.5, distanceM: 3.6 }
    h.step([track(outside)])
    expect(h.emitted[0].alert.priority).toBe('info')
    h.nowMs += A.closerBandCooldownMs
    h.step([track({ ...outside, inPath: true, timeToContactS: 3.4 })])
    expect(h.emitted).toHaveLength(2)
    expect(h.emitted[1].reason).toBe('entered-path')
    expect(h.emitted[1].alert.priority).toBe('normal')
  })

  test('a change of clock position announces again, only after its own cooldown', () => {
    const h = new Harness()
    h.step([track({ clock: { position: 12, angleDeg: 5 } })])
    h.nowMs += A.clockChangeCooldownMs - 200
    h.step([track({ clock: { position: 1, angleDeg: 20 } })])
    expect(h.emitted).toHaveLength(1)
    h.nowMs += 400
    h.step([track({ clock: { position: 1, angleDeg: 20 } })])
    expect(h.emitted).toHaveLength(2)
    expect(h.emitted[1].reason).toBe('clock')
    expect(h.emitted[1].alert.phrase).toMatch(/1 o'clock/)
  })

  test('reset forgets everything, so a track is announced afresh', () => {
    const h = new Harness()
    h.step([track()])
    h.policy.reset()
    h.nowMs += 200
    h.step([track()])
    expect(h.emitted).toHaveLength(2)
  })
})

describe('one alert at a time', () => {
  test('a normal alert waits for the one being spoken, and for the minimum gap after it', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([track({ id: 1, distanceM: 3 })])
    h.nowMs += 200
    expect(h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 2.5 })])).toHaveLength(0)
    expect(h.policy.pendingCount()).toBe(1)
    h.outcome(h.emitted[0].alert.id, 'finished')
    h.nowMs += A.minGapMs - 100
    expect(h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 2.5 })])).toHaveLength(0)
    h.nowMs += 200
    const next = h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 2.5 })])
    expect(next).toHaveLength(1)
    expect(next[0].alert.trackId).toBe(2)
  })

  test('urgent preempts a normal alert that is in flight', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([track({ id: 1, distanceM: 3 })])
    h.nowMs += 200
    const out = h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 1.0 })])
    expect(out).toHaveLength(1)
    expect(out[0].alert.priority).toBe('urgent')
    expect(out[0].alert.trackId).toBe(2)
  })

  test('urgent does not cut off another urgent alert', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([track({ id: 1, distanceM: 1.2 })])
    h.nowMs += 200
    const out = h.step([track({ id: 1, distanceM: 1.2 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 0.9 })])
    expect(out).toHaveLength(0)
    h.outcome(h.emitted[0].alert.id, 'finished')
    h.nowMs += 100
    expect(h.step([track({ id: 1, distanceM: 1.2 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 0.9 })])[0].alert.trackId).toBe(2)
  })

  test('when several compete, the most urgent goes first, then the nearest', () => {
    const h = new Harness()
    h.run(8000, () => [
      track({ id: 1, distanceM: 3.4 }),
      track({ id: 2, classId: 2, label: 'backpack', distanceM: 2.0, clock: { position: 1, angleDeg: 20 } }),
      track({ id: 3, classId: 3, label: 'pole', distanceM: 1.2, clock: { position: 11, angleDeg: -20 } }),
    ])
    expect(h.emitted.map((e) => e.alert.trackId)).toEqual([3, 2, 1])
    expect(h.emitted.map((e) => e.alert.priority)).toEqual(['urgent', 'normal', 'normal'])
  })

  test('the audio engine never reporting back cannot silence later alerts forever', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([track({ id: 1, distanceM: 3 })])
    h.nowMs += A.inFlightTimeoutMs - 200
    expect(h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 2.5 })])).toHaveLength(0)
    // Past the timeout the stuck alert counts as finished, but the minimum gap still applies after it.
    h.nowMs += 400
    expect(h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 2.5 })])).toHaveLength(0)
    h.nowMs += A.minGapMs
    expect(h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 2.5 })])).toHaveLength(1)
  })

  test('a preempted alert reported late does not free the one that preempted it', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([track({ id: 1, distanceM: 3 })])
    h.nowMs += 200
    h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 1.0 })]) // urgent preempts
    h.outcome(h.emitted[0].alert.id, 'preempted')
    h.nowMs += A.minGapMs + 100
    const out = h.step([track({ id: 1, distanceM: 3 }), track({ id: 2, classId: 2, label: 'backpack', distanceM: 1.0 }), track({ id: 3, classId: 3, label: 'pole', distanceM: 2 })])
    expect(out).toHaveLength(0) // the urgent alert is still in flight
  })
})

describe('an alert that was not heard is announced again', () => {
  const chair = (distanceM = 3) => track({ id: 1, distanceM })
  const others = (...tracks: Track[]) => tracks

  test('the audio engine dropping it as stale lets the track be announced again from a fresh frame', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([chair()])
    const first = h.emitted[0].alert
    h.outcome(first.id, 'dropped-stale')
    h.nowMs += A.minGapMs + 100
    const again = h.step([chair()])
    expect(again).toHaveLength(1)
    expect(again[0].alert.trackId).toBe(1)
    expect(again[0].alert.id).not.toBe(first.id)
    expect(h.nowMs - again[0].alert.frameTimeMs).toBeLessThanOrEqual(A.staleLimitMs)
  })

  test('the audio engine dropping it because its track went away does not bring it back for a track that is gone', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([chair()])
    h.outcome(h.emitted[0].alert.id, 'dropped-track-gone')
    h.nowMs += A.minGapMs + 100
    expect(h.step([])).toHaveLength(0)
  })

  test('an alert cut off before it finished is announced again once the interruption is over', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([chair()])
    h.outcome(h.emitted[0].alert.id, 'preempted')
    h.nowMs += A.minGapMs + 100
    expect(h.step([chair()]).map((e) => e.alert.trackId)).toEqual([1])
  })

  test("a normal alert cut off by the policy's own urgent alert is announced again after the urgent one", () => {
    const h = new Harness()
    h.speakMs = null
    h.step([chair()]) // normal, in flight
    h.nowMs += 200
    const urgent = h.step([chair(), track({ id: 2, classId: 2, label: 'backpack', distanceM: 1.0 })])
    expect(urgent[0].alert.priority).toBe('urgent')
    h.outcome(urgent[0].alert.id, 'finished')
    h.nowMs += A.minGapMs + 100
    const next = h.step(others(chair(), track({ id: 2, classId: 2, label: 'backpack', distanceM: 1.0 })))
    expect(next.map((e) => e.alert.trackId)).toEqual([1])
  })

  test('an alert that finished is not repeated', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([chair()])
    h.outcome(h.emitted[0].alert.id, 'finished')
    h.run(10_000, () => [chair()])
    expect(h.emitted).toHaveLength(1)
  })

  test('a report about an alert that is not the one in flight is ignored', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([chair()])
    h.outcome('some-other-alert', 'dropped-stale')
    h.nowMs += A.minGapMs + 100
    expect(h.step([chair()])).toHaveLength(0)
  })

  test('being dropped over and over only keeps trying, never piles up alerts', () => {
    const h = new Harness()
    h.speakMs = null
    for (let i = 0; i < 5; i++) {
      h.nowMs += A.minGapMs + 100
      const out = h.step([chair()])
      expect(out).toHaveLength(1)
      h.outcome(out[0].alert.id, 'dropped-stale')
    }
    expect(h.policy.pendingCount()).toBe(0)
  })
})

describe('the waiting queue', () => {
  const crowd = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      track({ id: i + 1, classId: 2, label: 'backpack', distanceM: 2 + i * 0.4, clock: { position: 12, angleDeg: i } }),
    )

  test('at most maxQueuedAlerts wait, nearest first, and the rest are held back', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([track({ id: 99, distanceM: 3 })]) // something is being spoken
    h.nowMs += 100
    h.step([track({ id: 99, distanceM: 3 }), ...crowd(4)])
    expect(h.policy.pendingCount()).toBe(A.maxQueuedAlerts)
    expect(h.drops).toHaveLength(0) // held back, not dropped
  })

  test('held-back tracks are announced once there is room, nearest first, none lost', () => {
    const h = new Harness()
    h.run(15_000, () => crowd(4))
    expect(h.emitted.map((e) => e.alert.trackId)).toEqual([1, 2, 3, 4])
    expect(h.drops).toHaveLength(0)
  })

  test('a nearer arrival pushes the farthest waiting alert out, which is recorded and announced later', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([track({ id: 99, distanceM: 3 })])
    h.nowMs += 100
    const far = [
      track({ id: 1, classId: 2, label: 'backpack', distanceM: 3.6 }),
      track({ id: 2, classId: 2, label: 'backpack', distanceM: 3.4 }),
    ]
    h.step([track({ id: 99, distanceM: 3 }), ...far])
    h.nowMs += 100
    h.step([track({ id: 99, distanceM: 3 }), ...far, track({ id: 3, classId: 3, label: 'pole', distanceM: 2.2 })])
    expect(h.drops).toHaveLength(1)
    expect(h.drops[0]).toMatchObject({ trackId: 1, reason: 'queue-full' })
    h.speakMs = 300
    h.outcome(h.emitted[0].alert.id, 'finished')
    h.run(8000, () => [track({ id: 99, distanceM: 3 }), ...far, track({ id: 3, classId: 3, label: 'pole', distanceM: 2.2 })])
    expect(h.emitted.map((e) => e.alert.trackId)).toContain(1)
  })

  test('a newer alert for the same track replaces its waiting one', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([track({ id: 99, distanceM: 3 })])
    h.nowMs += 100
    h.step([track({ id: 99, distanceM: 3 }), track({ id: 1, classId: 2, label: 'backpack', distanceM: 3.6 })])
    h.nowMs += A.closerBandCooldownMs + 100
    h.step([track({ id: 99, distanceM: 3 }), track({ id: 1, classId: 2, label: 'backpack', distanceM: 2.5 })])
    expect(h.policy.pendingCount()).toBeLessThanOrEqual(1)
    expect(h.drops.every((d) => d.reason === 'superseded' || d.reason === 'stale')).toBe(true)
  })
})

describe('dropping alerts that should not be spoken', () => {
  const backpack = (distanceM: number) => track({ id: 1, classId: 2, label: 'backpack', distanceM })
  const busy = () => track({ id: 99, distanceM: 3 })

  test('a waiting alert follows its track instead of going stale while speech is busy', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([busy()]) // being spoken
    h.nowMs += 100
    h.step([busy(), backpack(3.9)]) // distance band 2 (up to 4 m)
    expect(h.policy.pendingCount()).toBe(1)
    for (let i = 0; i < 20; i++) {
      h.nowMs += 300 // six seconds in all, far longer than the stale limit, with frames arriving throughout
      h.step([busy(), backpack(3.1)]) // still band 2, so no new alert is raised, but the waiting one is rewritten
    }
    expect(h.drops).toHaveLength(0)
    expect(h.policy.pendingCount()).toBe(1)
    h.outcome(h.emitted[0].alert.id, 'finished')
    h.nowMs += A.minGapMs + 100
    const out = h.step([busy(), backpack(3.1)])
    expect(out).toHaveLength(1)
    expect(out[0].alert.phrase).toBe("Backpack, 12 o'clock, about 3 meters.")
    expect(h.nowMs - out[0].alert.frameTimeMs).toBeLessThanOrEqual(A.staleLimitMs)
  })

  test('a waiting alert is dropped as stale when the frames feeding the policy get too old, then announced afresh', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([busy()])
    h.nowMs += 100
    h.step([busy(), backpack(2.5)])
    expect(h.policy.pendingCount()).toBe(1)
    h.nowMs += 100
    h.step([busy(), backpack(2.5)], A.staleLimitMs + 500) // a frame captured long ago
    expect(h.drops).toEqual([expect.objectContaining({ trackId: 1, reason: 'stale' })])
    expect(h.policy.pendingCount()).toBe(0)
    h.outcome(h.emitted[0].alert.id, 'finished')
    h.nowMs += A.minGapMs + 100
    const out = h.step([busy(), backpack(2.5)])
    expect(out).toHaveLength(1)
    expect(out[0].alert.trackId).toBe(1)
  })

  test('a frame that is already too old announces nothing, and the track is announced from the next fresh frame', () => {
    const h = new Harness()
    expect(h.step([track()], A.staleLimitMs + 500)).toHaveLength(0)
    expect(h.drops).toHaveLength(0)
    expect(h.policy.pendingCount()).toBe(0)
    expect(h.step([track()])).toHaveLength(1)
  })

  test('a waiting alert whose track has gone is dropped as track-gone and never spoken', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([busy()])
    h.nowMs += 100
    h.step([busy(), backpack(2.5)])
    h.nowMs += 100
    h.step([busy()])
    expect(h.drops).toEqual([expect.objectContaining({ trackId: 1, reason: 'track-gone' })])
    h.outcome(h.emitted[0].alert.id, 'finished')
    h.run(5000, () => [busy()])
    expect(h.emitted.map((e) => e.alert.trackId)).toEqual([99])
  })

  test('a waiting alert whose track left the path is dropped as not-eligible, and spoken if it returns', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([busy()])
    h.nowMs += 100
    h.step([busy(), backpack(2.5)])
    h.nowMs += 100
    h.step([busy(), { ...backpack(2.5), inPath: false }])
    expect(h.drops).toEqual([expect.objectContaining({ trackId: 1, reason: 'not-eligible' })])
    h.outcome(h.emitted[0].alert.id, 'finished')
    h.nowMs += A.minGapMs + 100
    expect(h.step([busy(), { ...backpack(2.5), inPath: false }])).toHaveLength(0)
    h.nowMs += 100
    expect(h.step([busy(), backpack(2.5)]).map((e) => e.alert.trackId)).toEqual([1])
  })

  test('every drop is kept in the drop log with its reason', () => {
    const h = new Harness()
    h.speakMs = null
    h.step([busy()])
    h.nowMs += 100
    h.step([busy(), backpack(2.5)])
    h.nowMs += 100
    h.step([busy()])
    expect(h.policy.getDropLog()).toHaveLength(1)
    expect(h.policy.getDropLog()[0]).toMatchObject({ reason: 'track-gone', trackId: 1 })
  })
})

describe('a person approaching from 1 o clock', () => {
  test('is announced as info, then as the path is entered, then urgently', () => {
    const h = new Harness()
    const person = (over: Partial<Track>) =>
      track({ id: 7, classId: 0, label: 'person', clock: { position: 1, angleDeg: 20 }, approaching: true, closingSpeedMps: 1.2, ...over })

    h.step([person({ inPath: false, distanceM: 4.5, timeToContactS: 3.5 })])
    const first = h.emitted[0]
    expect(first.alert.priority).toBe('info')
    expect(first.alert.phrase).toBe("Person, 1 o'clock, about 4.5 meters.")
    expect(first.alert.pan).toBeCloseTo(20 / A.panFullAngleDeg, 9)
    expect(first.alert.pan!).toBeGreaterThan(0)

    h.nowMs += 2000
    h.step([person({ inPath: true, distanceM: 2.6, timeToContactS: 2.2, clock: { position: 12, angleDeg: 8 } })])
    expect(h.emitted[1].alert.priority).toBe('normal')
    expect(h.emitted[1].reason).toBe('entered-path')

    h.nowMs += 800
    h.step([person({ inPath: true, distanceM: 1.4, timeToContactS: 1.1, clock: { position: 12, angleDeg: 3 } })])
    expect(h.emitted[2].alert.priority).toBe('urgent')
    expect(h.emitted[2].alert.phrase).toBe("Person, 12 o'clock, about 1.5 meters.")
  })

  test('a person outside the path who is not closing in is never announced', () => {
    const h = new Harness()
    h.run(10_000, () => [track({ id: 7, classId: 0, label: 'person', inPath: false, approaching: false, clock: { position: 1, angleDeg: 20 } })])
    expect(h.emitted).toHaveLength(0)
  })
})

describe('alert contents', () => {
  test('an obstacle alert carries its track, times, pan, and a unique id', () => {
    const h = new Harness()
    h.step([track({ id: 5, clock: { position: 11, angleDeg: -18 } })], 70)
    const { alert } = h.emitted[0]
    expect(alert).toMatchObject({ kind: 'obstacle', priority: 'normal', trackId: 5 })
    expect(alert.frameTimeMs).toBe(-70)
    expect(alert.createdTimeMs).toBe(0)
    expect(alert.pan!).toBeLessThan(0)
    h.run(20_000, () => [track({ id: 5 }), track({ id: 6, classId: 2, label: 'backpack', distanceM: 3 })])
    const ids = h.emitted.map((e) => e.alert.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('the phrase uses the class spoken name and the height label', () => {
    const h = new Harness()
    h.step([track({ classId: 2, label: 'backpack', distanceM: 2, elevation: 'floor', clock: { position: 1, angleDeg: 20 } })])
    expect(h.emitted[0].alert.phrase).toBe("Backpack, 1 o'clock, about 2 meters, on the floor.")
  })
})

describe('summarize', () => {
  const policy = new AlertPolicy(CLASSES)
  const at = (id: number, classId: number, label: string, distanceM: number, angleDeg: number, over: Partial<Track> = {}) =>
    track({
      id,
      classId,
      label,
      distanceM,
      inPath: false,
      clock: { position: angleDeg < -15 ? 11 : angleDeg > 15 ? 1 : 12, angleDeg },
      ...over,
    })

  test('lists objects in clock order from left to right, in or out of the path', () => {
    const text = policy.summarize([
      at(1, 1, 'chair', 2.0, 0),
      at(2, 0, 'person', 3.0, 25),
      at(3, 2, 'backpack', 1.5, -25, { elevation: 'floor' }),
    ])
    expect(text).toBe("Backpack, 11 o'clock, about 1.5 meters, on the floor. Chair, 12 o'clock, about 2 meters. Person, 1 o'clock, about 3 meters.")
  })

  test('keeps only the nearest few, then orders them left to right', () => {
    const many = [
      at(1, 1, 'chair', 5.5, -28),
      at(2, 1, 'chair', 1.0, 22),
      at(3, 1, 'chair', 2.0, -10),
      at(4, 1, 'chair', 3.0, 0),
      at(5, 1, 'chair', 4.0, 12),
      at(6, 1, 'chair', 4.5, 28),
      at(7, 1, 'chair', 5.0, -20),
    ]
    const text = policy.summarize(many)
    const sentences = text.split(/(?<=\.) /)
    expect(sentences).toHaveLength(A.summaryMaxItems)
    // The five nearest are 1.0, 2.0, 3.0, 4.0 and 4.5 m; at -10, 0, 12, 22 and 28 degrees they read left to right.
    expect(sentences.map((s) => s.match(/about ([\d.]+)/)![1])).toEqual(['2', '3', '4', '1', '4.5'])
  })

  test('leaves out objects beyond the farthest distance, tentative tracks, and classes it does not announce', () => {
    const text = policy.summarize([
      at(1, 1, 'chair', A.summaryMaxDistanceM + 1, 0),
      at(2, 1, 'chair', 2, 0, { status: 'tentative' }),
      at(3, 4, 'tv', 2, 0),
    ])
    expect(text).toBe(SUMMARY_NONE)
  })

  test('with nothing detected it says so as a limit, not an all-clear', () => {
    expect(policy.summarize([])).toBe(SUMMARY_NONE)
  })

  test('names a single object with the same phrase an alert would use', () => {
    expect(policy.summarize([at(1, 1, 'chair', 1.5, 0)])).toBe("Chair, 12 o'clock, about 1.5 meters.")
  })
})
