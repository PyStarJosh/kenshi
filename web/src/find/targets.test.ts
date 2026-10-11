import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { Track } from '../core/types'
import { CLASSES } from '../detection/classes'
import {
  arrivalDistanceFor,
  cleanTarget,
  DETECTOR_SYNONYMS,
  detectorLabelsFor,
  findYoloSighting,
  isDetectorLabel,
  QUICK_PICKS,
} from './targets'

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

describe('QUICK_PICKS', () => {
  test('is the owner\'s list, in order', () => {
    expect([...QUICK_PICKS]).toEqual(['Exit', 'Door', 'Elevator', 'Stairs', 'Restroom sign', 'Chair', 'Trash can', 'Person'])
  })
})

describe('cleanTarget', () => {
  test.each([
    ['Chair', 'chair'],
    ['the Keys.', 'keys'],
    ['  my   red  backpack ', 'red backpack'],
    ['an elevator please', 'elevator'],
    ['Restroom sign', 'restroom sign'],
    ["it's here", "it's here"],
    ["the women's restroom", "women's restroom"],
    ['womens bathroom', "women's restroom"],
    ['ladies room', "women's restroom"],
    ['female toilets', "women's restroom"],
    ["men's room", "men's restroom"],
    ['mens restroom', "men's restroom"],
    ['male bathroom', "men's restroom"],
    ['the gents', "men's restroom"],
    ['bathroom', 'bathroom'],
    ['man', 'man'],
    ['living room', 'living room'],
  ])('%s -> %s', (text, expected) => {
    expect(cleanTarget(text)).toBe(expected)
  })

  test('is empty for nothing, punctuation, or just an article', () => {
    for (const text of ['', '   ', '...', 'the', 'a', 'my']) expect(cleanTarget(text)).toBe('')
  })

  test('is capped at the configured length', () => {
    expect(cleanTarget('x'.repeat(500))).toHaveLength(CONFIG.find.maxTargetChars)
  })
})

describe('detectorLabelsFor', () => {
  test('the quick-picks the detector knows map to a class, the rest go to Gemini', () => {
    expect(detectorLabelsFor('Chair')).toEqual(['chair'])
    expect(detectorLabelsFor('Person')).toEqual(['person'])
    for (const unknown of ['Exit', 'Door', 'Elevator', 'Stairs', 'Restroom sign', 'Trash can']) {
      expect(detectorLabelsFor(unknown), unknown).toEqual([])
    }
  })

  test('every one of the detector\'s 80 classes is reachable by its own label, its spoken name, and its plural', () => {
    expect(CLASSES).toHaveLength(80)
    for (const c of CLASSES) {
      expect(detectorLabelsFor(c.label), `label ${c.label}`).toEqual([c.label])
      expect(detectorLabelsFor(c.spokenName), `spoken ${c.spokenName}`).toContain(c.label)
      expect(detectorLabelsFor(c.label.toUpperCase()), `upper ${c.label}`).toEqual([c.label])
    }
  })

  test('plurals and articles are understood', () => {
    expect(detectorLabelsFor('the chairs')).toEqual(['chair'])
    expect(detectorLabelsFor('my backpacks')).toEqual(['backpack'])
    expect(detectorLabelsFor('benches')).toEqual(['bench'])
    expect(detectorLabelsFor('sandwiches')).toEqual(['sandwich'])
    expect(detectorLabelsFor('buses')).toEqual(['bus'])
    expect(detectorLabelsFor('scissors')).toEqual(['scissors'])
    expect(detectorLabelsFor('skis')).toEqual(['skis'])
    expect(detectorLabelsFor('traffic lights')).toEqual(['traffic light'])
  })

  test('everyday words reach the class they mean', () => {
    expect(detectorLabelsFor('the sofa')).toEqual(['couch'])
    expect(detectorLabelsFor('my phone')).toEqual(['cell phone'])
    expect(detectorLabelsFor('table')).toEqual(['dining table'])
    expect(detectorLabelsFor('fridge')).toEqual(['refrigerator'])
    expect(detectorLabelsFor('bike')).toEqual(['bicycle'])
    expect(detectorLabelsFor('mug')).toEqual(['cup'])
    expect(detectorLabelsFor('television')).toEqual(['tv'])
    expect(detectorLabelsFor('hair dryer')).toEqual(['hair drier'])
    expect(detectorLabelsFor('plant')).toEqual(['potted plant'])
  })

  test('a name that could be several things maps to each of them', () => {
    expect(detectorLabelsFor('bag')).toEqual(['handbag', 'backpack', 'suitcase'])
    expect(detectorLabelsFor('armchair')).toEqual(['chair', 'couch'])
  })

  test('a bathroom or restroom, men\'s or women\'s or not, goes to Gemini (it is found by its door or sign)', () => {
    for (const name of ['bathroom', 'restroom', 'washroom', 'loo', 'restroom sign', "women's restroom", "men's restroom", 'ladies room']) {
      expect(detectorLabelsFor(name), name).toEqual([])
    }
    expect(detectorLabelsFor('toilet')).toEqual(['toilet']) // the fixture on its own is still a detector class
  })

  test('whole names only: a modified name goes to Gemini, and odd words never match', () => {
    for (const name of ['orange chair', 'red backpack', 'door handle', 'exit sign', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '']) {
      expect(detectorLabelsFor(name), name).toEqual([])
    }
  })

  test('the synonym table only names real classes, and never captures one of the signs Gemini must find', () => {
    for (const [word, labels] of Object.entries(DETECTOR_SYNONYMS)) {
      expect(labels.length, word).toBeGreaterThan(0)
      for (const label of labels) expect(isDetectorLabel(label, CLASSES), `${word} -> ${label}`).toBe(true)
      for (const pick of QUICK_PICKS.map((p) => p.toLowerCase())) {
        if (!['chair', 'person'].includes(pick)) expect(word, `quick-pick ${pick}`).not.toBe(pick)
      }
    }
  })
})

describe('findYoloSighting', () => {
  test('a confirmed track of the class gives its bearing and distance', () => {
    const sighting = findYoloSighting('chair', [track({ id: 4, clock: { position: 1, angleDeg: 22 }, distanceM: 3 })])
    expect(sighting).toEqual({ angleDeg: 22, distanceM: 3, trackId: 4, clipped: false })
  })

  test('says whether the box runs off the bottom of the frame', () => {
    const cut = track({ box: { x: 0.4, y: 0.5, width: 0.2, height: 0.5 } })
    const whole = track({ box: { x: 0.4, y: 0.3, width: 0.2, height: 0.5 } })
    expect(findYoloSighting('chair', [cut])?.clipped).toBe(true)
    expect(findYoloSighting('chair', [whole])?.clipped).toBe(false)
  })

  test('keeps following the object it is told to prefer, even when another is nearer', () => {
    const near = track({ id: 1, distanceM: 1.5, clock: { position: 12, angleDeg: 5 } })
    const far = track({ id: 2, distanceM: 4, clock: { position: 12, angleDeg: -10 } })
    expect(findYoloSighting('chair', [near, far], 2)).toMatchObject({ trackId: 2, angleDeg: -10 })
    expect(findYoloSighting('chair', [near, far], 99)).toMatchObject({ trackId: 1 }) // gone: the nearest instead
    expect(findYoloSighting('chair', [near, far], null)).toMatchObject({ trackId: 1 })
  })

  test('given where the object was, a lost track is replaced only by one on that spot', () => {
    const here = track({ id: 3, distanceM: 4, clock: { position: 12, angleDeg: 6 } })
    const elsewhere = track({ id: 4, distanceM: 1.5, clock: { position: 12, angleDeg: 70 } })
    const where = { angleDeg: 0, maxDeg: 35 }
    expect(findYoloSighting('chair', [elsewhere, here], 99, where)).toMatchObject({ trackId: 3 }) // not the nearer one
    expect(findYoloSighting('chair', [elsewhere], 99, where)).toBeNull()
    expect(findYoloSighting('chair', [elsewhere, here], 4, where)).toMatchObject({ trackId: 4 }) // the followed id still wins
    const close = track({ id: 5, clock: { position: 12, angleDeg: -2 } })
    expect(findYoloSighting('chair', [here, close], null, where)).toMatchObject({ trackId: 5 }) // the closest to the spot
  })

  test('works through synonyms and for names that stand for several classes', () => {
    expect(findYoloSighting('sofa', [track({ label: 'couch', clock: { position: 1, angleDeg: 15 } })])?.angleDeg).toBe(15)
    const sink = track({ label: 'sink', distanceM: 2, clock: { position: 12, angleDeg: -8 } })
    const toilet = track({ id: 2, label: 'toilet', distanceM: 3, clock: { position: 12, angleDeg: 20 } })
    expect(findYoloSighting('bathroom', [toilet, sink])).toBeNull() // a bathroom is Gemini's to find
    expect(findYoloSighting('toilet', [toilet, sink])?.angleDeg).toBe(20)
    expect(findYoloSighting('bag', [track({ label: 'backpack', clock: { position: 12, angleDeg: 3 } })])?.angleDeg).toBe(3)
  })

  test('ignores tentative tracks, other classes, and targets the detector does not know', () => {
    expect(findYoloSighting('chair', [track({ status: 'tentative' })])).toBeNull()
    expect(findYoloSighting('chair', [track({ label: 'person' })])).toBeNull()
    expect(findYoloSighting('exit', [track()])).toBeNull()
    expect(findYoloSighting('chair', [])).toBeNull()
  })

  test('with several, takes the nearest, then the most confident', () => {
    const near = track({ id: 1, distanceM: 1.5, clock: { position: 12, angleDeg: 5 } })
    const far = track({ id: 2, distanceM: 4, clock: { position: 12, angleDeg: -10 } })
    expect(findYoloSighting('chair', [far, near])?.angleDeg).toBe(5)
    expect(findYoloSighting('chair', [far])?.angleDeg).toBe(-10)
    const sure = track({ id: 4, distanceM: 2, confidence: 0.95, clock: { position: 12, angleDeg: 1 } })
    const unsure = track({ id: 5, distanceM: 2, confidence: 0.6, clock: { position: 12, angleDeg: 2 } })
    expect(findYoloSighting('chair', [unsure, sure])?.angleDeg).toBe(1)
  })
})

describe('arrivalDistanceFor', () => {
  test('stairs count as within reach from 2 m, doors, exits, elevators and restrooms from 1.5 m, anything else from 1 m', () => {
    for (const stairs of ['stairs', 'staircase', 'steps', 'escalator']) expect(arrivalDistanceFor(stairs, false), stairs).toBe(2)
    for (const door of ['door', 'exit', 'elevator', 'lift', "women's restroom", 'restroom sign', 'bathroom', 'front entrance']) {
      expect(arrivalDistanceFor(door, false), door).toBe(1.5)
    }
    for (const other of ['chair', 'trash can', 'person', 'keys', 'doormat']) expect(arrivalDistanceFor(other, false), other).toBe(1)
  })

  test('a box cut off at the bottom (an upper bound) is judged against at least the clipped limit', () => {
    expect(arrivalDistanceFor('chair', true)).toBe(CONFIG.find.arrivalClippedM)
    expect(arrivalDistanceFor('stairs', true)).toBe(2)
  })
})
