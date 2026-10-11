import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { BoundingBox, Detection, FrameResult, Track } from '../core/types'
import { CLASSES } from '../detection/classes'
import { cameraModel } from '../geometry/geometry'
import { Tracker } from './tracker'
import type { Locator } from './tracker'

const FRAME = { width: 1280, height: 720 }
const SETTINGS = { eyeHeightM: 1.6, horizontalFovDeg: 65 }
const PERSON_H = 1.7

function frameResult(timeMs: number, detections: Detection[]): FrameResult {
  return {
    frameId: Math.round(timeMs),
    captureTimeMs: timeMs,
    receivedTimeMs: timeMs,
    frameWidth: FRAME.width,
    frameHeight: FRAME.height,
    inputSize: 416,
    backend: 'wasm',
    timings: { preprocessMs: 0, inferenceMs: 0, postprocessMs: 0 },
    meanLuma: 0.5,
    detections,
  }
}

const person = (box: BoundingBox, confidence = 0.8): Detection => ({ classId: 0, label: 'person', confidence, box })

/** A person-height box seen from `distanceM`, centered on the horizon, offset sideways by centerX. */
function personAt(distanceM: number, centerX = 0.5): BoundingBox {
  const f = cameraModel(FRAME, SETTINGS.horizontalFovDeg).focalPx
  const height = (PERSON_H * f) / distanceM / FRAME.height
  const width = height * 0.4 * (FRAME.height / FRAME.width)
  return { x: centerX - width / 2, y: 0.5 - height / 2, width, height }
}

/** Seeded generator so the "random" tests are repeatable. */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

const noLevel = null
const newTracker = () => new Tracker(CLASSES)

describe('static object while the user walks toward it', () => {
  test('time to contact is close to distance over walking speed', () => {
    const tracker = newTracker()
    const speed = 1.2
    let last = null
    for (let t = 0; t <= 2500; t += 67) {
      const distance = 6 - (speed * t) / 1000
      last = tracker.update(frameResult(t, [person(personAt(distance))]), noLevel, SETTINGS)
    }
    const [track] = last!
    const expectedS = track.distanceM / speed
    expect(track.status).toBe('confirmed')
    expect(track.closingSpeedMps).toBeCloseTo(speed, 0)
    expect(Math.abs(track.timeToContactS! - expectedS) / expectedS).toBeLessThan(0.2)
    expect(track.approaching).toBe(true)
  })

  test('a far object is not approaching even when closing, until its time to contact is short', () => {
    const tracker = newTracker()
    let last = null
    for (let t = 0; t <= 1000; t += 67) {
      last = tracker.update(frameResult(t, [person(personAt(9 - (1.2 * t) / 1000))]), noLevel, SETTINGS)
    }
    expect(last![0].timeToContactS).toBeGreaterThan(CONFIG.alerts.approachMaxTtcS)
    expect(last![0].approaching).toBe(false)
  })

  test('without a distance, time to contact comes from the growth of the box height', () => {
    const noDistance: Locator = (box) => ({
      clock: { position: 12, angleDeg: 0 },
      distanceM: null,
      distanceRoundedM: null,
      distanceSource: null,
      distanceGroundM: null,
      distanceBoxM: null,
      elevation: 'body',
      bottomHeightM: null,
      topHeightM: null,
      lateralOffsetM: null,
      inPath: false,
      touchesBottom: box.y + box.height >= 1,
      degraded: false,
    })
    const tracker = new Tracker(CLASSES, noDistance)
    let last = null
    for (let t = 0; t <= 1500; t += 67) {
      last = tracker.update(frameResult(t, [person(personAt(5 - (1.2 * t) / 1000))]), noLevel, SETTINGS)
    }
    const distance = 5 - 1.2 * 1.5
    const expectedS = distance / 1.2
    expect(last![0].closingSpeedMps).toBeNull()
    expect(Math.abs(last![0].timeToContactS! - expectedS) / expectedS).toBeLessThan(0.25)
    expect(last![0].approaching).toBe(true)
  })
})

describe('confirmation', () => {
  test('a one-frame false detection never confirms and is dropped', () => {
    const tracker = newTracker()
    const seen: string[] = []
    for (let i = 0; i < 8; i++) {
      const detections = i === 2 ? [person(personAt(6), 0.5)] : []
      const tracks = tracker.update(frameResult(i * 67, detections), noLevel, SETTINGS)
      seen.push(tracks.map((t) => t.status).join(','))
    }
    expect(seen.some((s) => s.includes('confirmed'))).toBe(false)
    expect(seen[seen.length - 1]).toBe('')
  })

  test('two matches in three frames confirm a far object', () => {
    const tracker = newTracker()
    expect(tracker.update(frameResult(0, [person(personAt(6))]), noLevel, SETTINGS)[0].status).toBe('tentative')
    expect(tracker.update(frameResult(67, [person(personAt(6))]), noLevel, SETTINGS)[0].status).toBe('confirmed')
  })

  test('a near, confident object confirms on its first frame; a near weak one does not', () => {
    const sure = newTracker().update(frameResult(0, [person(personAt(1.5), 0.85)]), noLevel, SETTINGS)
    expect(sure[0].status).toBe('confirmed')
    const weak = newTracker().update(frameResult(0, [person(personAt(1.5), 0.5)]), noLevel, SETTINGS)
    expect(weak[0].status).toBe('tentative')
  })

  test('a confirmed track survives a brief gap and keeps its id', () => {
    const tracker = newTracker()
    const box = personAt(5)
    tracker.update(frameResult(0, [person(box)]), noLevel, SETTINGS)
    const id = tracker.update(frameResult(67, [person(box)]), noLevel, SETTINGS)[0].id
    tracker.update(frameResult(134, []), noLevel, SETTINGS)
    tracker.update(frameResult(201, []), noLevel, SETTINGS)
    const after = tracker.update(frameResult(268, [person(box)]), noLevel, SETTINGS)
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(id)
  })
})

describe('identity', () => {
  test('turning the phone keeps a still object the same track, even when its box jumps further than its width', () => {
    const at = (heading: number) => ({ pitchDeg: 0, rollDeg: 0, headingDeg: heading })
    const tracker = newTracker()
    const facing = personAt(4, 0.5)
    tracker.update(frameResult(0, [person(facing)]), at(0), SETTINGS)
    const [first] = tracker.update(frameResult(67, [person(facing)]), at(0), SETTINGS)
    // turn 20 degrees right between frames: the person moves left by 20 / 65 of the picture
    const shifted = { ...facing, x: facing.x - 20 / SETTINGS.horizontalFovDeg }
    const [after] = tracker.update(frameResult(134, [person(shifted)]), at(20), SETTINGS)
    expect(after.id).toBe(first.id)
    expect(after.box.x).toBeCloseTo(shifted.x, 6)
  })

  test('without a heading nothing is shifted, and a jump that large starts a new track', () => {
    const tracker = newTracker()
    const facing = personAt(4, 0.5)
    tracker.update(frameResult(0, [person(facing)]), noLevel, SETTINGS)
    const [first] = tracker.update(frameResult(67, [person(facing)]), noLevel, SETTINGS)
    const shifted = { ...facing, x: facing.x - 20 / SETTINGS.horizontalFovDeg }
    const tracks = tracker.update(frameResult(134, [person(shifted)]), noLevel, SETTINGS)
    expect(tracks.map((t) => t.id)).not.toEqual([first.id])
  })

  test('two people crossing paths keep their ids', () => {
    const tracker = newTracker()
    let ids: number[] = []
    let final: { id: number; x: number }[] = []
    for (let i = 0; i <= 30; i++) {
      const t = i * 67
      // The nearer person (larger) walks left to right, the farther one right to left.
      const near = personAt(3, 0.2 + (0.6 * i) / 30)
      const far = personAt(5, 0.8 - (0.6 * i) / 30)
      const tracks = tracker.update(frameResult(t, [person(near), person(far)]), noLevel, SETTINGS)
      if (i === 3) ids = tracks.map((tr) => tr.id)
      final = tracks.map((tr) => ({ id: tr.id, x: tr.box.x + tr.box.width / 2 }))
    }
    expect(ids).toHaveLength(2)
    expect(final.map((f) => f.id).sort()).toEqual([...ids].sort())
    const nearId = ids[0]
    const nearFinal = final.find((f) => f.id === nearId)!
    expect(nearFinal.x).toBeGreaterThan(0.7)
  })

  test('different classes are never matched to each other', () => {
    const tracker = newTracker()
    const box = personAt(5)
    tracker.update(frameResult(0, [person(box)]), noLevel, SETTINGS)
    const tracks = tracker.update(frameResult(67, [{ classId: 56, label: 'chair', confidence: 0.8, box }]), noLevel, SETTINGS)
    expect(tracks.map((t) => t.label).sort()).toEqual(['chair', 'person'])
  })

  test('a small box that jumps beyond IoU still matches by center distance', () => {
    const tracker = newTracker()
    const small = (x: number): BoundingBox => ({ x, y: 0.5, width: 0.04, height: 0.08 })
    const first = tracker.update(frameResult(0, [person(small(0.5))]), noLevel, SETTINGS)
    const second = tracker.update(frameResult(67, [person(small(0.53))]), noLevel, SETTINGS)
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(first[0].id)
  })
})

describe('deletion', () => {
  test('an object that leaves the frame is deleted after the lost time', () => {
    const tracker = newTracker()
    let tracks: Track[] = []
    for (let i = 0; i < 5; i++) tracks = tracker.update(frameResult(i * 67, [person(personAt(5))]), noLevel, SETTINGS)
    expect(tracks[0].status).toBe('confirmed')
    const lastSeen = 4 * 67
    let t = lastSeen
    while (tracks.length > 0 && t < lastSeen + 3000) {
      t += 67
      tracks = tracker.update(frameResult(t, []), noLevel, SETTINGS)
    }
    expect(tracks).toHaveLength(0)
    expect(t - lastSeen).toBeGreaterThan(CONFIG.tracking.lostAfterMs)
    expect(t - lastSeen).toBeLessThanOrEqual(CONFIG.tracking.lostAfterMs + 67)
  })

  test('ids are not reused', () => {
    const tracker = newTracker()
    const first = tracker.update(frameResult(0, [person(personAt(5))]), noLevel, SETTINGS)[0].id
    tracker.update(frameResult(67, []), noLevel, SETTINGS)
    tracker.update(frameResult(134, []), noLevel, SETTINGS)
    const second = tracker.update(frameResult(201, [person(personAt(5))]), noLevel, SETTINGS)[0].id
    expect(second).toBeGreaterThan(first)
  })
})

describe('frame rate', () => {
  function walk(nextGap: () => number): { ttc: number; distance: number } {
    const tracker = newTracker()
    let t = 0
    let last = null
    while (t <= 2500) {
      last = tracker.update(frameResult(t, [person(personAt(6 - (1.2 * t) / 1000))]), noLevel, SETTINGS)
      t += nextGap()
    }
    return { ttc: last![0].timeToContactS!, distance: last![0].distanceM }
  }

  test('time to contact agrees across 8 fps, 15 fps, and jittery timing', () => {
    const random = rng(7)
    const slow = walk(() => 125)
    const fast = walk(() => 67)
    const jitter = walk(() => 40 + random() * 100)
    for (const run of [slow, jitter]) {
      expect(Math.abs(run.ttc / run.distance - fast.ttc / fast.distance)).toBeLessThan(0.25)
      expect(run.ttc).toBeGreaterThan(0)
    }
    expect(Math.abs(fast.ttc - fast.distance / 1.2) / (fast.distance / 1.2)).toBeLessThan(0.2)
  })
})

describe('stale and switching state', () => {
  test('a track that is no longer matched stops being approaching at once', () => {
    const tracker = newTracker()
    let last = null
    for (let t = 0; t <= 2500; t += 67) {
      last = tracker.update(frameResult(t, [person(personAt(6 - (1.2 * t) / 1000))]), noLevel, SETTINGS)
    }
    expect(last![0].approaching).toBe(true)
    const [after] = tracker.update(frameResult(2567, []), noLevel, SETTINGS)
    expect(after.status).toBe('confirmed')
    expect(after.approaching).toBe(false)
    expect(after.timeToContactS).toBeNull()
    expect(after.closingSpeedMps).toBeNull()
  })

  test('a change of distance method on a still object does not read as approaching', () => {
    const base = (distanceM: number, source: 'ground-plane' | 'box-size') => ({
      clock: { position: 12 as const, angleDeg: 0 },
      distanceM,
      distanceRoundedM: distanceM,
      distanceSource: source,
      distanceGroundM: null,
      distanceBoxM: null,
      elevation: 'body' as const,
      bottomHeightM: null,
      topHeightM: null,
      lateralOffsetM: 0,
      inPath: true,
      touchesBottom: false,
      degraded: false,
    })
    let frame = 0
    // Same object, same box; after 15 frames the method changes and the answer drops from 5 m to 3 m.
    const switching: Locator = () => (frame < 15 ? base(5, 'ground-plane') : base(3, 'box-size'))
    const tracker = new Tracker(CLASSES, switching)
    for (; frame < 40; frame++) {
      const [track] = tracker.update(frameResult(frame * 67, [person(personAt(5))]), noLevel, SETTINGS)
      expect(track.approaching).toBe(false)
    }
  })
})

describe('shake', () => {
  test('small random box shake on a still object does not trigger approaching', () => {
    const random = rng(42)
    const tracker = newTracker()
    for (let i = 0; i < 150; i++) {
      const base = personAt(3)
      const jitter = (amount: number) => (random() - 0.5) * 2 * amount
      const box: BoundingBox = {
        x: base.x + jitter(0.01),
        y: base.y + jitter(0.01),
        width: base.width * (1 + jitter(0.03)),
        height: base.height * (1 + jitter(0.03)),
      }
      const [track] = tracker.update(frameResult(i * 67, [person(box)]), noLevel, SETTINGS)
      expect(track.approaching).toBe(false)
    }
  })
})
