import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { Track } from '../core/types'
import { CLASSES } from '../detection/classes'
import { cleanTarget, detectorLabelFor, findYoloSighting, isDetectorLabel, QUICK_PICKS } from './targets'

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

describe('detectorLabelFor', () => {
  test('the quick-picks the detector knows map to a class, the rest go to Gemini', () => {
    expect(detectorLabelFor('Chair')).toBe('chair')
    expect(detectorLabelFor('Person')).toBe('person')
    for (const unknown of ['Exit', 'Door', 'Elevator', 'Stairs', 'Restroom sign', 'Trash can']) {
      expect(detectorLabelFor(unknown)).toBeNull()
    }
  })

  test('understands common names', () => {
    expect(detectorLabelFor('the sofa')).toBe('couch')
    expect(detectorLabelFor('my phone')).toBe('cell phone')
    expect(detectorLabelFor('table')).toBe('dining table')
  })

  test('every label in the table is a real class of the detector', () => {
    for (const name of ['person', 'chair', 'couch', 'sofa', 'bench', 'table', 'bed', 'toilet', 'sink', 'tv', 'laptop', 'phone', 'bottle', 'cup', 'backpack', 'suitcase', 'umbrella', 'bike', 'car', 'bus', 'dog', 'cat', 'plant', 'fridge', 'clock', 'book']) {
      const label = detectorLabelFor(name)
      expect(label, name).not.toBeNull()
      expect(isDetectorLabel(label!, CLASSES), `${name} -> ${label}`).toBe(true)
    }
  })
})

describe('findYoloSighting', () => {
  test('a confirmed track of the class gives its bearing and distance', () => {
    const sighting = findYoloSighting('chair', [track({ clock: { position: 1, angleDeg: 22 }, distanceM: 3 })])
    expect(sighting).toEqual({ angleDeg: 22, distanceM: 3 })
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
