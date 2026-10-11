import { describe, expect, test, vi } from 'vitest'
import { CONFIG } from '../core/config'
import { Beacon, beaconPan, chimeNotes, pulseIntervalMs, pulseKind, pulseNotes } from './beacon'

const CFG = CONFIG.beacon

describe('the pulse interval curve', () => {
  test('about a second at 10 m or farther, or when the distance is unknown', () => {
    expect(pulseIntervalMs(null)).toBe(1000)
    expect(pulseIntervalMs(10)).toBe(1000)
    expect(pulseIntervalMs(25)).toBe(1000)
    expect(pulseIntervalMs(Number.NaN)).toBe(1000)
  })

  test('0.15 seconds at 1 m or nearer', () => {
    expect(pulseIntervalMs(1)).toBe(150)
    expect(pulseIntervalMs(0.4)).toBe(150)
    expect(pulseIntervalMs(0)).toBe(150)
  })

  test('shrinks steadily as the distance shrinks', () => {
    let previous = Infinity
    for (let d = 10; d >= 1; d -= 0.5) {
      const interval = pulseIntervalMs(d)
      expect(interval).toBeLessThanOrEqual(previous)
      previous = interval
    }
    expect(pulseIntervalMs(5.5)).toBeCloseTo(575, 6) // the middle of a straight line from 150 to 1000
    expect(pulseIntervalMs(7)).toBeGreaterThan(pulseIntervalMs(3))
  })

  test('the curve exponent in config bends it: above 1 the pulses stay slow longer and speed up late', () => {
    const bent = { ...CFG, curve: 2 }
    expect(pulseIntervalMs(5.5, bent)).toBeLessThan(pulseIntervalMs(5.5, CFG)) // (0.5)^2 = 0.25 of the span, not 0.5
    expect(pulseIntervalMs(5.5, bent)).toBeCloseTo(150 + 850 * 0.25, 6)
    expect(pulseIntervalMs(10, bent)).toBe(1000)
    expect(pulseIntervalMs(1, bent)).toBe(150)
  })

  test('the owner\'s numbers', () => {
    expect([CFG.farM, CFG.nearM, CFG.maxIntervalMs, CFG.minIntervalMs]).toEqual([10, 1, 1000, 150])
  })
})

describe('pan', () => {
  test('is the sine of the bearing, so ahead is centered and 90 degrees off is fully to that side', () => {
    expect(beaconPan(0)).toBe(0)
    expect(beaconPan(90)).toBe(1)
    expect(beaconPan(-90)).toBe(-1)
    expect(beaconPan(30)).toBeCloseTo(0.5, 9)
    expect(beaconPan(-30)).toBeCloseTo(-0.5, 9)
  })

  test('behind it comes back toward the middle (the pitch and the double pulse say "behind")', () => {
    expect(beaconPan(135)).toBeCloseTo(Math.SQRT1_2, 9)
    expect(Math.abs(beaconPan(180))).toBeLessThan(1e-9)
  })

  test('never leaves -1 to 1, and a bad bearing is centered', () => {
    for (let b = -720; b <= 720; b += 7) expect(Math.abs(beaconPan(b))).toBeLessThanOrEqual(1)
    expect(beaconPan(Number.NaN)).toBe(0)
  })
})

describe('the pulse shapes', () => {
  test('facing the target (under 15 degrees): the higher pitch; off to the side: the plain one', () => {
    expect(pulseKind(0)).toBe('aligned')
    expect(pulseKind(14.9)).toBe('aligned')
    expect(pulseKind(-14.9)).toBe('aligned')
    expect(pulseKind(15)).toBe('front')
    expect(pulseKind(-60)).toBe('front')
    expect(pulseKind(90)).toBe('front')
    const aligned = pulseNotes('aligned')
    const front = pulseNotes('front')
    expect(aligned).toHaveLength(1)
    expect(front).toHaveLength(1)
    expect(aligned[0].hz).toBeGreaterThan(front[0].hz)
  })

  test('behind (over 90 degrees): a distinct low double pulse', () => {
    expect(pulseKind(90.1)).toBe('behind')
    expect(pulseKind(-170)).toBe('behind')
    const notes = pulseNotes('behind')
    expect(notes).toHaveLength(2)
    expect(notes[0].hz).toBe(notes[1].hz)
    expect(notes[0].hz).toBeLessThan(pulseNotes('front')[0].hz)
    expect(notes[1].offsetMs).toBe(CFG.pulseMs + CFG.behindGapMs)
  })

  test('the chime is three rising notes in a row', () => {
    const notes = chimeNotes()
    expect(notes).toHaveLength(3)
    expect(notes[0].hz).toBeLessThan(notes[1].hz)
    expect(notes[1].hz).toBeLessThan(notes[2].hz)
    expect(notes.map((n) => n.offsetMs)).toEqual([0, CFG.chimeNoteMs, 2 * CFG.chimeNoteMs])
  })
})

// ---- The scheduler, on a fake AudioContext that records what is scheduled and where ----

interface FakeOsc {
  hz: number
  startS: number
  endS: number
  stoppedEarly: boolean
}

function setup(over: { busy?: boolean; urgent?: boolean; volume?: number } = {}) {
  const oscs: FakeOsc[] = []
  const pans: { value: number; at: number }[] = []
  const ramps: number[] = []
  const gains: { setTargetAtTime: ReturnType<typeof vi.fn>; connectedTo: unknown[] }[] = []
  const state = { busy: over.busy ?? false, urgent: over.urgent ?? false, volume: over.volume ?? 1 }
  const destination = { name: 'destination' }
  const ctx = {
    currentTime: 0,
    destination,
    createGain() {
      const node = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn((value: number) => {
            ramps.push(value)
          }),
          setTargetAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      gains.push({ setTargetAtTime: node.gain.setTargetAtTime, connectedTo: node.connect.mock.calls })
      return node
    },
    createOscillator() {
      const osc: FakeOsc = { hz: 0, startS: 0, endS: 0, stoppedEarly: false }
      oscs.push(osc)
      return {
        frequency: { setValueAtTime: (hz: number) => (osc.hz = hz) },
        connect: vi.fn(),
        start: (at: number) => (osc.startS = at),
        stop: (at?: number) => {
          if (at === undefined) osc.stoppedEarly = true
          else osc.endS = at
        },
        onended: null as (() => void) | null,
      }
    },
    createStereoPanner() {
      return { pan: { setValueAtTime: (value: number, at: number) => pans.push({ value, at }) }, connect: vi.fn() }
    },
  }
  let wake: (() => void) | null = null
  let cleared = 0
  const beacon = new Beacon({
    ctx: ctx as unknown as AudioContext,
    speaker: { isBusy: () => state.busy, isUrgent: () => state.urgent },
    volume: () => state.volume,
    setTimer: (callback) => {
      wake = callback
      return 'timer'
    },
    clearTimer: () => {
      wake = null
      cleared += 1
    },
  })
  const tick = (toS: number) => {
    ctx.currentTime = toS
    wake?.()
  }
  return { beacon, ctx, oscs, pans, ramps, gains, state, tick, hasTimer: () => wake !== null, cleared: () => cleared }
}

describe('the scheduler', () => {
  test('does nothing until started, and schedules nothing after it is stopped', () => {
    const t = setup()
    expect(t.hasTimer()).toBe(false)
    t.beacon.start()
    expect(t.hasTimer()).toBe(true)
    t.beacon.stop()
    expect(t.hasTimer()).toBe(false)
    t.tick(5)
    expect(t.oscs).toHaveLength(0)
  })

  test('pulses are scheduled ahead on the audio clock: the first inside the lookahead, the next one interval later', () => {
    const t = setup()
    t.beacon.update({ bearingDeg: 0, distanceM: null })
    t.beacon.start()
    t.tick(0)
    expect(t.oscs.map((o) => o.startS)).toEqual([0.05]) // nothing else falls inside the 120 ms lookahead
    t.tick(0.9)
    expect(t.oscs).toHaveLength(1)
    t.tick(1.0) // 1.05 is inside [1.0, 1.12]
    expect(t.oscs.map((o) => o.startS)).toEqual([0.05, 1.05])
    expect(t.oscs[0].endS).toBeCloseTo(0.05 + CFG.pulseMs / 1000, 9)
  })

  test('the spacing shrinks as the distance does, following the curve', () => {
    const starts = (distanceM: number | null) => {
      const t = setup()
      t.beacon.update({ bearingDeg: 0, distanceM })
      t.beacon.start()
      for (let s = 0; s <= 2.2; s += 0.025) t.tick(s)
      return t.oscs.map((o) => o.startS)
    }
    const gap = (list: number[]) => list[1] - list[0]
    expect(gap(starts(null))).toBeCloseTo(1.0, 6)
    expect(gap(starts(5.5))).toBeCloseTo(0.575, 6)
    expect(gap(starts(1))).toBeCloseTo(0.15, 6)
    expect(starts(1).length).toBeGreaterThan(starts(5.5).length)
    expect(starts(5.5).length).toBeGreaterThan(starts(null).length)
  })

  test('walking toward the target speeds the pulses up: each new distance changes the next gap', () => {
    const t = setup()
    t.beacon.update({ bearingDeg: 0, distanceM: 9 })
    t.beacon.start()
    t.tick(0)
    t.beacon.update({ bearingDeg: 0, distanceM: 2 })
    for (let s = 0.025; s <= 3; s += 0.025) t.tick(s)
    const starts = t.oscs.map((o) => o.startS)
    const gaps = starts.slice(1).map((s, i) => s - starts[i])
    expect(gaps[0]).toBeCloseTo(pulseIntervalMs(9) / 1000, 6) // the pulse already scheduled used the old distance
    expect(gaps[1]).toBeCloseTo(pulseIntervalMs(2) / 1000, 6)
    expect(gaps[1]).toBeLessThan(gaps[0])
  })

  test('each pulse is panned to the bearing it is scheduled with, at its own time', () => {
    const t = setup()
    t.beacon.update({ bearingDeg: 90, distanceM: 1 })
    t.beacon.start()
    t.tick(0)
    t.beacon.update({ bearingDeg: -30, distanceM: 1 })
    t.tick(0.2)
    expect(t.pans[0]).toEqual({ value: 1, at: 0.05 })
    expect(t.pans[1].value).toBeCloseTo(-0.5, 9)
    expect(t.pans[1].at).toBeGreaterThan(t.pans[0].at)
  })

  test('the pitch is higher when facing the target, and a target behind gets a low double pulse', () => {
    const hzFor = (bearingDeg: number) => {
      const t = setup()
      t.beacon.update({ bearingDeg, distanceM: null })
      t.beacon.start()
      t.tick(0)
      return t.oscs.map((o) => o.hz)
    }
    expect(hzFor(5)).toEqual([CFG.alignedHz])
    expect(hzFor(40)).toEqual([CFG.frontHz])
    expect(hzFor(-40)).toEqual([CFG.frontHz])
    expect(hzFor(120)).toEqual([CFG.behindHz, CFG.behindHz])
    expect(hzFor(-179)).toEqual([CFG.behindHz, CFG.behindHz])
  })

  test('the loudness follows the tone volume setting', () => {
    const quiet = setup({ volume: 0.4 })
    quiet.beacon.start()
    quiet.tick(0)
    expect(Math.max(...quiet.ramps)).toBeCloseTo(0.4 * CFG.gain, 9)
    const off = setup({ volume: 0 })
    off.beacon.start()
    off.tick(0)
    expect(Math.max(...off.ramps)).toBe(0)
  })
})

describe('speech and urgent alerts', () => {
  test('it ducks under speech and comes back when the speech ends', () => {
    const t = setup()
    t.beacon.start()
    t.tick(0)
    const duck = t.gains[0].setTargetAtTime // the master gain is the first one made
    expect(duck).not.toHaveBeenCalled()
    t.state.busy = true
    t.tick(0.1)
    expect(duck).toHaveBeenLastCalledWith(CFG.duckGain, 0.1, expect.any(Number))
    t.state.busy = false
    t.tick(0.2)
    expect(duck).toHaveBeenLastCalledWith(1, 0.2, expect.any(Number))
    expect(duck).toHaveBeenCalledTimes(2) // only on a change, not on every wake-up
  })

  test('it keeps pulsing, quieter, while speech plays', () => {
    const t = setup({ busy: true })
    t.beacon.start()
    for (let s = 0; s <= 1.2; s += 0.025) t.tick(s)
    expect(t.oscs.length).toBeGreaterThan(0)
  })

  test('an urgent phrase pauses it: nothing new is scheduled, and it is silenced', () => {
    const t = setup()
    t.beacon.start()
    t.tick(0)
    expect(t.oscs).toHaveLength(1)
    t.state.urgent = true
    t.state.busy = true
    for (let s = 0.025; s <= 3; s += 0.025) t.tick(s)
    expect(t.oscs).toHaveLength(1)
    expect(t.gains[0].setTargetAtTime).toHaveBeenLastCalledWith(0, expect.any(Number), expect.any(Number))
  })

  test('after the urgent phrase it resumes without a burst of the pulses it missed', () => {
    const t = setup()
    t.beacon.update({ bearingDeg: 0, distanceM: 1 }) // a pulse every 0.15 s
    t.beacon.start()
    t.state.urgent = true
    for (let s = 0; s <= 2; s += 0.025) t.tick(s)
    expect(t.oscs).toHaveLength(0)
    t.state.urgent = false
    t.tick(2.0)
    t.tick(2.025)
    expect(t.oscs.length).toBeLessThanOrEqual(2)
    expect(Math.min(...t.oscs.map((o) => o.startS))).toBeGreaterThanOrEqual(2.0)
  })

  test('after a long stall (a busy or backgrounded page) it starts again from now, not with every missed pulse', () => {
    const t = setup()
    t.beacon.update({ bearingDeg: 0, distanceM: 1 })
    t.beacon.start()
    t.tick(0)
    t.tick(30)
    expect(t.oscs.length).toBeLessThanOrEqual(3)
    expect(Math.min(...t.oscs.slice(1).map((o) => o.startS))).toBeGreaterThanOrEqual(30)
  })
})

describe('stopping and the chime', () => {
  test('stopping silences the pulses already scheduled', () => {
    const t = setup()
    t.beacon.update({ bearingDeg: 0, distanceM: 1 })
    t.beacon.start()
    t.tick(0)
    t.beacon.stop()
    expect(t.oscs.every((o) => o.stoppedEarly)).toBe(true)
    expect(t.cleared()).toBe(1)
    expect(t.beacon.isRunning()).toBe(false)
  })

  test('starting twice, or stopping when not running, does nothing extra', () => {
    const t = setup()
    t.beacon.stop()
    t.beacon.start()
    t.beacon.start()
    t.beacon.stop()
    t.beacon.stop()
    expect(t.cleared()).toBe(1)
  })

  test('the chime is three rising notes, plays even when the beacon is not running, and is not ducked', () => {
    const t = setup({ busy: true })
    t.ctx.currentTime = 4
    t.beacon.chime()
    expect(t.oscs.map((o) => o.hz)).toEqual([...CFG.chimeHz])
    const starts = t.oscs.map((o) => o.startS)
    expect(starts[0]).toBeCloseTo(4.02, 9)
    expect(starts[1] - starts[0]).toBeCloseTo(CFG.chimeNoteMs / 1000, 9)
    expect(starts[2] - starts[1]).toBeCloseTo(CFG.chimeNoteMs / 1000, 9)
    expect(t.gains[0].setTargetAtTime).not.toHaveBeenCalled()
    expect(t.beacon.isRunning()).toBe(false)
  })

  test('it never makes a second AudioContext', () => {
    const t = setup()
    t.beacon.start()
    t.tick(0)
    t.beacon.chime()
    expect(t.oscs.length).toBeGreaterThan(0) // everything above went through the one context that was passed in
  })
})
