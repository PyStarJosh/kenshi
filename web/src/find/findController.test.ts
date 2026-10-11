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

  /** The heading each sweep frame was taken at, by the id of its look. */
  captureHeadings = new Map<number, number | null>()

  tick(
    advanceMs = 0,
    patch: {
      yolo?: YoloSighting | null
      canLocate?: boolean
      canLook?: boolean
      pitch?: number | null
      pathDecision?: 'left' | 'right' | 'straight' | null
      speaking?: boolean
    } = {},
  ): FindEffect[] {
    this.nowMs += advanceMs
    const effects = this.send({
      type: 'tick',
      nowMs: this.nowMs,
      heading: this.heading,
      yolo: null,
      canLocate: true,
      canLook: true,
      pitch: null,
      ...patch,
    })
    for (const effect of effects) if (effect.type === 'capture') this.captureHeadings.set(effect.id, this.heading)
    return effects
  }

  /** Turn to a heading in small steps, ticking each time. Returns every effect that came out. */
  turnTo(to: number, stepDeg = 5, dtMs = 300): FindEffect[] {
    const out: FindEffect[] = []
    let heading = this.heading ?? 0
    const direction = to >= heading ? 1 : -1
    while (direction > 0 ? heading < to : heading > to) {
      heading = direction > 0 ? Math.min(heading + stepDeg, to) : Math.max(heading - stepDeg, to)
      this.heading = heading
      out.push(...this.tick(dtMs))
    }
    return out
  }

  captureEffects(effects: FindEffect[]): Extract<FindEffect, { type: 'capture' }>[] {
    return effects.filter((e): e is Extract<FindEffect, { type: 'capture' }> => e.type === 'capture')
  }

  /** The metadata of a sweep look: the frame was taken at the heading recorded for it. */
  metaOf(id: number): FrameMeta[] {
    return [{ heading: this.captureHeadings.get(id) ?? null, pitch: 0 }]
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

  /** Keep ticking with a sighting until the arrival hold has passed. Returns the effects of the last tick. */
  hold(yolo: YoloSighting, patch: { pitch?: number | null } = {}): FindEffect[] {
    this.tick(100, { yolo, ...patch })
    return this.tick(CFG.arrivalHoldMs + 50, { yolo, ...patch })
  }

  /** Get to guiding on a chair straight ahead by a Gemini check. Returns the search id used. */
  guideByGemini(patch: Partial<LocateResult> = {}, centerX = 0.5): void {
    const [locate] = this.locateEffects(this.request('chair'))
    this.located(locate.id, foundResult(0, centerX, patch))
  }
}

describe('starting a search', () => {
  test('confirms the target and makes one locate call with the current frame', () => {
    const sim = new Sim()
    const effects = sim.request('Chair')
    expect(sim.state).toBe('checking')
    expect(sim.said(effects)).toEqual(['Looking for a chair.'])
    expect(sim.locateEffects(effects)).toEqual([{ type: 'locate', id: 1, paced: true }])
  })

  test('no search ever says anything about Gemini (owner decision: there is no privacy notice)', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 3 })
    sim.cancel()
    sim.request('exit')
    sim.cancel()
    sim.request('door')
    expect(sim.said().join(' ')).not.toMatch(/gemini|google|photo/i)
    expect(sim.said()).toContain('Looking for an exit.')
    expect(sim.said()).toContain('Looking for a door.')
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
    expect(sim.said().at(-1)).toBe('Chair found, ahead. It is far.') // 7.5 m from the floor
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
    expect(sim.said().at(-1)).toBe(`Chair found, ${words}. It is far.`)
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
    expect(sim.said().at(-1)).toBe('Exit found, to your left. It is far.')
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
    expect(sim.said(effects)).toEqual(['Chair found, slightly right. It is near.'])
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
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 7 })
    const early = sim.tick(100, { yolo: { angleDeg: 60, distanceM: 4, trackId: 7 } })
    expect(sim.said(early)).toEqual([]) // changed, but too soon after the last phrase
    const later = sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 60, distanceM: 4, trackId: 7 } })
    expect(sim.said(later)).toEqual(['Turn right.'])
    const same = sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 60, distanceM: 4, trackId: 7 } })
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
  /** Request an exit, get "not in view" from the first look, and begin sweeping. */
  function startSweep(sim: Sim, heading = 0) {
    sim.heading = heading
    const [first] = sim.locateEffects(sim.request('exit'))
    const effects = sim.located(first.id, notFoundResult())
    return { effects, first }
  }

  test('not in view: says to turn slowly to the right and starts sweeping', () => {
    const sim = new Sim()
    const { effects } = startSweep(sim)
    expect(sim.state).toBe('sweeping')
    expect(sim.said(effects)).toEqual([FIND_PHRASES.notInView])
  })

  test('a frame is taken about every 45 degrees and sent as its own look at once: 8 for a full turn, no batch call', () => {
    const sim = new Sim()
    startSweep(sim)
    const effects = sim.turnTo(360)
    const captures = sim.captureEffects(effects)
    expect(captures).toHaveLength(8)
    expect(new Set(captures.map((c) => c.id)).size).toBe(8)
    expect(sim.locateEffects(effects)).toEqual([]) // no one-call batch at the end any more
    expect([...sim.captureHeadings.values()]).toEqual([45, 90, 135, 180, 225, 270, 315, 360])
    expect(sim.state).toBe('sweepChecking')
    expect(sim.said(effects).at(-1)).toBe(FIND_PHRASES.checking)
  })

  test('each frame is captured the moment its 45 degrees is reached, not at the end of the turn', () => {
    const sim = new Sim()
    startSweep(sim)
    sim.heading = CFG.sweepStepDeg - 1
    expect(sim.captureEffects(sim.tick(100))).toEqual([])
    sim.heading = CFG.sweepStepDeg
    expect(sim.captureEffects(sim.tick(100))).toHaveLength(1)
    sim.heading = CFG.sweepStepDeg + 20
    expect(sim.captureEffects(sim.tick(100))).toEqual([])
    expect(sim.state).toBe('sweeping')
  })

  test('turning faster ends the sweep after a full turn with fewer frames', () => {
    const sim = new Sim()
    startSweep(sim)
    let captures = 0
    for (let step = 1; step <= 6; step++) {
      sim.heading = step * 60
      captures += sim.captureEffects(sim.tick(300)).length
    }
    expect(captures).toBe(6)
    expect(sim.state).toBe('sweepChecking')
  })

  test('turning to the left counts too', () => {
    const sim = new Sim()
    startSweep(sim)
    sim.heading = -50
    expect(sim.captureEffects(sim.tick(100))).toHaveLength(1)
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

  test('the first look that finds the target ends the search at once, without finishing the turn', () => {
    const sim = new Sim()
    startSweep(sim)
    const captures = sim.captureEffects(sim.turnTo(120)) // frames at 45 and 90
    expect(captures).toHaveLength(2)
    const effects = sim.located(captures[1].id, foundResult(0, 0.5), sim.metaOf(captures[1].id))
    expect(sim.state).toBe('guiding')
    expect(sim.said(effects)).toEqual(['Exit found, slightly left. It is far.']) // seen at 90, now facing 120: 30 degrees to the left
    expect(sim.ctx.memory).toMatchObject({ source: 'gemini', heading: 90 })
    expect(sim.ctx.sweepPending).toEqual([])
  })

  test('the other looks still out are ignored once it has been found', () => {
    const sim = new Sim()
    startSweep(sim)
    const [first, second] = sim.captureEffects(sim.turnTo(100))
    sim.located(second.id, foundResult(0, 0.5), sim.metaOf(second.id))
    const memory = sim.ctx.memory
    expect(sim.located(first.id, notFoundResult(), sim.metaOf(first.id))).toEqual([])
    expect(sim.failed(first.id, 'network')).toEqual([])
    expect(sim.state).toBe('guiding')
    expect(sim.ctx.memory).toBe(memory)
  })

  test('answers may come back in any order: a miss for an earlier frame does not hide a hit for a later one', () => {
    const sim = new Sim()
    startSweep(sim)
    const [a, b, c] = sim.captureEffects(sim.turnTo(140))
    sim.located(c.id, notFoundResult(), sim.metaOf(c.id))
    sim.located(a.id, notFoundResult(), sim.metaOf(a.id))
    expect(sim.state).toBe('sweeping')
    sim.located(b.id, foundResult(0, 0.5), sim.metaOf(b.id))
    expect(sim.state).toBe('guiding')
  })

  test('the target heading comes from the frame it was found in, so it is behind you after turning on', () => {
    const sim = new Sim()
    startSweep(sim)
    const captures = sim.captureEffects(sim.turnTo(360))
    const frame180 = captures[3] // taken facing 180
    const effects = sim.located(frame180.id, foundResult(0, 0.5), sim.metaOf(frame180.id))
    expect(sim.said(effects)).toEqual(['Exit found, behind you. It is far.'])
    expect(sim.ctx.memory?.heading).toBe(180)
  })

  test('turning toward it changes the spoken direction', () => {
    const sim = new Sim()
    startSweep(sim)
    const captures = sim.captureEffects(sim.turnTo(360))
    sim.located(captures[3].id, foundResult(0, 0.5), sim.metaOf(captures[3].id))
    sim.heading = 250 // turning toward 180
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual(['Turn left.'])
    sim.heading = 205
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual(['Bear left.'])
    sim.heading = 181
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual(['Straight ahead.'])
  })

  test('after the full turn it waits for the looks still out, and finishes when the last one is back', () => {
    const sim = new Sim()
    startSweep(sim)
    const captures = sim.captureEffects(sim.turnTo(360))
    expect(sim.state).toBe('sweepChecking')
    for (const capture of captures.slice(0, -1)) {
      sim.located(capture.id, notFoundResult(), sim.metaOf(capture.id))
      expect(sim.state).toBe('sweepChecking')
    }
    const last = captures.at(-1)!
    const effects = sim.located(last.id, notFoundResult(), sim.metaOf(last.id))
    expect(sim.state).toBe('notFound')
    expect(sim.said(effects)[0]).toContain("I couldn't find an exit here.")
  })

  test('a failed look costs one frame, not the sweep', () => {
    const sim = new Sim()
    startSweep(sim)
    const captures = sim.captureEffects(sim.turnTo(360))
    sim.failed(captures[0].id, 'network')
    for (const capture of captures.slice(1)) sim.located(capture.id, notFoundResult(), sim.metaOf(capture.id))
    expect(sim.state).toBe('notFound')
  })

  test('if every look failed, Find is not available', () => {
    const sim = new Sim()
    startSweep(sim)
    const captures = sim.captureEffects(sim.turnTo(360))
    let effects: FindEffect[] = []
    for (const capture of captures) effects = sim.failed(capture.id, 'network')
    expect(sim.state).toBe('error')
    expect(sim.said(effects)).toEqual([FIND_MESSAGES.network])
  })

  test('looks refused by our own limits say so', () => {
    const sim = new Sim()
    startSweep(sim)
    const captures = sim.captureEffects(sim.turnTo(360))
    let effects: FindEffect[] = []
    for (const capture of captures) effects = sim.failed(capture.id, 'limit')
    expect(sim.said(effects)).toEqual([FIND_MESSAGES.limit])
  })

  test('stopping altogether gives up after the give-up time: not found with no frames, or waits for the looks out', () => {
    const nothing = new Sim()
    startSweep(nothing)
    nothing.tick(CFG.sweepGiveUpMs)
    expect(nothing.state).toBe('notFound')

    const some = new Sim()
    startSweep(some)
    some.heading = 50
    const [capture] = some.captureEffects(some.tick(100))
    some.tick(CFG.sweepGiveUpMs)
    expect(some.state).toBe('sweepChecking')
    some.located(capture.id, notFoundResult(), some.metaOf(capture.id))
    expect(some.state).toBe('notFound')
  })
})

describe('looking while the user pauses, and the detector during a search', () => {
  /** Request a chair, get "not in view", and turn 30 degrees (less than a sweep step) and stop. */
  function turnedAndStill() {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('chair'))
    sim.located(first.id, notFoundResult())
    sim.heading = 30
    sim.tick(100)
    return sim
  }

  test('staring for a moment after turning takes a fresh look at once, without a gap', () => {
    const sim = turnedAndStill()
    expect(sim.locateEffects(sim.tick(CFG.sweepDwellMs - 200))).toEqual([])
    const effects = sim.tick(400)
    expect(sim.locateEffects(effects)).toEqual([expect.objectContaining({ type: 'locate', paced: false })])
    expect(sim.said(effects)).toEqual([FIND_PHRASES.checking])
    expect(sim.state).toBe('sweeping')
  })

  test('one look per pause: staring longer does not repeat it', () => {
    const sim = turnedAndStill()
    sim.tick(CFG.sweepDwellMs + 100)
    expect(sim.locateEffects(sim.tick(1000))).toEqual([])
  })

  test('turning again and pausing again looks again, but only after a real turn since the last look', () => {
    const sim = turnedAndStill()
    const [first] = sim.locateEffects(sim.tick(CFG.sweepDwellMs + 100)) // look at 30
    sim.located(first.id, notFoundResult())
    sim.heading = 40 // moved, but only 10 degrees since the last look
    sim.tick(100)
    expect(sim.locateEffects(sim.tick(CFG.sweepDwellMs + 100))).toEqual([])
    sim.heading = 30 + CFG.sweepDwellMinTurnDeg + 5 // 25 degrees from the last look
    sim.tick(100)
    expect(sim.locateEffects(sim.tick(CFG.sweepDwellMs + 100))).toHaveLength(1)
  })

  test('no look right after the first one: staring before any turn adds nothing', () => {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('chair'))
    sim.located(first.id, notFoundResult())
    expect(sim.locateEffects(sim.tick(CFG.sweepDwellMs + 500))).toEqual([])
  })

  test('waits for the caps to allow it, then looks', () => {
    const sim = turnedAndStill()
    expect(sim.locateEffects(sim.tick(CFG.sweepDwellMs + 100, { canLook: false }))).toEqual([])
    expect(sim.locateEffects(sim.tick(100, { canLook: true }))).toHaveLength(1)
  })

  test('a look that finds it ends the sweep and starts guiding', () => {
    const sim = turnedAndStill()
    const [look] = sim.locateEffects(sim.tick(CFG.sweepDwellMs + 100))
    const effects = sim.located(look.id, foundResult(0, 0.5), [{ heading: 30, pitch: 0 }])
    expect(sim.state).toBe('guiding')
    expect(sim.said(effects)).toEqual(['Chair found, ahead. It is far.'])
    expect(sim.ctx.memory).toMatchObject({ source: 'gemini', heading: 30 })
  })

  test('a look that does not find it, or fails, lets the sweep carry on without an error', () => {
    const miss = turnedAndStill()
    const [a] = miss.locateEffects(miss.tick(CFG.sweepDwellMs + 100))
    miss.located(a.id, notFoundResult())
    expect(miss.state).toBe('sweeping')

    const failed = turnedAndStill()
    const [b] = failed.locateEffects(failed.tick(CFG.sweepDwellMs + 100))
    expect(failed.said(failed.failed(b.id, 'network'))).toEqual([])
    expect(failed.state).toBe('sweeping')
    // and the sweep still takes its per-frame looks
    expect(failed.captureEffects(failed.turnTo(120)).length).toBeGreaterThan(0)
  })

  test('if the sweep finishes first, the answer to a pause look still out is ignored', () => {
    const sim = turnedAndStill()
    const [look] = sim.locateEffects(sim.tick(CFG.sweepDwellMs + 100))
    const captures = sim.captureEffects(sim.turnTo(360))
    for (const capture of captures) sim.located(capture.id, notFoundResult(), sim.metaOf(capture.id))
    expect(sim.state).toBe('notFound')
    expect(sim.located(look.id, foundResult())).toEqual([])
    expect(sim.state).toBe('notFound')
  })

  test('the detector sees the target during the sweep: guiding at once, no waiting for the turn', () => {
    const sim = turnedAndStill()
    const effects = sim.tick(100, { yolo: { angleDeg: 12, distanceM: 3 } })
    expect(sim.state).toBe('guiding')
    expect(sim.ctx.memory).toMatchObject({ source: 'yolo', heading: 42 })
    expect(sim.said(effects)).toEqual(['Chair found, ahead. It is near.'])
    expect(sim.ctx.sweepPending).toEqual([])
  })

  test('also while the first look or the last sweep looks are still out, whose answers are then ignored', () => {
    const first = new Sim()
    const [look] = first.locateEffects(first.request('chair'))
    first.tick(100, { yolo: { angleDeg: 0, distanceM: 2 } })
    expect(first.state).toBe('guiding')
    first.located(look.id, notFoundResult())
    expect(first.state).toBe('guiding')

    const last = new Sim()
    const [start] = last.locateEffects(last.request('chair'))
    last.located(start.id, notFoundResult())
    const captures = last.captureEffects(last.turnTo(360))
    expect(last.state).toBe('sweepChecking')
    last.tick(100, { yolo: { angleDeg: -5, distanceM: 2 } })
    expect(last.state).toBe('guiding')
    last.located(captures[0].id, notFoundResult(), last.metaOf(captures[0].id))
    expect(last.state).toBe('guiding')
  })

  test('without a heading the detector cannot place it, so the search carries on', () => {
    const sim = turnedAndStill()
    sim.heading = null
    sim.tick(100, { yolo: { angleDeg: 5, distanceM: 2 } })
    expect(sim.state).toBe('sweeping')
  })
})

describe('not found', () => {
  /** A sweep whose looks all come back without it; the first look (before the sweep) carried this sign. */
  function sweepAllMiss(sim: Sim, target: string, firstSign: string | null, lastSign: string | null = null) {
    const [first] = sim.locateEffects(sim.request(target))
    sim.located(first.id, notFoundResult(firstSign))
    const captures = sim.captureEffects(sim.turnTo(360))
    let effects: FindEffect[] = []
    captures.forEach((capture, index) => {
      const sign = index === captures.length - 1 ? lastSign : null
      effects = sim.located(capture.id, notFoundResult(sign), sim.metaOf(capture.id))
    })
    return effects
  }

  test('says it could not find it, and reads the sign Gemini saw with its direction', () => {
    const sim = new Sim()
    const effects = sweepAllMiss(sim, 'exit', 'EXIT ->')
    expect(sim.state).toBe('notFound')
    expect(sim.said(effects).at(-1)).toBe(
      "I couldn't find an exit here. Try another spot or ask for something else. A sign says exit, to the right.",
    )
  })

  test('a sign from the final look is used as well', () => {
    const sim = new Sim()
    const effects = sweepAllMiss(sim, 'door', null, '<- Restrooms')
    expect(sim.said(effects).at(-1)).toContain('A sign says restrooms, to the left.')
  })

  test('without a sign it is just the sentence, and it never says the thing is not there', () => {
    const sim = new Sim()
    const effects = sweepAllMiss(sim, 'chair', null)
    expect(sim.said(effects).at(-1)).toBe("I couldn't find a chair here. Try another spot or ask for something else.")
    expect(sim.said().join(' ')).not.toMatch(/not (here|there)/i)
  })

  test('goes back to idle after the hold time', () => {
    const sim = new Sim()
    sweepAllMiss(sim, 'exit', null)
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

  test('a re-check says where the target should be in the frame; the first check does not', () => {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('chair'))
    expect(first).not.toHaveProperty('nearX')
    sim.located(first.id, foundResult(0, 0.75)) // 16.25 degrees right
    const [recheck] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    expect(recheck.nearX).toBeCloseTo(0.75, 6)
    sim.heading = 10 // turned toward it: it should now be nearer the middle
    sim.located(recheck.id, foundResult(0, 0.6, {}), [{ heading: 10, pitch: 0 }])
    const [next] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    expect(next.nearX).toBeCloseTo(0.6, 6) // remembered at 16.5 degrees, facing 10: 6.5 degrees right of the middle
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
    expect(next).toEqual([])
    expect(sim.ctx.sweepPending).toEqual([])
    sim.heading = CFG.sweepStepDeg
    expect(sim.tick(100).some((e) => e.type === 'capture')).toBe(true)
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
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual(['Turn right.'])
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs))).toEqual([])
  })
})

describe('guidance through the controller', () => {
  test('the distance is told in words as the target gets nearer: far when found, then near, then close', () => {
    const sim = new Sim()
    const found = sim.request('chair', { angleDeg: 0, distanceM: 12, trackId: 3 })
    expect(sim.said(found)).toEqual(['Chair found, ahead. It is far.'])
    const said: string[] = []
    for (const distanceM of [11, 9.5, 8, 4.5, 2.5, 1.5]) {
      said.push(...sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 0, distanceM, trackId: 3 } })))
    }
    expect(said).toEqual(['Chair is near.', 'Chair is close.'])
  })

  test('a distance that is only an upper bound (the base is out of the frame) is never said as near or far', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 12, trackId: 3 })
    const said: string[] = []
    for (const distanceM of [9.5, 4.5, 2.5]) {
      said.push(...sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 0, distanceM, trackId: 3, clipped: true } })))
    }
    expect(said.filter((s) => /near|far|meters/.test(s))).toEqual([])
  })

  test('with the path line saying go around, it says which way, and still only when it changes or is due again', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 12, trackId: 3 })
    const yolo = { angleDeg: 0, distanceM: 12, trackId: 3 }
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo, pathDecision: 'left' }))).toEqual(['Bear left around the obstacle.'])
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo, pathDecision: 'left' }))).toEqual([])
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo, pathDecision: 'left' }))).toEqual(['Bear left around the obstacle.']) // 5 s on
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo, pathDecision: null }))).toEqual(['Straight ahead.'])
  })

  test('an instruction that asks the user to turn is repeated every 5 seconds until they do', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 12, trackId: 3 })
    const yolo = { angleDeg: 100, distanceM: 12, trackId: 3 }
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo }))).toEqual(['Turn right.'])
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo }))).toEqual([])
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo }))).toEqual(['Turn right.'])
  })

  test('behind it says to turn around', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 12, trackId: 3 })
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 170, distanceM: 12, trackId: 3 } }))).toEqual(['Turn around.'])
  })

  test('arrival is said instead of whatever instruction is also due', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 25, distanceM: 4, trackId: 3 }) // "found, slightly right": bear right is the current instruction
    sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 4, distanceM: 0.5, trackId: 3 } }) // now straight ahead and close
    const arrival = sim.tick(CFG.arrivalHoldMs, { yolo: { angleDeg: 4, distanceM: 0.5, trackId: 3 } })
    expect(sim.state).toBe('arrived')
    expect(sim.said(arrival)).toEqual(['Chair ahead, within reach.'])
  })

  test('the first words after "found" are not a repeat of what was just said', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 25, distanceM: 12, trackId: 3 })
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 25, distanceM: 12, trackId: 3 } }))).toEqual([])
  })
})

describe('not talking over itself', () => {
  test('guidance stays quiet while a phrase is being said, then speaks what is current', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 12, trackId: 3 })
    const turned = { angleDeg: 100, distanceM: 12, trackId: 3 }
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: turned, speaking: true }))).toEqual([])
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: turned, speaking: true }))).toEqual([])
    expect(sim.said(sim.tick(200, { yolo: turned, speaking: false }))).toEqual(['Turn right.'])
  })

  test('the tilt request waits for the same reason', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 7 })
    const cut = { angleDeg: 0, distanceM: 3.2, trackId: 7, clipped: true }
    const busy = sim.tick(CFG.tiltPromptCooldownMs, { yolo: cut, pitch: -5, speaking: true })
    expect(sim.said(busy).filter((s) => s === FIND_PHRASES.tiltDown)).toEqual([])
    const free = sim.tick(100, { yolo: cut, pitch: -5, speaking: false })
    expect(sim.said(free)).toContain(FIND_PHRASES.tiltDown)
  })

  test('arrival is still said while something is being said: it is queued, not dropped', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 3 })
    sim.tick(100, { yolo: { angleDeg: 0, distanceM: 0.5, trackId: 3 }, speaking: true })
    const arrival = sim.tick(CFG.arrivalHoldMs, { yolo: { angleDeg: 0, distanceM: 0.5, trackId: 3 }, speaking: true })
    expect(sim.said(arrival)).toEqual(['Chair ahead, within reach.'])
  })
})

describe('arrival', () => {
  test('within reach and straight ahead: says so, then goes idle after the hold time', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4 })
    const effects = sim.hold({ angleDeg: 5, distanceM: 0.9 })
    expect(sim.state).toBe('arrived')
    expect(sim.said(effects)).toEqual(['Chair ahead, within reach.'])
    sim.tick(CFG.resultHoldMs - 100)
    expect(sim.state).toBe('arrived')
    sim.tick(200)
    expect(sim.state).toBe('idle')
  })

  test('it has to hold for a moment: one close reading is not enough, and a break starts the count again', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4 })
    sim.tick(100, { yolo: { angleDeg: 0, distanceM: 0.5 } })
    expect(sim.state).toBe('guiding')
    sim.tick(CFG.arrivalHoldMs - 100, { yolo: { angleDeg: 0, distanceM: 0.5 } })
    expect(sim.state).toBe('guiding')
    sim.tick(100, { yolo: { angleDeg: 0, distanceM: 3 } }) // a noisy far reading breaks it
    expect(sim.ctx.arrivalSince).toBeNull()
    sim.tick(100, { yolo: { angleDeg: 0, distanceM: 0.5 } })
    sim.tick(CFG.arrivalHoldMs - 100, { yolo: { angleDeg: 0, distanceM: 0.5 } })
    expect(sim.state).toBe('guiding')
    sim.tick(200, { yolo: { angleDeg: 0, distanceM: 0.5 } })
    expect(sim.state).toBe('arrived')
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
      sim.hold({ angleDeg, distanceM })
      expect(sim.state, `${distanceM} m at ${angleDeg}`).toBe(expected)
    }
  })

  test('with its base out of the frame the distance is only an upper bound, so a larger one is judged', () => {
    const cut = new Sim()
    cut.request('chair', { angleDeg: 0, distanceM: 4 })
    cut.hold({ angleDeg: 0, distanceM: 1.5, clipped: true }) // the nearest floor in view is 1.5 m: it is closer than that
    expect(cut.state).toBe('arrived')

    const whole = new Sim()
    whole.request('chair', { angleDeg: 0, distanceM: 4 })
    whole.hold({ angleDeg: 0, distanceM: 1.5, clipped: false }) // a measured 1.5 m is not within reach
    expect(whole.state).toBe('guiding')

    const far = new Sim()
    far.request('chair', { angleDeg: 0, distanceM: 4 })
    far.hold({ angleDeg: 0, distanceM: 2.5, clipped: true }) // cut off at a shallow tilt: the bound is too loose to say
    expect(far.state).toBe('guiding')
  })

  test('with no distance there is no arrival', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: null })
    sim.hold({ angleDeg: 0, distanceM: null })
    expect(sim.state).toBe('guiding')
  })

  test('works from a Gemini distance too', () => {
    const sim = new Sim()
    sim.guideByGemini({ onFloor: false, distanceM: 0.8 })
    expect(sim.ctx.memory?.distanceM).toBe(1)
    sim.tick(100)
    sim.tick(CFG.arrivalHoldMs + 50)
    expect(sim.state).toBe('arrived')
  })

  test('stairs and doors are within reach sooner: stairs at 2 m, a door at 1.5 m, a chair only at 1 m', () => {
    const at = (target: string, distanceM: number) => {
      const sim = new Sim()
      const [locate] = sim.locateEffects(sim.request(target))
      sim.located(locate.id, foundResult(0, 0.5, { onFloor: false, distanceM }))
      sim.tick(100)
      sim.tick(CFG.arrivalHoldMs + 50)
      return sim.state
    }
    expect(at('stairs', 2)).toBe('arrived')
    expect(at('stairs', 2.5)).toBe('guiding')
    expect(at('door', 1.5)).toBe('arrived')
    expect(at('door', 2)).toBe('guiding')
    expect(at('chair', 1.5)).toBe('guiding')
  })

  test('the stairs arrival says within reach, as for anything else', () => {
    const sim = new Sim()
    const [locate] = sim.locateEffects(sim.request('stairs'))
    sim.located(locate.id, foundResult(0, 0.5, { onFloor: false, distanceM: 2 }))
    sim.tick(100)
    expect(sim.said(sim.tick(CFG.arrivalHoldMs + 50))).toEqual(['Stairs ahead, within reach.'])
  })
})

describe('re-checks close to the target', () => {
  test('within 3 m Gemini is asked again every 3 s, as a look that skips the minimum gap', () => {
    const sim = new Sim()
    sim.guideByGemini({ onFloor: false, distanceM: 2.5 })
    expect(sim.locateEffects(sim.tick(CFG.nearRecheckIntervalMs - 100))).toEqual([])
    const [look] = sim.locateEffects(sim.tick(200))
    expect(look).toMatchObject({ type: 'locate', paced: false })
    expect([CFG.nearRecheckM, CFG.nearRecheckIntervalMs]).toEqual([3, 3000])
  })

  test('farther away it keeps the normal 6 s, paced', () => {
    const sim = new Sim()
    sim.guideByGemini({ onFloor: false, distanceM: 6 })
    expect(sim.locateEffects(sim.tick(CFG.nearRecheckIntervalMs + 100))).toEqual([])
    const [look] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs))
    expect(look).toMatchObject({ type: 'locate', paced: true })
  })

  test('a close re-check waits for the per-minute and concurrency caps', () => {
    const sim = new Sim()
    sim.guideByGemini({ onFloor: false, distanceM: 2.5 })
    expect(sim.locateEffects(sim.tick(CFG.nearRecheckIntervalMs + 100, { canLook: false }))).toEqual([])
    expect(sim.locateEffects(sim.tick(100, { canLook: true }))).toHaveLength(1)
  })
})

describe('keeping hold of a target (reliability)', () => {
  test('the detector keeps to the object it started with: a second chair does not take over at once', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 7 })
    sim.tick(100, { yolo: { angleDeg: 40, distanceM: 2, trackId: 9 } }) // a nearer chair appears
    expect(sim.ctx.memory?.heading).toBe(0) // still the first one's direction, not 40
    expect(sim.ctx.followId).toBe(7)
    sim.tick(100, { yolo: { angleDeg: 3, distanceM: 4, trackId: 7 } })
    expect(sim.ctx.memory?.heading).toBe(3)
  })

  test('once the first has been gone for a moment, the same object under a new id is taken up again', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 7 })
    sim.tick(100, { yolo: { angleDeg: 8, distanceM: 3.8, trackId: 9 } }) // too soon: ignored
    expect(sim.ctx.followId).toBe(7)
    sim.tick(CFG.yoloLostMs + 100, { yolo: { angleDeg: 8, distanceM: 3.8, trackId: 9 } })
    expect(sim.ctx.followId).toBe(9)
    expect(sim.ctx.memory?.heading).toBe(8)
  })

  test('a second chair elsewhere is never taken up, however long the first has been gone', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 7 })
    sim.tick(CFG.yoloLostMs * 3, { yolo: { angleDeg: 70, distanceM: 2, trackId: 9 } })
    expect(sim.ctx.followId).toBe(7)
    expect(sim.ctx.memory?.heading).toBe(0)
  })

  test('nor one a little off to the side (over 20 degrees), nor one on the same bearing at a different distance', () => {
    const aside = new Sim()
    aside.request('chair', { angleDeg: 0, distanceM: 3, trackId: 7 })
    aside.tick(CFG.yoloLostMs + 100, { yolo: { angleDeg: 25, distanceM: 3, trackId: 9 } })
    expect(aside.ctx.followId).toBe(7)
    const behind = new Sim()
    behind.request('chair', { angleDeg: 0, distanceM: 2, trackId: 7 })
    behind.tick(CFG.yoloLostMs + 100, { yolo: { angleDeg: 3, distanceM: 4.5, trackId: 9 } })
    expect(behind.ctx.followId).toBe(7)
  })

  test('walking up to the closest chair: when it slips out of the bottom of the view the next one is not taken instead', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 2, trackId: 7 })
    sim.tick(100, { yolo: { angleDeg: 0, distanceM: 2.4, trackId: 7, clipped: true } }) // its base leaves the frame
    sim.tick(CFG.yoloLostMs + 100, { yolo: { angleDeg: 12, distanceM: 2.4, trackId: 9 } }) // another chair close by
    expect(sim.ctx.followId).toBe(7)
    expect(sim.ctx.memory?.heading).toBe(0)
  })

  test('a chair Gemini found is handed to the detector when a detector chair sits on the same spot', () => {
    const sim = new Sim()
    sim.guideByGemini() // straight ahead, 7.5 m from the floor
    expect(sim.ctx.memory?.source).toBe('gemini')
    sim.tick(100, { yolo: { angleDeg: 15, distanceM: 7, trackId: 4 } }) // 15 degrees off: another chair
    expect(sim.ctx.memory?.source).toBe('gemini')
    sim.tick(100, { yolo: { angleDeg: 4, distanceM: 7, trackId: 5 } })
    expect(sim.ctx.memory).toMatchObject({ source: 'yolo', heading: 4, distanceM: 7 })
    expect(sim.ctx.followId).toBe(5)
    // from then on it is followed, and Gemini is not asked while the detector holds it
    expect(sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100, { yolo: { angleDeg: 3, distanceM: 6.5, trackId: 5 } }))).toEqual([])
  })

  test('a Gemini re-check that names a different chair is ignored; one near the first refines it', () => {
    const sim = new Sim()
    sim.guideByGemini() // straight ahead, 3 m
    const before = sim.ctx.memory?.heading
    const [other] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    // the frame was taken facing 60 degrees to the right and the box is in the middle: this chair lies about 60 right
    sim.located(other.id, foundResult(0, 0.5), [{ heading: 60, pitch: 0 }])
    expect(sim.ctx.memory?.heading).toBe(before)
    expect(sim.state).toBe('guiding')
    const [near] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    sim.located(near.id, foundResult(0, 0.6))
    expect(sim.ctx.memory?.heading).toBeCloseTo(6.5, 9)
  })

  test('an ignored answer is not a failure and not a find: the target is kept, and ages like any other', () => {
    const sim = new Sim()
    sim.guideByGemini()
    const [look] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    sim.located(look.id, foundResult(0, 0.5), [{ heading: 90, pitch: 0 }])
    expect(sim.ctx.failedRechecks).toBe(0)
    expect(sim.ctx.rechecking).toBe(false)
    expect(sim.state).toBe('guiding')
  })

  test('after losing it, a new search is free to take whichever chair comes first', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 7 })
    sim.tick(CFG.memoryMaxAgeMs + 100) // stale: lost
    expect(sim.state).toBe('lost')
    expect(sim.ctx.followId).toBeNull()
    sim.tick(100, { yolo: { angleDeg: 70, distanceM: 2, trackId: 9 } })
    expect(sim.state).toBe('guiding')
    expect(sim.ctx.followId).toBe(9)
  })

  test('a flicker of the detector does not trigger a Gemini re-check; a real loss does, after the pause', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 7 })
    sim.tick(CFG.recheckIntervalMs + 100, { yolo: { angleDeg: 0, distanceM: 4, trackId: 7 } })
    // the track is missing for one tick, long after the last re-check would have been due:
    expect(sim.locateEffects(sim.tick(200, { yolo: null }))).toEqual([])
    // gone for good: after the detector's grace and the re-check interval, Gemini is asked
    expect(sim.locateEffects(sim.tick(CFG.yoloLostMs, { yolo: null }))).toEqual([])
    expect(sim.locateEffects(sim.tick(CFG.recheckIntervalMs, { yolo: null }))).toHaveLength(1)
  })

  test('a direction word does not flap while the bearing wobbles around its boundary', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 12 })
    const said: string[][] = []
    for (const angle of [14, 17, 13, 18, 12, 19, 14, 16]) {
      said.push(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: angle, distanceM: 12 } })))
    }
    expect(said.flat()).toEqual([]) // never leaves "ahead" until it is clearly past the boundary
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 22, distanceM: 12 } }))).toEqual(['Bear right.'])
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 13, distanceM: 12 } }))).toEqual([]) // not back yet
    expect(sim.said(sim.tick(CFG.guideSpeechCooldownMs, { yolo: { angleDeg: 9, distanceM: 12 } }))).toEqual(['Straight ahead.'])
  })

  test('a target that slides out of the bottom of the frame as you walk up is not lost: you are asked to tilt down', () => {
    const sim = new Sim()
    sim.request('chair', { angleDeg: 0, distanceM: 4, trackId: 7 })
    // its base is out of view, then it leaves the frame altogether
    sim.tick(100, { yolo: { angleDeg: 0, distanceM: 3.2, trackId: 7, clipped: true } })
    const gone = sim.tick(CFG.guideSpeechCooldownMs, { yolo: null, pitch: -10 })
    expect(sim.said(gone)).toEqual([FIND_PHRASES.tiltDown])
    // it is not called lost, and nothing is counted against it
    sim.tick(2000, { yolo: null, pitch: -10 })
    expect(sim.state).toBe('guiding')
    expect(sim.ctx.failedRechecks).toBe(0)
  })

  test('the tilt request is made at most twice, not when the phone is already tilted down, and not when it is far off to the side', () => {
    const asked = (patch: { pitch: number | null }, angleDeg = 0) => {
      const sim = new Sim()
      sim.request('chair', { angleDeg, distanceM: 4, trackId: 7 })
      const seen = { angleDeg, distanceM: 2.2, trackId: 7, clipped: true }
      let count = 0
      const tilts = (effects: FindEffect[]) => sim.said(effects).filter((s) => s === FIND_PHRASES.tiltDown).length
      for (let i = 0; i < 4; i++) {
        count += tilts(sim.tick(CFG.tiltPromptCooldownMs, { yolo: seen, ...patch })) // seen cut off at the bottom
        count += tilts(sim.tick(CFG.guideSpeechCooldownMs, { yolo: null, ...patch })) // then gone from the frame
      }
      return count
    }
    expect(asked({ pitch: -5 })).toBe(CFG.tiltPromptMax)
    expect(asked({ pitch: CFG.tiltPitchDeg - 5 })).toBe(0)
    expect(asked({ pitch: -5 }, 80)).toBe(0)
  })

  test('a Gemini re-check that misses a target last seen cut off at the bottom is not held against it for a while', () => {
    const sim = new Sim()
    sim.guideByGemini({ box: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 1 } }) // cut off at the bottom
    expect(sim.ctx.memory?.clipped).toBe(true)
    const [look] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs))
    sim.located(look.id, notFoundResult())
    expect(sim.ctx.failedRechecks).toBe(0)
    expect(sim.state).toBe('guiding')
  })

  test('the target is called lost when it has been out of sight for a long time even though it was last seen cut off', () => {
    const sim = new Sim()
    sim.guideByGemini({ box: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 1 } })
    let [look] = sim.locateEffects(sim.tick(CFG.belowViewMaxMs + 100)) // too long ago for "just below the view"
    for (let i = 0; i < CFG.lostAfterFailedRechecks; i++) {
      sim.located(look.id, notFoundResult())
      if (i < CFG.lostAfterFailedRechecks - 1) [look] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
    }
    expect(sim.state).toBe('lost')
  })

  test('a failed re-check call (network, timeout) says nothing about the target and is never counted', () => {
    const sim = new Sim()
    sim.guideByGemini()
    for (let i = 0; i < 4; i++) {
      const [look] = sim.locateEffects(sim.tick(CFG.recheckIntervalMs + 100))
      sim.failed(look.id, 'network')
    }
    expect(sim.state).toBe('guiding')
    expect(sim.ctx.failedRechecks).toBe(0)
  })

  test('the first check is retried once, quietly, after a network hiccup or an unusable reply', () => {
    for (const code of ['network', 'bad_response'] as const) {
      const sim = new Sim()
      const [first] = sim.locateEffects(sim.request('chair'))
      const retry = sim.failed(first.id, code)
      expect(sim.state, code).toBe('checking')
      expect(sim.said(retry), code).toEqual([])
      const [second] = sim.locateEffects(retry)
      expect(second, code).toMatchObject({ type: 'locate', paced: false })
      expect(second.id).toBeGreaterThan(first.id)
      // the retry's answer is used
      sim.located(second.id, foundResult())
      expect(sim.state, code).toBe('guiding')
    }
  })

  test('a second failure of the first check ends in the error sentence, and refusals are not retried', () => {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('chair'))
    const [second] = sim.locateEffects(sim.failed(first.id, 'network'))
    expect(sim.said(sim.failed(second.id, 'network'))).toEqual([FIND_MESSAGES.network])
    expect(sim.state).toBe('error')

    // a timeout is not retried: a second slow try would only double the wait
    for (const code of ['timeout', 'quota', 'auth', 'bad_request', 'too_soon', 'limit'] as const) {
      const once = new Sim()
      const [look] = once.locateEffects(once.request('chair'))
      once.failed(look.id, code)
      expect(once.state, code).toBe('error')
    }
  })
})

describe('errors and silence', () => {
  test('offline during the first check: says it cannot reach the internet (after one quiet retry), then idle', () => {
    const sim = new Sim()
    const [locate] = sim.locateEffects(sim.request('chair'))
    const [retry] = sim.locateEffects(sim.failed(locate.id, 'network'))
    const effects = sim.failed(retry.id, 'network')
    expect(sim.state).toBe('error')
    expect(sim.said(effects)).toEqual(["I can't reach the internet, so I can't search."])
    sim.tick(CFG.resultHoldMs)
    expect(sim.state).toBe('idle')
  })

  test.each(['quota', 'timeout', 'network'] as const)('%s on every sweep look says what went wrong', (code) => {
    const sim = new Sim()
    const [first] = sim.locateEffects(sim.request('exit'))
    sim.located(first.id, notFoundResult())
    const captures = sim.captureEffects(sim.turnTo(360))
    let effects: FindEffect[] = []
    for (const capture of captures) effects = sim.failed(capture.id, code)
    expect(sim.state).toBe('error')
    expect(sim.said(effects)).toEqual([FIND_MESSAGES[code]])
  })

  test('every failure has its own sentence: what went wrong and what to do', () => {
    expect(FIND_MESSAGES.timeout).toBe('The search took too long. Try again.')
    expect(FIND_MESSAGES.quota).toBe('The search service is busy. Try again in a moment.')
    for (const code of ['auth', 'bad_response', 'bad_request'] as const) {
      const sim = new Sim()
      const [look] = sim.locateEffects(sim.request('chair'))
      let effects = sim.failed(look.id, code)
      const [retry] = sim.locateEffects(effects)
      if (retry) effects = sim.failed(retry.id, code)
      expect(sim.said(effects), code).toEqual([FIND_MESSAGES[code]])
    }
  })

  test('our own pacing limits get their own, more helpful sentences', () => {
    const slow = new Sim()
    const [a] = slow.locateEffects(slow.request('chair'))
    expect(slow.said(slow.failed(a.id, 'too_soon'))).toEqual([FIND_MESSAGES.too_soon])
    const capped = new Sim()
    const [b] = capped.locateEffects(capped.request('chair'))
    expect(capped.said(capped.failed(b.id, 'limit'))).toEqual([FIND_MESSAGES.limit])
  })

  test('no error sentence claims anything is still on', () => {
    for (const text of Object.values(FIND_MESSAGES)) expect(text).not.toMatch(/alert|still on/i)
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
  test('from every state returns to idle, says it stopped, and forgets any looks still out', () => {
    const setups: [string, (sim: Sim) => void][] = [
      ['checking', (sim) => void sim.request('chair')],
      ['guiding', (sim) => sim.guideByGemini()],
      ['sweeping', (sim) => {
        const [l] = sim.locateEffects(sim.request('chair'))
        sim.located(l.id, notFoundResult())
      }],
      ['arrived', (sim) => {
        sim.request('chair', { angleDeg: 0, distanceM: 4 })
        sim.hold({ angleDeg: 0, distanceM: 0.5 })
      }],
      ['error', (sim) => {
        const [l] = sim.locateEffects(sim.request('chair'))
        sim.failed(l.id, 'quota')
      }],
    ]
    for (const [state, setup] of setups) {
      const sim = new Sim()
      setup(sim)
      expect(sim.state, state).toBe(state)
      const effects = sim.cancel()
      expect(sim.state, state).toBe('idle')
      expect(sim.said(effects), state).toEqual([FIND_PHRASES.stopped])
      expect(sim.ctx.sweepPending, state).toEqual([])
      expect(sim.ctx.pending, state).toBeNull()
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
    expect(snapshotOf(sim.ctx, 0)).toEqual({
      state: 'idle',
      target: null,
      bearingDeg: null,
      distanceM: null,
      distanceIsBound: false,
      source: null,
      sweepFrames: 0,
    })
    sim.guideByGemini({}, 0.75)
    const snapshot = snapshotOf(sim.ctx, 0)
    expect(snapshot).toMatchObject({ state: 'guiding', target: 'chair', source: 'gemini' })
    expect(snapshot.bearingDeg).toBeCloseTo(16.25, 9)
    expect(snapshotOf(sim.ctx, null).bearingDeg).toBeNull()
  })
})
