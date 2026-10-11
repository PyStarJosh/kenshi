import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { FindSnapshot } from '../core/types'
import {
  bearingRotation,
  directionText,
  distanceSpeech,
  distanceText,
  initialViewMemory,
  isAligned,
  justFound,
  makeView,
  ringArcs,
} from './findView'

const snap = (patch: Partial<FindSnapshot> = {}): FindSnapshot => ({
  state: 'idle',
  target: null,
  bearingDeg: null,
  distanceM: null,
  distanceIsBound: false,
  source: null,
  sweepFrames: 0,
  ...patch,
})

describe('bearingRotation', () => {
  test('the arrow turns by the bearing: right is clockwise, left is counterclockwise, ahead is up', () => {
    expect(bearingRotation(0, 0)).toBe(0)
    expect(bearingRotation(30, 0)).toBe(30)
    expect(bearingRotation(-45, 0)).toBe(-45)
    expect(bearingRotation(90, 0)).toBe(90)
  })

  test('behind is half a turn either way, whichever side it was on', () => {
    expect(bearingRotation(180, 0)).toBe(180)
    expect(bearingRotation(-180, 170)).toBe(180) // 170 -> -180 is a 10 degree turn the same way, not 350 back
  })

  test('it never takes the long way round: crossing the back keeps counting on', () => {
    let rotation = 0
    const seen: number[] = []
    for (const bearing of [150, 170, 180, -170, -150, -100]) {
      rotation = bearingRotation(bearing, rotation)
      seen.push(rotation)
    }
    expect(seen).toEqual([150, 170, 180, 190, 210, 260])
    // and the other way
    rotation = 0
    const back: number[] = []
    for (const bearing of [-150, -170, 180, 170, 150]) {
      rotation = bearingRotation(bearing, rotation)
      back.push(rotation)
    }
    expect(back).toEqual([-150, -170, -180, -190, -210])
  })

  test('every step is a short turn', () => {
    let rotation = 0
    for (let bearing = -180; bearing <= 540; bearing += 17) {
      const next = bearingRotation(bearing, rotation)
      expect(Math.abs(next - rotation)).toBeLessThanOrEqual(180)
      expect(((next - bearing) % 360 + 360) % 360).toBeCloseTo(0, 6) // still the same direction
      rotation = next
    }
  })

  test('no bearing leaves the arrow where it was', () => {
    expect(bearingRotation(null, 42)).toBe(42)
    expect(bearingRotation(Number.NaN, 42)).toBe(42)
  })
})

describe('isAligned', () => {
  test('under 15 degrees is aligned, 15 is not', () => {
    expect(isAligned(0, false)).toBe(true)
    expect(isAligned(14.9, false)).toBe(true)
    expect(isAligned(-14.9, false)).toBe(true)
    expect(isAligned(15, false)).toBe(false)
    expect(isAligned(-30, false)).toBe(false)
  })

  test('once aligned it stays so out to 20 degrees, so the green does not flicker at the edge', () => {
    expect(isAligned(17, true)).toBe(true)
    expect(isAligned(20, true)).toBe(true)
    expect(isAligned(-20, true)).toBe(true)
    expect(isAligned(20.1, true)).toBe(false)
    expect(isAligned(17, false)).toBe(false)
  })

  test('no bearing is never aligned', () => {
    expect(isAligned(null, true)).toBe(false)
    expect(isAligned(Number.NaN, true)).toBe(false)
  })

  test('the numbers are 15 and 20', () => {
    expect([CONFIG.find.alignedEnterDeg, CONFIG.find.alignedExitDeg]).toEqual([15, 20])
  })
})

describe('distance text', () => {
  test('whole and half meters read like "6 m" and "2.5 m"', () => {
    expect(distanceText(6, false)).toBe('6 m')
    expect(distanceText(2.5, false)).toBe('2.5 m')
    expect(distanceText(0.5, false)).toBe('0.5 m')
    expect(distanceText(10, false)).toBe('10 m')
  })

  test('unknown is "--"', () => {
    expect(distanceText(null, false)).toBe('--')
    expect(distanceText(null, true)).toBe('--')
    expect(distanceText(Number.NaN, false)).toBe('--')
    expect(distanceText(-1, false)).toBe('--')
  })

  test('an upper bound is shown as one, never as a measurement', () => {
    expect(distanceText(2.5, true)).toBe('< 2.5 m')
    expect(distanceText(4, true)).toBe('< 4 m')
  })

  test('for a screen reader: "6 meters", "under 2.5 meters", "distance unknown"', () => {
    expect(distanceSpeech(6, false)).toBe('6 meters')
    expect(distanceSpeech(1, false)).toBe('1 meter')
    expect(distanceSpeech(2.5, true)).toBe('under 2.5 meters')
    expect(distanceSpeech(null, false)).toBe('distance unknown')
  })
})

describe('direction text', () => {
  test('ahead, to your right, to your left, behind you', () => {
    expect(directionText('ahead')).toBe('ahead')
    expect(directionText('right')).toBe('to your right')
    expect(directionText('left')).toBe('to your left')
    expect(directionText('behind')).toBe('behind you')
    expect(directionText('slightly-right')).toBe('slightly to your right')
  })
})

describe('the sweep ring', () => {
  test('eight segments around the circle, filled in order, with a gap between them', () => {
    const arcs = ringArcs(8, 3)
    expect(arcs).toHaveLength(8)
    expect(arcs.filter((a) => a.filled)).toHaveLength(3)
    expect(arcs.map((a) => a.filled)).toEqual([true, true, true, false, false, false, false, false])
    expect(arcs[0].startDeg).toBeCloseTo(3, 9)
    expect(arcs[0].endDeg).toBeCloseTo(42, 9)
    expect(arcs[7].endDeg).toBeCloseTo(357, 9)
    for (let i = 1; i < 8; i++) expect(arcs[i].startDeg).toBeGreaterThan(arcs[i - 1].endDeg)
  })

  test('none and all', () => {
    expect(ringArcs(8, 0).some((a) => a.filled)).toBe(false)
    expect(ringArcs(8, 8).every((a) => a.filled)).toBe(true)
  })
})

describe('which screen', () => {
  const view = (patch: Partial<FindSnapshot>, found = false, memory = initialViewMemory()) =>
    makeView(snap(patch), found, memory)

  test('idle is the home screen, with no Stop button', () => {
    const { view: home } = view({})
    expect(home.kind).toBe('home')
    expect(home.title).toBe('Find')
    expect(home.showStop).toBe(false)
    expect(home.liveText).toBe('')
  })

  test('looking, then the sweep ring that fills as frames are taken, then "checking" with the ring full', () => {
    expect(view({ state: 'checking', target: 'exit' }).view).toMatchObject({ kind: 'looking', title: 'Exit', showStop: true })
    const sweeping = view({ state: 'sweeping', target: 'exit', sweepFrames: 3 }).view
    expect(sweeping).toMatchObject({ kind: 'sweeping', headline: 'Turn slowly', ring: { filled: 3, total: 8 } })
    expect(view({ state: 'sweeping', target: 'exit', sweepFrames: 0 }).view.ring).toEqual({ filled: 0, total: 8 })
    expect(view({ state: 'sweeping', target: 'exit', sweepFrames: 99 }).view.ring?.filled).toBe(8)
    expect(view({ state: 'sweepChecking', target: 'exit', sweepFrames: 8 }).view).toMatchObject({
      headline: 'Checking...',
      ring: { filled: 8, total: 8 },
    })
  })

  test('guiding: the target at the top, the arrow turned by the bearing, the distance, the direction', () => {
    const { view: v } = view({ state: 'guiding', target: 'chair', bearingDeg: 40, distanceM: 6, source: 'gemini' })
    expect(v).toMatchObject({
      kind: 'guiding',
      title: 'Chair',
      rotationDeg: 40,
      arrowKnown: true,
      aligned: false,
      distanceText: '6 m',
      directionText: 'slightly to your right',
      check: false,
    })
  })

  test('guiding and facing the target: aligned, so the background turns green', () => {
    expect(view({ state: 'guiding', target: 'chair', bearingDeg: 5, distanceM: 6 }).view.aligned).toBe(true)
    expect(view({ state: 'guiding', target: 'chair', bearingDeg: 5, distanceM: 6 }).view.directionText).toBe('ahead')
    expect(view({ state: 'guiding', target: 'chair', bearingDeg: 40, distanceM: 6 }).view.aligned).toBe(false)
  })

  test('the green holds across the edge using what the view remembered', () => {
    let memory = initialViewMemory()
    const aligned: boolean[] = []
    for (const bearing of [10, 16, 19, 21, 18, 14]) {
      const out = makeView(snap({ state: 'guiding', target: 'chair', bearingDeg: bearing }), false, memory)
      memory = out.memory
      aligned.push(out.view.aligned)
    }
    expect(aligned).toEqual([true, true, true, false, false, true])
  })

  test('behind you turns the arrow right round', () => {
    const { view: v } = view({ state: 'guiding', target: 'chair', bearingDeg: 175, distanceM: 4 })
    expect(v.rotationDeg).toBe(175)
    expect(v.directionText).toBe('behind you')
  })

  test('an unknown distance is "--", and an upper bound is shown as "<"', () => {
    expect(view({ state: 'guiding', target: 'chair', bearingDeg: 0, distanceM: null }).view.distanceText).toBe('--')
    expect(view({ state: 'guiding', target: 'chair', bearingDeg: 0, distanceM: 2.5, distanceIsBound: true }).view.distanceText).toBe('< 2.5 m')
  })

  test('with no heading the arrow is drawn but unknown, and it says so', () => {
    const { view: v } = view({ state: 'guiding', target: 'chair', bearingDeg: null, distanceM: 3 })
    expect(v.arrowKnown).toBe(false)
    expect(v.aligned).toBe(false)
    expect(v.headline).toMatch(/unknown/)
  })

  test('the Found screen comes first, with a check mark, then the guiding view', () => {
    const found = view({ state: 'guiding', target: 'exit', bearingDeg: 30, distanceM: 6 }, true).view
    expect(found).toMatchObject({ kind: 'found', headline: 'Found: Exit', check: true, liveText: 'Found: Exit.' })
    expect(view({ state: 'guiding', target: 'exit', bearingDeg: 30, distanceM: 6 }, false).view.kind).toBe('guiding')
  })

  test('arrived: "Within reach" with a check mark, and it is aligned (green)', () => {
    expect(view({ state: 'arrived', target: 'chair' }).view).toMatchObject({
      kind: 'arrived',
      headline: 'Within reach',
      check: true,
      aligned: true,
    })
  })

  test('not found and error say so plainly, and keep the Stop button', () => {
    expect(view({ state: 'notFound', target: 'chair' }).view).toMatchObject({
      kind: 'notFound',
      headline: "Couldn't find chair here",
      showStop: true,
    })
    expect(view({ state: 'error', target: 'chair' }).view).toMatchObject({ kind: 'error', headline: "Find isn't available right now" })
  })

  test('the screen-reader sentence names the state and never the changing bearing or distance', () => {
    const a = view({ state: 'guiding', target: 'chair', bearingDeg: 10, distanceM: 6 }).view.liveText
    const b = view({ state: 'guiding', target: 'chair', bearingDeg: 120, distanceM: 2 }).view.liveText
    expect(a).toBe('Guiding to chair.')
    expect(b).toBe(a)
  })

  test('leaving guiding forgets the arrow, so the next search starts from straight up', () => {
    const guiding = makeView(snap({ state: 'guiding', target: 'chair', bearingDeg: 170 }), false, initialViewMemory())
    expect(guiding.memory.rotationDeg).toBe(170)
    const after = makeView(snap({ state: 'checking', target: 'chair' }), false, guiding.memory)
    expect(after.memory).toEqual(initialViewMemory())
  })
})

describe('the Found screen trigger', () => {
  test('it comes up when the search finds the target, from any search state or straight from idle (the detector)', () => {
    for (const previous of ['idle', 'checking', 'sweeping', 'sweepChecking', 'lost'] as const) {
      expect(justFound(previous, 'guiding')).toBe(true)
    }
  })

  test('not on every update while guiding, and not for other states', () => {
    expect(justFound('guiding', 'guiding')).toBe(false)
    expect(justFound('checking', 'sweeping')).toBe(false)
    expect(justFound('guiding', 'arrived')).toBe(false)
    expect(justFound('arrived', 'idle')).toBe(false)
  })

  test('the Found screen lasts 1.5 seconds', () => {
    expect(CONFIG.find.foundScreenMs).toBe(1500)
  })
})
