// The beacon (R5, FR-26): short pulses through the AirPods while guiding to a target. The pulses come faster as the
// target gets closer, sit in the stereo field where the target is, and change pitch when facing it; a low double pulse
// means the target is behind, because stereo alone cannot tell front from back. It ducks under speech, pauses for an
// urgent phrase (a health warning), and ends with a rising three-note chime on arrival.
//
// It uses the app's one AudioContext, and the same equal-power panner as the other tones. Pulses are scheduled a short
// way ahead on the audio clock (the timer only wakes the scheduler up), so their timing does not wobble with the main
// thread. The pure parts (the interval curve, the pan, the pulse shapes) are tested on their own.
import { CONFIG } from '../core/config'
import { createPan } from './tones'
import type { PanControl } from './tones'

type BeaconConfig = typeof CONFIG.beacon

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Time between pulses for a distance: maxIntervalMs at farM or farther or when unknown, minIntervalMs at nearM or
 * nearer, and a curve between (cfg.curve is the exponent: 1 is a straight line).
 */
export function pulseIntervalMs(distanceM: number | null, cfg: BeaconConfig = CONFIG.beacon): number {
  if (distanceM === null || !Number.isFinite(distanceM)) return cfg.maxIntervalMs
  const t = clamp((distanceM - cfg.nearM) / (cfg.farM - cfg.nearM), 0, 1)
  return cfg.minIntervalMs + (cfg.maxIntervalMs - cfg.minIntervalMs) * t ** cfg.curve
}

/** Stereo pan for a bearing: sin(bearing), so straight ahead is centered and 90 degrees off is fully to that side. */
export function beaconPan(bearingDeg: number): number {
  if (!Number.isFinite(bearingDeg)) return 0
  return clamp(Math.sin((bearingDeg * Math.PI) / 180), -1, 1)
}

export type PulseKind = 'aligned' | 'front' | 'behind'

/** Facing the target (within alignedDeg), off to the side, or with it behind (more than behindDeg off). */
export function pulseKind(bearingDeg: number, cfg: BeaconConfig = CONFIG.beacon): PulseKind {
  const size = Math.abs(bearingDeg)
  if (size > cfg.behindDeg) return 'behind'
  if (size < cfg.alignedDeg) return 'aligned'
  return 'front'
}

/** One note of a pulse or chime, relative to when it starts. */
export interface BeaconNote {
  offsetMs: number
  durationMs: number
  hz: number
}

/** The notes of one pulse: a single blip, or two low ones for a target behind. */
export function pulseNotes(kind: PulseKind, cfg: BeaconConfig = CONFIG.beacon): BeaconNote[] {
  switch (kind) {
    case 'aligned':
      return [{ offsetMs: 0, durationMs: cfg.pulseMs, hz: cfg.alignedHz }]
    case 'front':
      return [{ offsetMs: 0, durationMs: cfg.pulseMs, hz: cfg.frontHz }]
    case 'behind':
      return [
        { offsetMs: 0, durationMs: cfg.pulseMs, hz: cfg.behindHz },
        { offsetMs: cfg.pulseMs + cfg.behindGapMs, durationMs: cfg.pulseMs, hz: cfg.behindHz },
      ]
  }
}

/** The arrival chime: three rising notes, one after another. */
export function chimeNotes(cfg: BeaconConfig = CONFIG.beacon): BeaconNote[] {
  return cfg.chimeHz.map((hz, i) => ({ offsetMs: i * cfg.chimeNoteMs, durationMs: cfg.chimeNoteMs, hz }))
}

export interface BeaconTarget {
  /** Degrees to turn to face the target; positive is to the right. */
  bearingDeg: number
  /** Estimated distance in meters, or null when unknown. */
  distanceM: number | null
}

export interface BeaconDeps {
  /** The app's one AudioContext; the beacon never creates another. */
  ctx: AudioContext
  /** Speech state: the beacon ducks while a phrase plays and pauses while an urgent one does. */
  speaker: { isBusy(): boolean; isUrgent(): boolean }
  /** The tone volume setting, 0 to 1. */
  volume: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  config?: BeaconConfig
}

/** Fade in and out over this long so notes do not click. */
const RAMP_S = 0.004

export class Beacon {
  private readonly ctx: AudioContext
  private readonly deps: BeaconDeps
  private readonly cfg: BeaconConfig
  private readonly master: GainNode
  private readonly pan: PanControl
  private readonly chimeOut: GainNode
  private readonly active = new Set<OscillatorNode>()
  private timer: unknown = null
  private running = false
  private nextPulseS = 0
  private duckTarget = 1
  private target: BeaconTarget = { bearingDeg: 0, distanceM: null }

  constructor(deps: BeaconDeps) {
    this.deps = deps
    this.ctx = deps.ctx
    this.cfg = deps.config ?? CONFIG.beacon
    // Pulses go through a panner and a master gain (for ducking); the chime has its own output so it is never ducked.
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    this.pan = createPan(this.ctx)
    this.pan.node.connect(this.master)
    this.chimeOut = this.ctx.createGain()
    this.chimeOut.connect(this.ctx.destination)
  }

  isRunning(): boolean {
    return this.running
  }

  /** Start pulsing. Safe to call again while running. */
  start(): void {
    if (this.running) return
    this.running = true
    this.nextPulseS = this.ctx.currentTime + 0.05
    this.duckTarget = 1
    this.master.gain.setValueAtTime(1, this.ctx.currentTime)
    const setTimer = this.deps.setTimer ?? ((callback, ms) => setInterval(callback, ms))
    this.timer = setTimer(() => this.tick(), this.cfg.tickMs)
  }

  /** Stop at once: the timer, and any pulse already scheduled. */
  stop(): void {
    if (!this.running) return
    this.running = false
    const clearTimer = this.deps.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
    clearTimer(this.timer)
    this.timer = null
    for (const osc of this.active) {
      try {
        osc.stop()
      } catch {
        // Already ended.
      }
    }
    this.active.clear()
  }

  /** Where the target is now; the next pulse to be scheduled uses it. */
  update(target: BeaconTarget): void {
    this.target = target
  }

  /** The arrival chime. Plays whether or not the beacon is running, and is not ducked. */
  chime(): void {
    const at = this.ctx.currentTime + 0.02
    const level = clamp(this.deps.volume(), 0, 1) * 0.8
    for (const note of chimeNotes(this.cfg)) this.playNote(this.chimeOut, note, at, level)
  }

  /** One wake-up of the scheduler: duck or pause for speech, then schedule the pulses that fall inside the lookahead. */
  private tick(): void {
    if (!this.running) return
    const now = this.ctx.currentTime
    const speaker = this.deps.speaker
    const urgent = speaker.isUrgent()
    const target = urgent ? 0 : speaker.isBusy() ? this.cfg.duckGain : 1
    if (target !== this.duckTarget) {
      this.duckTarget = target
      this.master.gain.setTargetAtTime(target, now, 0.04)
    }
    if (urgent) {
      // Paused: no new pulses, and the clock moves on so there is no burst of catch-up pulses afterwards.
      this.nextPulseS = Math.max(this.nextPulseS, now + 0.05)
      return
    }
    // Late (the page was busy or in the background): start again from now instead of firing every missed pulse.
    if (this.nextPulseS < now) this.nextPulseS = now + 0.02
    const horizon = now + this.cfg.lookaheadMs / 1000
    while (this.nextPulseS < horizon) {
      this.schedulePulse(this.nextPulseS)
      this.nextPulseS += pulseIntervalMs(this.target.distanceM, this.cfg) / 1000
    }
  }

  private schedulePulse(at: number): void {
    const { bearingDeg } = this.target
    const level = clamp(this.deps.volume(), 0, 1) * this.cfg.gain
    this.pan.set(beaconPan(bearingDeg), at)
    for (const note of pulseNotes(pulseKind(bearingDeg, this.cfg), this.cfg)) this.playNote(this.pan.node, note, at, level)
  }

  private playNote(into: AudioNode, note: BeaconNote, startS: number, level: number): void {
    const at = startS + note.offsetMs / 1000
    const end = at + note.durationMs / 1000
    const osc = this.ctx.createOscillator()
    const env = this.ctx.createGain()
    osc.frequency.setValueAtTime(note.hz, at)
    env.gain.setValueAtTime(0, at)
    env.gain.linearRampToValueAtTime(level, at + RAMP_S)
    env.gain.setValueAtTime(level, Math.max(at + RAMP_S, end - RAMP_S))
    env.gain.linearRampToValueAtTime(0, end)
    osc.connect(env)
    env.connect(into)
    osc.onended = () => {
      this.active.delete(osc)
      env.disconnect()
    }
    this.active.add(osc)
    osc.start(at)
    osc.stop(end)
  }
}
