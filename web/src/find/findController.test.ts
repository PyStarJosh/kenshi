import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { LocateBox, LocateResult } from '../core/types'
import { initialContext, reduce, snapshotOf } from './findController'
import type { FindContext, FindEffect, FindEnv, FindEvent, FrameMeta, YoloSighting } from './findController'
import type { LocateClientErrorCode } from './locateClient'
import { FIND_MESSAGES } from './messages'
import { FIND_PHRASES } from './phrases'

const CFG = CONFIG.find
const env: FindEnv = { hfovDeg: 65, eyeHeightM: 1.6, frame: { width: 1280, height: 720 } }

const boxAt = (centerX: number): LocateBox => ({ x0: centerX - 0.05, y0: 0.3, x1: centerX + 0.05, y1: 0.8 })
const foundResult = (frameIndex = 0, centerX = 0.5, patch: Partial<LocateResult> = {}): LocateResult => ({
  found: true,
  frameIndex,
  box: boxAt(centerX),
  label: 'chair',
  onFloor: true,
  distanceM: 3,
  confidence: 0.9,
  signHint: null,
  latencyMs: 1000,
  ...patch,
})
const notFoundResult = (signHint: string | null = null): LocateResult => ({
  found: false,
  frameIndex: null,
  box: null,
  label: '',
  onFloor: false,
  distanceM: null,
  confidence: 0,
  signHint,
  latencyMs: 1000,
})

/** A little harness: feeds events to the reducer and keeps the context, the clock, the heading and every effect. */
class Sim {
  ctx: FindContext = initialContext()
  effects: FindEffect[] = []
  nowMs = 1000
  heading: number | null = 0

  send(event: FindEvent): FindEffect[] {
    const step = reduce(this.ctx, event, env)
    this.ctx = step.ctx
    this.effects.push(...step.effects)
    return step.effects
  }

  request(target: string, yolo: YoloSighting | null = null): FindEffect[] {
    return this.send({ type: 'request', target, nowMs: this.nowMs, heading: this.heading, yolo })
  }

  tick(advanceMs = 0, patch: { yolo?: YoloSighting | null; canLocate?: boolean } = {}): FindEffect[] {
    this.nowMs += advanceMs
    return this.send({ type: 'tick', nowMs: this.nowMs, heading: this.heading, yolo: null, canLocate: true, ...patch })
  }

  located(id: number, result: LocateResult, frames: FrameMeta[] = [{ heading: 0, pitch: 0 }]): FindEffect[] {
    return this.send({ type: 'located', id, nowMs: this.nowMs, heading: this.heading, result, frames })
  }

  failed(id: number, code: LocateClientErrorCode): FindEffect[] {
    return this.send({ type: 'failed', id, nowMs: this.nowMs, code })
  }

  cancel(): FindEffect[] {
    return this.send({ type: 'cancel' })
  }

  /** Everything said so far, or only what a given call returned. */
  said(effects: FindEffect[] = this.effects): string[] {
    return effects.filter((e): e is Extract<FindEffect, { type: 'speak' }> => e.type === 'speak').map((e) => e.text)
  }

  locateEffects(effects: FindEffect[]): Extract<FindEffect, { type: 'locate' }>[] {
    return effects.filter((e): e is Extract<FindEffect, { type: 'locate' }> => e.type === 'locate')
  }

  get state() {
    return this.ctx.state
  }

  /** Get to guiding on a chair straight ahead by a Gemini check. Returns the search id used. */
  guideByGemini(patch: Partial<LocateResult> = {}, centerX = 0.5): void {
    const [locate] = this.locateEffects(this.request('chair'))
    this.located(locate.id, foundResult(0, centerX, patch))
  }
}

describe('starting a search', () => {
  test('speaks the privacy notice once, confirms the target, and makes one locate call with the current frame', () => {
    const sim = new Sim()
    const effects = sim.request('Chair')
    expect(sim.state).toBe('checking')
    expect(sim.said(effects)).toEqual([`${FIND_PHRASES.privacy} Looking for a chair.`])
    expect(sim.locateEffects(effects)).toEqual([{ type: 'locate', id: 1, frames: 'current' }])
  })

  test('the privacy notice is never spoken a second time in the same session', () => {
    const sim = new Sim()
    sim.request('chair')
    sim.cancel()
    const effects = sim.request('exit')
    expect(sim.said(effects)).toEqual(['Looking for an exit.'])
  })

  test('the notice comes before the first locate call, not before a YOLO shortcut that makes no call', () => {
    const sim = new Sim()
    const shortcut = sim.request('chair', { angleDeg: 0, distanceM: 3 })
    expect(sim.said(shortcut).join(' ')).not.toContain('Gemini')
    sim.cancel()
    const later = sim.request('exit')
    expect(sim.said(later)[0]).toContain(FIND_PHRASES.privacy)
  })

  test('an empty or article-only target does nothing', () => {
    const sim = new Sim()
    expect(sim.request('  ')).toEqual([])
    expect(sim.request('the')).toEqual([])
    expect(sim.state).toBe('idle')
  })

  test('a new request replaces a search in progress, and the old answer is ignored', () => {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('chair'))
    const [second] = sim.locateEffects(sim.request('door'))
    expect(second.id).toBeGreaterThan(first.id)
    sim.located(first.id, foundResult())
    expect(sim.state).toBe('checking')
    expect(sim.ctx.target).toBe('door')
  })
})

describe('a found target', () => {
  test('straight ahead: found, ahead, and guiding from the Gemini source', () => {
    const sim = new Sim()
    sim.guideByGemini()
    expect(sim.state).toBe('guiding')
    expect(sim.said().at(-1)).toBe('Chair found, ahead.')
    expect(sim.ctx.memory).toMatchObject({ label: 'chair', source: 'gemini', heading: 0 })
  })

  test.each([
    [0.5, 'ahead'],
    [0.75, 'slightly right'],
    [0.25, 'slightly left'],
    [0.98, 'slightly right'], // a box at the very edge is only half a field of view off: 32.5 degrees
    [0.02, 'slightly left'],
  ])('a box at %f of the width is %s', (centerX, words) => {
    const sim = new Sim()
    sim.guideByGemini({}, centerX)
    expect(sim.said().at(-1)).toBe(`Chair found, ${words}.`)
  })

  test('the target heading is the frame heading plus where the box sits, and distance comes from the floor', () => {
    const sim = new Sim()
    sim.heading = 100
    const [locate] = sim.locateEffects(sim.request('chair'))
    sim.located(locate.id, foundResult(0, 0.75), [{ heading: 100, pitch: 0 }])
    expect(sim.ctx.memory?.heading).toBeCloseTo(100 + 0.25 * 65, 9)
    expect(sim.ctx.memory?.distanceM).toBe(7.5) // box bottom 0.8 down the frame, level, eye height 1.6 m
  })

  test('says where it is from the user\'s heading now, not the heading the frame had', () => {
    const sim = new Sim()
    const [locate] = sim.locateEffects(sim.request('exit'))
    sim.heading = 90 // the user kept turning while the answer was on its way
    sim.located(locate.id, foundResult(0, 0.5), [{ heading: 0, pitch: 0 }])
    expect(sim.said().at(-1)).toBe('Exit found, to your left.')
  })
})

describe('the YOLO shortcut', () => {
  test('a target the detector sees skips Gemini and goes straight to guiding with source yolo', () => {
    const sim = new Sim()
    sim.heading = 100
    const effects = sim.request('chair', { angleDeg: 20, distanceM: 2.4 })
    expect(sim.locateEffects(effects)).toEqual([])
    expect(sim.state).toBe('guiding')
    expect(sim.ctx.memory).toMatchObject({ source: 'yolo', heading: 120, distanceM: 2.5 })
    expect(sim.said(effects)).toEqual(['Chair found, slightly right.'])
  })

  test('follows the track every frame, so the direction stays smooth', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4 })
    sim.tick(100, { yolo: { angleDeg: -30, distanceM: 3.2 } })
    expect(sim.ctx.memory).toMatchObject({ heading: -30, distanceM: 3, source: 'yolo' })
    sim.heading = 40 // the user turns; the track is followed in the new frame
    sim.tick(100, { yolo: { angleDeg: -35, distanceM: 3.1 } })
    expect(sim.ctx.memory?.heading).toBe(5)
  })

  test('says the direction when it changes, no more than the cooldown allows', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4 })
    const early = sim.tick(100, { yolo: { angleDeg: 60, distanceM: 4 } })
    expect(sim.said(early)).toEqual([]) // changed, but too soon after the last phrase
    const later = sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 60, distanceM: 4 } })
    expect(sim.said(later)).toEqual(['To your right.'])
    const same = sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 60, distanceM: 4 } })
    expect(sim.said(same)).toEqual([]) // unchanged: no repeat
  })

  test('while the track is followed there is no Gemini re-check; once it disappears and the target is in view there is', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4 })
    const followed = sim.tick(CFG.recheckIntervalMs + 100, { yolo: { angleDeg: 2, distanceM: 4 } })
    expect(sim.locateEffects(followed)).toEqual([])
    const gone = sim.tick(CFG.recheckIntervalMs + 100, { yolo: null })
    expect(sim.locateEffects(gone)).toHaveLength(1)
  })

  test('without a heading it says where the thing is once and stops', () => {
    const sim = new Sim()
    sim.heading = null
    const effects = sim.request('chair', { angleDeg: -90, distanceM: 2 })
    expect(sim.said(effects)).toEqual(['Chair found, to your left.'])
    expect(sim.state).toBe('idle')
  })
})

describe('the sweep', () => {
  function startSweep(sim: Sim, heading = 0) {
    sim.heading = heading
    const [locate] = sim.locateEffects(sim.request('exit'))
    const effects = sim.located(locate.id, notFoundResult())
    return { effects, locate }
  }

  test('not in view: says to turn slowly to the right and starts sweeping', () => {
    const sim = new Sim()
    const { effects } = startSweep(sim)
    expect(sim.state).toBe('sweeping')
    expect(sim.said(effects)).toEqual([FIND_PHRASES.notInView])
  })

  test('a full turn takes 8 frames, one about every 45 degrees, then sends them all in one call', () => {
    const sim = new Sim()
    startSweep(sim)
    let captures = 0
    let locateCalls: Extract<FindEffect, { type: 'locate' }>[] = []
    for (let heading = 5; heading <= 360; heading += 5) {
      sim.heading = heading
      const effects = sim.tick(300)
      captures += effects.filter((e) => e.type === 'capture').length
      locateCalls = locateCalls.concat(sim.locateEffects(effects))
    }
    expect(captures).toBe(8)
    expect(locateCalls).toHaveLength(1)
    expect(locateCalls[0].frames).toBe('sweep')
    expect(sim.state).toBe('sweepChecking')
    expect(sim.said().at(-1)).toBe(FIND_PHRASES.checking)
  })

  test('a frame is taken each time the heading has turned the configured step, and not before', () => {
    const sim = new Sim()
    startSweep(sim)
    sim.heading = CFG.sweepStepDeg - 1
    expect(sim.tick(100).some((e) => e.type === 'capture')).toBe(false)
    sim.heading = CFG.sweepStepDeg
    expect(sim.tick(100).some((e) => e.type === 'capture')).toBe(true)
    sim.heading = CFG.sweepStepDeg + 20
    expect(sim.tick(100).some((e) => e.type === 'capture')).toBe(false)
  })

  test('turning faster ends the sweep after a full turn with fewer frames', () => {
    const sim = new Sim()
    startSweep(sim)
    let captures = 0
    for (let step = 1; step <= 6; step++) {
      sim.heading = step * 60
      captures += sim.tick(300).filter((e) => e.type === 'capture').length
    }
    expect(captures).toBe(6)
    expect(sim.state).toBe('sweepChecking')
  })

  test('turning to the left counts too', () => {
    const sim = new Sim()
    startSweep(sim)
    sim.heading = -50
    expect(sim.tick(100).some((e) => e.type === 'capture')).toBe(true)
  })

  test('reminds once if the user stops turning for 4 seconds, and not a second time', () => {
    const sim = new Sim()
    startSweep(sim)
    expect(sim.said(sim.tick(CFG.sweepReminderMs - 100))).toEqual([])
    expect(sim.said(sim.tick(200))).toEqual([FIND_PHRASES.keepTurning])
    expect(sim.said(sim.tick(1000))).toEqual([])
    expect(sim.said(sim.tick(3000))).toEqual([])
  })

  test('turning keeps the reminder away', () => {
    const sim = new Sim()
    startSweep(sim)
    for (let i = 1; i <= 10; i++) {
      sim.heading = i * 4
      expect(sim.said(sim.tick(1000))).toEqual([])
    }
  })

  test('the sweep frames are found in one answer: the best frame\'s own heading places the target', () => {
    const sim = new Sim()
    startSweep(sim)
    const headings = [45, 90, 135, 180, 225, 270, 315, 360]
    let sweepCall: Extract<FindEffect, { type: 'locate' }> | undefined
    for (const heading of headings) {
      sim.heading = heading
      sweepCall ??= sim.locateEffects(sim.tick(300))[0]
    }
    expect(sweepCall).toBeDefined()
    // Frame 3 was taken facing 180 and shows the exit in the middle; the user now faces 360, so it is behind them.
    sim.located(sweepCall!.id, foundResult(3, 0.5), headings.map((heading) => ({ heading, pitch: 0 })))
    expect(sim.state).toBe('guiding')
    expect(sim.said().at(-1)).toBe('Exit found, behind you.')
    expect(sim.ctx.memory?.heading).toBe(180)
  })

  test('turning toward it changes the spoken direction', () => {
    const sim = new Sim()
    startSweep(sim)
    const headings = [45, 90, 135, 180, 225, 270, 315, 360]
    let sweepCall: Extract<FindEffect, { type: 'locate' }> | undefined
    for (const heading of headings) {
      sim.heading = heading
      sweepCall ??= sim.locateEffects(sim.tick(300))[0]
    }
    sim.located(sweepCall!.id, foundResult(3, 0.5), headings.map((heading) => ({ heading, pitch: 0 })))
    sim.heading = 250 // turning toward 180
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual(['To your left.'])
    sim.heading = 205
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual(['Slightly left.'])
    sim.heading = 181
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual(['Ahead.'])
  })

  test('stopping altogether sends what there is after the give-up time, or gives up if there is nothing', () => {
    const nothing = new Sim()
    startSweep(nothing)
    nothing.tick(CFG.sweepGiveUpMs)
    expect(nothing.state).toBe('notFound')

    const some = new Sim()
    startSweep(some)
    some.heading = 50
    some.tick(100)
    const effects = some.tick(CFG.sweepGiveUpMs)
    expect(some.state).toBe('sweepChecking')
    expect(some.locateEffects(effects)[0].frames).toBe('sweep')
  })
})

describe('not found', () => {
  function sweepToEnd(sim: Sim) {
    const [first] = sim.locateEffects(sim.request('exit'))
    sim.located(first.id, notFoundResult('EXIT ->'))
    let call: Extract<FindEffect, { type: 'locate' }> | undefined
    for (let heading = 45; heading <= 360; heading += 45) {
      sim.heading = heading
      call ??= sim.locateEffects(sim.tick(300))[0]
    }
    return call!
  }

  test('says it could not find it, and reads the sign Gemini saw with its direction', () => {
    const sim = new Sim()
    const call = sweepToEnd(sim)
    sim.located(call.id, notFoundResult(null), [{ heading: 45, pitch: 0 }])
    expect(sim.state).toBe('notFound')
    expect(sim.said().at(-1)).toBe(
      "I couldn't find an exit here. Try another spot or ask for something else. A sign says exit, to the right.",
    )
  })

  test('a sign from the final answer is used as well', () => {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('door'))
    sim.located(first.id, notFoundResult())
    let call: Extract<FindEffect, { type: 'locate' }> | undefined
    for (let heading = 45; heading <= 360; heading += 45) {
      sim.heading = heading
      call ??= sim.locateEffects(sim.tick(300))[0]
    }
    sim.located(call!.id, notFoundResult('<- Restrooms'))
    expect(sim.said().at(-1)).toContain('A sign says restrooms, to the left.')
  })

  test('without a sign it is just the sentence, and it never says the thing is not there', () => {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('chair'))
    sim.located(first.id, notFoundResult())
    let call: Extract<FindEffect, { type: 'locate' }> | undefined
    for (let heading = 45; heading <= 360; heading += 45) {
      sim.heading = heading
      call ??= sim.locateEffects(sim.tick(300))[0]
    }
    sim.located(call!.id, notFoundResult())
    expect(sim.said().at(-1)).toBe("I couldn't find a chair here. Try another spot or ask for something else.")
    expect(sim.said().join(' ')).not.toMatch(/not (here|there)/i)
  })

  test('goes back to idle after the hold time', () => {
    const sim = new Sim()
    const call = sweepToEnd(sim)
    sim.located(call.id, notFoundResult())
    sim.tick(CFG.resultHoldMs - 100)
    expect(sim.state).toBe('notFound')
    sim.tick(200)
    expect(sim.state).toBe('idle')
  })
})

describe('guiding, re-checks, and lost', () => {
  test('re-checks with Gemini only when the target should be in view, the interval has passed, and a call is allowed', () => {
    const sim = new Sim()
    sim.guideByGemini()
    expect(sim.locateEffects(sim.tick(CFG.recheckIntervalMs - 100))).toEqual([])
    expect(sim.locateEffects(sim.tick(200, { canLocate: false }))).toEqual([])
    expect(sim.locateEffects(sim.tick(100, { canLocate: true }))).toHaveLength(1)
  })

  test('does not re-check while the target is out of view', () => {
    const sim = new Sim()
    sim.guideByGemini()
    sim.heading = 90 // the target is 90 degrees to the left of where the camera now points
    expect(sim.locateEffects(sim.tick(CFG.recheckIntervalMs * 2))).toEqual([])
  })

  test('the inside edge of the field of view still counts as in view', () => {
    const sim = new Sim()
    sim.guideByGemini()
    sim.heading = env.hfovDeg / 2 - 0.1
    expect(sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))).toHaveLength(1)
    const outside = new Sim()
    outside.guideByGemini()
    outside.heading = env.hfovDeg / 2 + 0.1
    expect(outside.locateEffects(outside.tick(CFG.recheckIntervalMs + 100))).toEqual([])
  })

  test('only one re-check is in flight at a time', () => {
    const sim = new Sim()
    sim.guideByGemini()
    sim.tick(CFG.recheckIntervalMs + 100)
    expect(sim.locateEffects(sim.tick(CFG.recheckIntervalMs * 3))).toEqual([])
  })

  test('a re-check that finds it updates the memory and clears the failures', () => {
    const sim = new Sim()
    sim.guideByGemini()
    const [first] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    sim.located(first.id, notFoundResult())
    expect(sim.ctx.failedRechecks).toBe(1)
    const [second] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    sim.located(second.id, foundResult(0, 0.75))
    expect(sim.state).toBe('guiding')
    expect(sim.ctx.failedRechecks).toBe(0)
    expect(sim.ctx.memory?.heading).toBeCloseTo(16.25, 9)
  })

  test('two failed re-checks while in view: lost, says so, and sweeps again', () => {
    const sim = new Sim()
    sim.guideByGemini()
    const [first] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    sim.located(first.id, notFoundResult())
    expect(sim.state).toBe('guiding')
    const [second] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    const effects = sim.located(second.id, notFoundResult())
    expect(sim.state).toBe('lost')
    expect(sim.said(effects)).toEqual(['Lost the chair. Scanning.'])
    expect(sim.ctx.memory).toBeNull()

    const next = sim.tick(100)
    expect(sim.state).toBe('sweeping')
    expect(next).toContainEqual({ type: 'discardFrames' })
    sim.heading = CFG.sweepStepDeg
    expect(sim.tick(100).some((e) => e.type === 'capture')).toBe(true)
  })

  test('a failed re-check from our own pacing is not held against the target; a real failure is', () => {
    const sim = new Sim()
    sim.guideByGemini()
    const [first] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    sim.failed(first.id, 'too_soon')
    expect(sim.ctx.failedRechecks).toBe(0)
    expect(sim.ctx.rechecking).toBe(false)
    const [second] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    sim.failed(second.id, 'network')
    expect(sim.ctx.failedRechecks).toBe(1)
    expect(sim.state).toBe('guiding')
  })

  test('a memory nobody has refreshed for too long is lost', () => {
    const sim = new Sim()
    sim.guideByGemini()
    sim.heading = 90 // out of view: no re-checks can refresh it
    const effects = sim.tick(CFG.memoryMaxAgeMs + 100)
    expect(sim.state).toBe('lost')
    expect(sim.said(effects)).toEqual(['Lost the chair. Scanning.'])
  })

  test('speaks a direction change, and not the same one twice', () => {
    const sim = new Sim()
    sim.guideByGemini()
    sim.heading = -100 // the target is now 100 degrees to the right
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual(['To your right.'])
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual([])
  })
})

describe('arrival', () => {
  test('within reach and straight ahead: says so, then goes idle after the hold time', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4 })
    const effects = sim.tick(100, { yolo: { angleDeg: 5, distanceM: 0.9 } })
    expect(sim.state).toBe('arrived')
    expect(sim.said(effects)).toEqual(['Chair ahead, within reach.'])
    sim.tick(CFG.resultHoldMs - 100)
    expect(sim.state).toBe('arrived')
    sim.tick(200)
    expect(sim.state).toBe('idle')
  })

  test('the limits: 1.0 m counts, 1.5 m (rounded) does not; 19 degrees counts, 20 does not', () => {
    const cases: [number, number, string][] = [
      [1.0, 19, 'arrived'],
      [1.0, 20, 'guiding'],
      [1.5, 0, 'guiding'],
      [0.5, -19, 'arrived'],
      [0.5, -45, 'guiding'],
    ]
    for (const [distanceM, angleDeg, expected] of cases) {
      const sim = new Sim()
      sim.request('chair', { angleDeg: 0, distanceM: 4 })
      sim.tick(100, { yolo: { angleDeg, distanceM } })
      expect(sim.state, `${distanceM} m at ${angleDeg}`).toBe(expected)
    }
  })

  test('with no distance there is no arrival', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: null })
    sim.tick(100, { yolo: { angleDeg: 0, distanceM: null } })
    expect(sim.state).toBe('guiding')
  })

  test('works from a Gemini distance too', () => {
    const sim = new Sim()
    sim.guideByGemini({ onFloor: false, distanceM: 0.8 })
    expect(sim.ctx.memory?.distanceM).toBe(1)
    sim.tick(100)
    expect(sim.state).toBe('arrived')
  })
})

describe('errors and silence', () => {
  test('offline during the first check: Find is not available, then idle', () => {
    const sim = new Sim()
    const [locate] = sim.locateEffects(sim.request('chair'))
    const effects = sim.failed(locate.id, 'network')
    expect(sim.state).toBe('error')
    expect(sim.said(effects)).toEqual(["Find isn't available right now."])
    sim.tick(CFG.resultHoldMs)
    expect(sim.state).toBe('idle')
  })

  test.each(['quota', 'timeout', 'network'] as const)('%s during the sweep check is the same sentence', (code) => {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('exit'))
    sim.located(first.id, notFoundResult())
    let call: Extract<FindEffect, { type: 'locate' }> | undefined
    for (let heading = 45; heading <= 360; heading += 45) {
      sim.heading = heading
      call ??= sim.locateEffects(sim.tick(300))[0]
    }
    const effects = sim.failed(call!.id, code)
    expect(sim.state).toBe('error')
    expect(sim.said(effects)).toEqual([FIND_PHRASES.unavailable])
  })

  test('our own pacing limits get their own, more helpful sentences', () => {
    const slow = new Sim()
    const [a] = slow.locateEffects(slow.request('chair'))
    expect(slow.said(slow.failed(a.id, 'too_soon'))).toEqual([FIND_MESSAGES.too_soon])
    const capped = new Sim()
    const [b] = capped.locateEffects(capped.request('chair'))
    expect(capped.said(capped.failed(b.id, 'limit'))).toEqual([FIND_MESSAGES.limit])
  })

  test('the sentence does not claim anything is still on', () => {
    expect(FIND_PHRASES.unavailable).not.toMatch(/alert|still|on\b/i)
  })

  test('while a search is out the user hears something at least every 5 seconds', () => {
    const sim = new Sim()
    sim.request('chair')
    expect(sim.said(sim.tick(CFG.feedbackMaxGapMs - 100))).toEqual([])
    expect(sim.said(sim.tick(200))).toEqual([FIND_PHRASES.stillSearching])
    expect(sim.said(sim.tick(CFG.feedbackMaxGapMs - 100))).toEqual([])
    expect(sim.said(sim.tick(200))).toEqual([FIND_PHRASES.stillSearching])
  })

  test('an answer that arrives after the search was cancelled does nothing', () => {
    const sim = new Sim()
    const [locate] = sim.locateEffects(sim.request('chair'))
    sim.cancel()
    const effects = sim.located(locate.id, foundResult())
    expect(effects).toEqual([])
    expect(sim.state).toBe('idle')
    expect(sim.failed(locate.id, 'network')).toEqual([])
  })
})

describe('cancel', () => {
  test('from every state returns to idle, says it stopped, and throws away sweep frames', () => {
    const setups: [string, (sim: Sim) => void][] = [
      ['checking', (sim) => void sim.request('chair')],
      ['guiding', (sim) => sim.guideByGemini()],
      ['sweeping', (sim) => {
        const [l] = sim.locateEffects(sim.request('chair'))
        sim.located(l.id, notFoundResult())
      }],
      ['arrived', (sim) => {
        sim.request('chair', { angleDeg: 0, distanceM: 4 })
        sim.tick(10, { yolo: { angleDeg: 0, distanceM: 0.5 } })
      }],
      ['error', (sim) => {
        const [l] = sim.locateEffects(sim.request('chair'))
        sim.failed(l.id, 'network')
      }],
    ]
    for (const [state, setup] of setups) {
      const sim = new Sim()
      setup(sim)
      expect(sim.state, state).toBe(state)
      const effects = sim.cancel()
      expect(sim.state, state).toBe('idle')
      expect(sim.said(effects), state).toEqual([FIND_PHRASES.stopped])
      expect(effects, state).toContainEqual({ type: 'discardFrames' })
    }
  })

  test('when idle it does nothing', () => {
    const sim = new Sim()
    expect(sim.cancel()).toEqual([])
  })
})

describe('no heading', () => {
  test('a single check only: says it cannot tell which way you turn, and ends with where the box was', () => {
    const sim = new Sim()
    sim.heading = null
    const effects = sim.request('chair')
    expect(sim.said(effects)[0]).toContain(FIND_PHRASES.noHeading)
    const [locate] = sim.locateEffects(effects)
    const found = sim.located(locate.id, foundResult(0, 0.9), [{ heading: null, pitch: null }])
    expect(sim.said(found)).toEqual(['Chair found, slightly right.'])
    expect(sim.state).toBe('idle')
  })

  test('not found goes straight to not found: there is no sweep without a heading', () => {
    const sim = new Sim()
    sim.heading = null
    const [locate] = sim.locateEffects(sim.request('chair'))
    sim.located(locate.id, notFoundResult(), [{ heading: null, pitch: null }])
    expect(sim.state).toBe('notFound')
  })
})

describe('the snapshot', () => {
  test('idle shows nothing; guiding shows the target, the bearing and where it came from', () => {
    const sim = new Sim()
    expect(snapshotOf(sim.ctx, 0)).toEqual({ state: 'idle', target: null, bearingDeg: null, distanceM: null, source: null })
    sim.guideByGemini({}, 0.75)
    const snapshot = snapshotOf(sim.ctx, 0)
    expect(snapshot).toMatchObject({ state: 'guiding', target: 'chair', source: 'gemini' })
    expect(snapshot.bearingDeg).toBeCloseTo(16.25, 9)
    expect(snapshotOf(sim.ctx, null).bearingDeg).toBeNull()
  })
})
