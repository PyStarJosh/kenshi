// Tones: the directional lead-in before a phrase, the health warning, and the heartbeat tick.
// Pure plans (what to play) are kept apart from TonePlayer (the Web Audio adapter).
import { CONFIG } from '../core/config'
import type { AlertPriority } from '../core/types'

/** One note of a tone, relative to the moment the tone starts. */
export interface ToneNote {
  offsetMs: number
  durationMs: number
  hz: number
  /** 0..1 before the volume setting is applied. */
  gain: number
}

/** A tone ready to play: its notes, where it sits in the stereo field, and how loud. */
export interface TonePlan {
  notes: ToneNote[]
  /** -1 (left) to 1 (right). */
  pan: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Stereo pan for an object at a horizontal angle: the frame edges map to full left and right. */
export function panFromAngle(angleDeg: number, horizontalFovDeg: number): number {
  const half = horizontalFovDeg / 2
  if (!(half > 0) || !Number.isFinite(angleDeg)) return 0
  return clamp(angleDeg / half, -1, 1)
}

/** Gap between urgent pulses: shorter when closer. An unknown distance pulses at the fastest rate. */
export function urgentPulseGapMs(distanceM: number | null): number {
  const { urgentPulseGapMinMs: min, urgentPulseGapMaxMs: max, urgentPulseNearM: near } = CONFIG.audio
  if (distanceM === null || !Number.isFinite(distanceM)) return min
  const far = CONFIG.alerts.urgentDistanceM
  const t = clamp((distanceM - near) / (far - near), 0, 1)
  return min + t * (max - min)
}

/** The lead-in tone for an alert. */
export function alertTone(priority: AlertPriority, pan: number, distanceM: number | null): TonePlan {
  const audio = CONFIG.audio
  const safePan = clamp(Number.isFinite(pan) ? pan : 0, -1, 1)
  if (priority === 'urgent') {
    const step = audio.urgentPulseMs + urgentPulseGapMs(distanceM)
    const notes = Array.from({ length: audio.urgentPulseCount }, (_, i) => ({
      offsetMs: i * step,
      durationMs: audio.urgentPulseMs,
      hz: audio.urgentToneHz,
      gain: 1,
    }))
    return { notes, pan: safePan }
  }
  const hz = priority === 'normal' ? audio.normalToneHz : audio.infoToneHz
  const gain = priority === 'normal' ? 1 : audio.infoToneGain
  return { notes: [{ offsetMs: 0, durationMs: audio.toneDurationMs, hz, gain }], pan: safePan }
}

/** The health warning: two falling tones, centered, distinct from every alert tone. */
export function warningTone(): TonePlan {
  const { warningToneHz, warningToneMs } = CONFIG.audio
  return {
    notes: warningToneHz.map((hz, i) => ({ offsetMs: i * warningToneMs, durationMs: warningToneMs, hz, gain: 1 })),
    pan: 0,
  }
}

/** Listening earcon: two rising notes at the start, the same two falling at the stop. Centered, soft. */
export function listeningTone(phase: 'start' | 'stop'): TonePlan {
  const { earconHz, earconNoteMs } = CONFIG.voice
  const hz = phase === 'start' ? earconHz : [...earconHz].reverse()
  return {
    notes: hz.map((value, i) => ({ offsetMs: i * earconNoteMs, durationMs: earconNoteMs, hz: value, gain: 0.7 })),
    pan: 0,
  }
}

export function heartbeatTone(): TonePlan {
  const { heartbeatToneHz, heartbeatToneMs } = CONFIG.audio
  return { notes: [{ offsetMs: 0, durationMs: heartbeatToneMs, hz: heartbeatToneHz, gain: 1 }], pan: 0 }
}

/** Total length of a tone. */
export function toneLengthMs(plan: TonePlan): number {
  return plan.notes.reduce((end, note) => Math.max(end, note.offsetMs + note.durationMs), 0)
}

/** When a tone was scheduled, in performance.now() milliseconds. */
export interface ToneTiming {
  startMs: number
  endMs: number
}

export interface TonePlayerLike {
  play(plan: TonePlan, volume: number): ToneTiming
  /** Silence whatever is playing (urgent preemption). */
  stop(): void
  /** performance.now() time when the last scheduled tone ends. */
  busyUntilMs(): number
}

/** Fade in and out over this long so notes do not click. */
const RAMP_S = 0.005

export interface PanControl {
  node: AudioNode
  set(pan: number, atTime: number): void
}

/** StereoPannerNode where available, an equal-power PannerNode otherwise (older Safari). */
export function createPan(ctx: AudioContext): PanControl {
  if (typeof ctx.createStereoPanner === 'function') {
    const node = ctx.createStereoPanner()
    return { node, set: (pan, at) => node.pan.setValueAtTime(pan, at) }
  }
  const node = ctx.createPanner()
  node.panningModel = 'equalpower'
  return {
    node,
    set: (pan, at) => {
      const z = 1 - Math.abs(pan)
      if (node.positionX) {
        node.positionX.setValueAtTime(pan, at)
        node.positionY.setValueAtTime(0, at)
        node.positionZ.setValueAtTime(z, at)
      } else {
        node.setPosition(pan, 0, z)
      }
    },
  }
}

/**
 * Plays tone plans on an unlocked AudioContext. The panner and output gain are built once, so a tone
 * only needs its oscillators; notes are scheduled on the audio clock, not with timers.
 */
export class TonePlayer implements TonePlayerLike {
  private ctx: AudioContext
  private pan: PanControl
  private output: GainNode
  private active = new Set<OscillatorNode>()
  private endMs = 0

  constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.output = ctx.createGain()
    this.output.connect(ctx.destination)
    this.pan = createPan(ctx)
    this.pan.node.connect(this.output)
  }

  play(plan: TonePlan, volume: number): ToneTiming {
    const lookaheadMs = CONFIG.audio.toneLookaheadMs
    const startS = this.ctx.currentTime + lookaheadMs / 1000
    const startMs = performance.now() + lookaheadMs
    this.pan.set(plan.pan, startS)
    for (const note of plan.notes) {
      const at = startS + note.offsetMs / 1000
      const end = at + note.durationMs / 1000
      const peak = Math.max(0, Math.min(1, note.gain * volume))
      const osc = this.ctx.createOscillator()
      const env = this.ctx.createGain()
      osc.frequency.setValueAtTime(note.hz, at)
      env.gain.setValueAtTime(0, at)
      env.gain.linearRampToValueAtTime(peak, at + RAMP_S)
      env.gain.setValueAtTime(peak, Math.max(at + RAMP_S, end - RAMP_S))
      env.gain.linearRampToValueAtTime(0, end)
      osc.connect(env)
      env.connect(this.pan.node)
      osc.onended = () => {
        this.active.delete(osc)
        env.disconnect()
      }
      this.active.add(osc)
      osc.start(at)
      osc.stop(end)
    }
    this.endMs = Math.max(this.endMs, startMs + toneLengthMs(plan))
    return { startMs, endMs: startMs + toneLengthMs(plan) }
  }

  stop(): void {
    for (const osc of this.active) osc.stop()
    this.active.clear()
    this.endMs = 0
  }

  busyUntilMs(): number {
    return this.endMs
  }
}
