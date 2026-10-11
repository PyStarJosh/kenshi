import { describe, expect, test } from 'vitest'
import type { ClockPosition, Elevation } from '../core/types'
import {
  clockPhrase,
  distancePhrase,
  elevationPhrase,
  obstaclePhrase,
  SUMMARY_NONE,
  summaryPhrase,
} from './phrases'
import type { PhraseInput } from './phrases'

const input = (overrides: Partial<PhraseInput> = {}): PhraseInput => ({
  spokenName: 'chair',
  clock: 12,
  distanceM: 1.5,
  elevation: 'body',
  ...overrides,
})

describe('the examples from the spec', () => {
  test('a chair straight ahead', () => {
    expect(obstaclePhrase(input())).toBe("Chair, 12 o'clock, about 1.5 meters.")
  })

  test('a pole at the far right with no distance', () => {
    expect(obstaclePhrase(input({ spokenName: 'pole', clock: 'far-right', distanceM: null }))).toBe('Pole, far right.')
  })

  test('a backpack on the floor at 1 o clock', () => {
    expect(obstaclePhrase(input({ spokenName: 'backpack', clock: 1, distanceM: 2, elevation: 'floor' }))).toBe(
      "Backpack, 1 o'clock, about 2 meters, on the floor.",
    )
  })
})

describe('every combination', () => {
  const clocks: [ClockPosition, string][] = [
    ['far-left', 'far left'],
    [11, "11 o'clock"],
    [12, "12 o'clock"],
    [1, "1 o'clock"],
    ['far-right', 'far right'],
  ]
  const distances: [number | null, string | null][] = [
    [null, null],
    [0.2, 'about 0.5 meters'],
    [0.5, 'about 0.5 meters'],
    [1, 'about 1 meter'],
    [1.2, 'about 1 meter'],
    [1.5, 'about 1.5 meters'],
    [2, 'about 2 meters'],
    [3.7, 'about 3.5 meters'],
    [4, 'about 4 meters'],
  ]
  const elevations: [Elevation, string | null][] = [
    ['body', null],
    ['floor', 'on the floor'],
    ['head', 'at head height'],
  ]

  test.each(clocks.flatMap((c) => distances.flatMap((d) => elevations.map((e) => [c, d, e] as const))))(
    'clock %j, distance %j, elevation %j',
    (clock, distance, elevation) => {
      const expected = ['Door', clock[1], distance[1], elevation[1]].filter((part) => part !== null).join(', ') + '.'
      expect(obstaclePhrase({ spokenName: 'door', clock: clock[0], distanceM: distance[0], elevation: elevation[0] })).toBe(
        expected,
      )
    },
  )

  test('the parts are always in the order object, clock, distance, elevation', () => {
    const phrase = obstaclePhrase(input({ distanceM: 2, elevation: 'head' }))
    expect(phrase.indexOf('Chair')).toBe(0)
    expect(phrase.indexOf("12 o'clock")).toBeLessThan(phrase.indexOf('about 2'))
    expect(phrase.indexOf('about 2')).toBeLessThan(phrase.indexOf('at head height'))
  })
})

describe('the parts', () => {
  test('names are capitalized, including two-word names', () => {
    expect(obstaclePhrase(input({ spokenName: 'fire hydrant' }))).toMatch(/^Fire hydrant, /)
  })

  test.each([
    ['far-left', 'far left'],
    ['far-right', 'far right'],
    [11, "11 o'clock"],
    [12, "12 o'clock"],
    [1, "1 o'clock"],
  ] as const)('clock %s reads %s', (position, expected) => {
    expect(clockPhrase(position)).toBe(expected)
  })

  test('distance is rounded to the nearest half meter, never below half a meter, and 1 is singular', () => {
    expect(distancePhrase(1.74)).toBe('about 1.5 meters')
    expect(distancePhrase(1.76)).toBe('about 2 meters')
    expect(distancePhrase(0.1)).toBe('about 0.5 meters')
    expect(distancePhrase(1)).toBe('about 1 meter')
  })

  test('an unknown or non-finite distance is left out', () => {
    expect(distancePhrase(null)).toBeNull()
    expect(distancePhrase(Number.NaN)).toBeNull()
    expect(distancePhrase(Number.POSITIVE_INFINITY)).toBeNull()
  })

  test('body has no height suffix', () => {
    expect(elevationPhrase('body')).toBeNull()
  })
})

describe('summary', () => {
  test('joins the objects in the order given', () => {
    const text = summaryPhrase([input({ spokenName: 'person', clock: 11, distanceM: 3 }), input({ clock: 1 })])
    expect(text).toBe("Person, 11 o'clock, about 3 meters. Chair, 1 o'clock, about 1.5 meters.")
  })

  test('with nothing detected it says so as a limit', () => {
    expect(summaryPhrase([])).toBe(SUMMARY_NONE)
  })
})

describe('safety wording (SR-2)', () => {
  const banned = /\b(clear|safe|safely|free|all good|no obstacles?|nothing there)\b/i

  test('no phrase says the path is clear, safe, or free', () => {
    const everything: string[] = [SUMMARY_NONE, summaryPhrase([])]
    for (const clock of [11, 12, 1, 'far-left', 'far-right'] as const) {
      for (const distanceM of [null, 0.5, 2]) {
        for (const elevation of ['body', 'floor', 'head'] as const) {
          everything.push(obstaclePhrase({ spokenName: 'chair', clock, distanceM, elevation }))
        }
      }
    }
    for (const text of everything) expect(text).not.toMatch(banned)
  })

  test('the none-detected sentence states a limit', () => {
    expect(SUMMARY_NONE).toMatch(/miss things/)
  })
})
