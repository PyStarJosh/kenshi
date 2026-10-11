import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { countdownPhrase, GUIDANCE_PHRASES, initialGuidance, instructionFor, nextGuidance, seedGuidance } from './guidance'
import type { GuidanceInput, GuidanceState } from './guidance'

const CFG = CONFIG.find
/** Config with the repeat switched off, for tests about hysteresis and the countdown alone. */
const NO_REPEAT = { ...CFG, guidanceRepeatMs: 1e9 }

const input = (patch: Partial<GuidanceInput> = {}): GuidanceInput => ({
  bearing: 0,
  distanceM: null,
  state: 'guiding',
  label: 'chair',
  nowMs: 10_000,
  ...patch,
})

/** Feed a sequence of inputs, 3 s apart, and return what was said at each step. */
function run(steps: Partial<GuidanceInput>[], start: GuidanceState = initialGuidance(), cfg = NO_REPEAT) {
  let state = start
  let nowMs = 10_000
  const said: (string | null)[] = []
  for (const step of steps) {
    const result = nextGuidance(state, input({ ...step, nowMs }), cfg)
    state = result.state
    said.push(result.say)
    nowMs += 3000
  }
  return { state, said }
}

describe('the words', () => {
  test.each([
    [0, 'Straight ahead.'],
    [14, 'Straight ahead.'],
    [-14, 'Straight ahead.'],
    [16, 'Bear right.'],
    [-16, 'Bear left.'],
    [45, 'Bear right.'],
    [46, 'Turn right.'],
    [-46, 'Turn left.'],
    [90, 'Turn right.'],
    [135, 'Turn right.'],
    [136, 'Turn around.'],
    [-136, 'Turn around.'],
    [180, 'Turn around.'],
  ])('a bearing of %d degrees says "%s"', (bearing, phrase) => {
    expect(nextGuidance(initialGuidance(), input({ bearing })).say).toBe(phrase)
  })

  test('every instruction has its sentence, and an obstacle detour names the side', () => {
    expect(GUIDANCE_PHRASES['around-left']).toBe('Bear left around the obstacle.')
    expect(GUIDANCE_PHRASES['around-right']).toBe('Bear right around the obstacle.')
    expect(instructionFor('behind')).toBe('turn-around')
    expect(Object.values(GUIDANCE_PHRASES)).toHaveLength(8)
  })
})

describe('hysteresis', () => {
  test('about 5 degrees at each boundary, so a bearing that wobbles on the line says nothing new', () => {
    expect(CFG.directionHysteresisDeg).toBe(5)
    // Settle on "Straight ahead", then wobble around 15 degrees.
    const wobble = run([{ bearing: 0 }, { bearing: 16 }, { bearing: 14 }, { bearing: 18 }, { bearing: 12 }, { bearing: 20 }])
    expect(wobble.said).toEqual(['Straight ahead.', null, null, null, null, null])
  })

  test('it switches once the bearing is clearly past the boundary, and back once it is clearly inside it', () => {
    const out = run([{ bearing: 0 }, { bearing: 21 }, { bearing: 13 }, { bearing: 10 }])
    expect(out.said).toEqual(['Straight ahead.', 'Bear right.', null, 'Straight ahead.'])
  })

  test('the same at 45 and at 135 degrees', () => {
    expect(run([{ bearing: 30 }, { bearing: 46 }, { bearing: 50 }, { bearing: 51 }]).said).toEqual([
      'Bear right.',
      null,
      null,
      'Turn right.',
    ])
    expect(run([{ bearing: 100 }, { bearing: 136 }, { bearing: 140 }, { bearing: 141 }]).said).toEqual([
      'Turn right.',
      null,
      null,
      'Turn around.',
    ])
    expect(run([{ bearing: 160 }, { bearing: 134 }, { bearing: 131 }, { bearing: 130 }]).said).toEqual([
      'Turn around.',
      null,
      null,
      'Turn right.',
    ])
  })

  test('left and right are symmetric', () => {
    expect(run([{ bearing: 0 }, { bearing: -21 }]).said).toEqual(['Straight ahead.', 'Bear left.'])
    expect(run([{ bearing: -100 }, { bearing: -136 }, { bearing: -141 }]).said).toEqual(['Turn left.', null, 'Turn around.'])
  })
})

describe('throttling', () => {
  test('a change waits for the minimum gap after the last phrase, and is then said, not lost', () => {
    const first = nextGuidance(initialGuidance(), input({ bearing: 0, nowMs: 10_000 }))
    expect(first.say).toBe('Straight ahead.')
    const tooSoon = nextGuidance(first.state, input({ bearing: 60, nowMs: 10_000 + CFG.guideSpeechCooldownMs - 1 }))
    expect(tooSoon.say).toBeNull()
    const later = nextGuidance(tooSoon.state, input({ bearing: 60, nowMs: 10_000 + CFG.guideSpeechCooldownMs }))
    expect(later.say).toBe('Turn right.')
  })

  test('the same instruction is not said again until the repeat time, and then again every repeat time', () => {
    let state = nextGuidance(initialGuidance(), input({ bearing: 60, nowMs: 0 })).state // "Turn right." at 0
    const at = (nowMs: number) => {
      const result = nextGuidance(state, input({ bearing: 60, nowMs }))
      state = result.state
      return result.say
    }
    expect(at(1000)).toBeNull()
    expect(at(CFG.guidanceRepeatMs - 1)).toBeNull()
    expect(at(CFG.guidanceRepeatMs)).toBe('Turn right.')
    expect(at(CFG.guidanceRepeatMs + 1000)).toBeNull()
    expect(at(2 * CFG.guidanceRepeatMs)).toBe('Turn right.')
  })

  test('"Straight ahead" is said when it becomes true and then left alone: the beacon already says it', () => {
    let state = nextGuidance(initialGuidance(), input({ bearing: 2, nowMs: 0 })).state
    for (let t = 1000; t <= 60_000; t += 1000) {
      const result = nextGuidance(state, input({ bearing: 2, nowMs: t }))
      state = result.state
      expect(result.say).toBeNull()
    }
  })

  test('the repeat time is 5 seconds', () => {
    expect(CFG.guidanceRepeatMs).toBe(5000)
  })

  test('right after "<label> found, <direction>." the same instruction is not said again', () => {
    const seeded = seedGuidance('slightly-right', 0)
    expect(nextGuidance(seeded, input({ bearing: 25, nowMs: 3000 })).say).toBeNull()
    expect(nextGuidance(seeded, input({ bearing: 25, nowMs: CFG.guidanceRepeatMs })).say).toBe('Bear right.')
  })

  test('outside guiding it says nothing and forgets everything', () => {
    const talked = nextGuidance(initialGuidance(), input({ bearing: 60 })).state
    for (const state of ['idle', 'checking', 'sweeping', 'lost', 'arrived', 'error', 'notFound'] as const) {
      const result = nextGuidance(talked, input({ bearing: 60, state, nowMs: 99_000 }))
      expect(result.say).toBeNull()
      expect(result.state).toEqual(initialGuidance())
    }
  })
})

describe('the distance countdown', () => {
  const ahead = (distanceM: number | null, patch: Partial<GuidanceInput> = {}): Partial<GuidanceInput> => ({
    bearing: 2,
    distanceM,
    ...patch,
  })

  test('says the label and about N meters on crossing 10, 5, 3 and 2, once each', () => {
    const out = run([ahead(12), ahead(10.4), ahead(9.8), ahead(7), ahead(5.2), ahead(4.9), ahead(3.5), ahead(2.9), ahead(2.5), ahead(1.9), ahead(1.2)])
    // The first step is the instruction ("Straight ahead."); the rest are the countdown.
    expect(out.said).toEqual([
      'Straight ahead.',
      null,
      'chair, about 10 meters.',
      null,
      null,
      'chair, about 5 meters.',
      null,
      'chair, about 3 meters.',
      null,
      'chair, about 2 meters.',
      null,
    ])
  })

  test('the levels are 10, 5, 3 and 2 meters', () => {
    expect([...CFG.countdownM]).toEqual([10, 5, 3, 2])
    expect(countdownPhrase('exit', 3)).toBe('exit, about 3 meters.')
  })

  test('jumping over several levels says only the nearest, and counts them all as done', () => {
    const out = run([ahead(12), ahead(2.6), ahead(2.4), ahead(2.0)])
    expect(out.said).toEqual(['Straight ahead.', 'chair, about 3 meters.', null, 'chair, about 2 meters.'])
    expect(out.state.announced.sort()).toEqual([10, 2, 3, 5])
  })

  test('a level is announced again if the user moves back out past it and comes in again', () => {
    const out = run([ahead(12), ahead(4.9), ahead(4.0), ahead(5.6), ahead(4.8)])
    expect(out.said).toEqual(['Straight ahead.', 'chair, about 5 meters.', null, null, 'chair, about 5 meters.'])
  })

  test('only while roughly facing the target', () => {
    const out = run([ahead(4.9, { bearing: 40 }), ahead(4.9, { bearing: 60 })])
    expect(out.said[0]).toBe('Bear right.')
    expect(out.said[1]).toBe('Turn right.') // not facing it: the instruction, and no countdown
    const turned = run([{ bearing: 0, distanceM: 12 }, { bearing: 80, distanceM: 4.9 }, { bearing: 80, distanceM: 4.9 }])
    expect(turned.said.slice(2)).toEqual([null])
  })

  test('not from a distance that is only an upper bound, or an unknown one', () => {
    const bound = run([ahead(12, { distanceIsBound: true }), ahead(4.9, { distanceIsBound: true }), ahead(1.9, { distanceIsBound: true })])
    expect(bound.said).toEqual(['Straight ahead.', null, null])
    const unknown = run([ahead(null), ahead(null)])
    expect(unknown.said).toEqual(['Straight ahead.', null])
  })

  test('an instruction that is due comes before the countdown, and the countdown follows when it can', () => {
    const state = nextGuidance(initialGuidance(), input({ bearing: 2, distanceM: 12, nowMs: 0 }), NO_REPEAT).state
    const both = nextGuidance(state, input({ bearing: 25, distanceM: 4.9, nowMs: CFG.guideSpeechCooldownMs }), NO_REPEAT)
    expect(both.say).toBe('Bear right.')
    const next = nextGuidance(both.state, input({ bearing: 25, distanceM: 4.9, nowMs: 2 * CFG.guideSpeechCooldownMs }), NO_REPEAT)
    expect(next.say).toBe('chair, about 5 meters.')
  })

  test('the countdown waits for the minimum gap too', () => {
    const state = nextGuidance(initialGuidance(), input({ bearing: 2, distanceM: 12, nowMs: 0 }), NO_REPEAT).state
    expect(nextGuidance(state, input({ bearing: 2, distanceM: 4.9, nowMs: 1000 }), NO_REPEAT).say).toBeNull()
    expect(nextGuidance(state, input({ bearing: 2, distanceM: 4.9, nowMs: CFG.guideSpeechCooldownMs }), NO_REPEAT).say).toBe(
      'chair, about 5 meters.',
    )
  })
})

describe('going around an obstacle', () => {
  test('straight ahead with the path line saying left or right: bear that way around the obstacle', () => {
    expect(nextGuidance(initialGuidance(), input({ bearing: 3, pathDecision: 'left' })).say).toBe('Bear left around the obstacle.')
    expect(nextGuidance(initialGuidance(), input({ bearing: -3, pathDecision: 'right' })).say).toBe('Bear right around the obstacle.')
  })

  test('with no path line, or one that says straight, it is just straight ahead', () => {
    for (const pathDecision of [undefined, null, 'straight' as const]) {
      expect(nextGuidance(initialGuidance(), input({ bearing: 3, pathDecision })).say).toBe('Straight ahead.')
    }
  })

  test('when the target is not straight ahead, the turn comes first', () => {
    expect(nextGuidance(initialGuidance(), input({ bearing: 60, pathDecision: 'left' })).say).toBe('Turn right.')
    expect(nextGuidance(initialGuidance(), input({ bearing: 30, pathDecision: 'left' })).say).toBe('Bear right.')
  })

  test('the detour is an instruction like any other: said on change and repeated until followed', () => {
    let state = nextGuidance(initialGuidance(), input({ bearing: 0, pathDecision: 'left', nowMs: 0 })).state
    expect(nextGuidance(state, input({ bearing: 0, pathDecision: 'left', nowMs: 1000 })).say).toBeNull()
    expect(nextGuidance(state, input({ bearing: 0, pathDecision: 'left', nowMs: CFG.guidanceRepeatMs })).say).toBe(
      'Bear left around the obstacle.',
    )
    state = nextGuidance(state, input({ bearing: 0, pathDecision: 'right', nowMs: 6000 })).state
    expect(state.instruction).toBe('around-right')
  })
})
