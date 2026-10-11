// Guidance (R5, FR-25): what to say next while guiding to the target, as a pure function of the bearing, the distance,
// and what was last said. The words are GPS-style ("Turn right", "Bear left", "Straight ahead", "Turn around"), the
// distance counts down as the target gets near, and nothing is repeated more often than CONFIG.find allows.
// Nothing here says the way is clear or safe (SR-2): an instruction is only ever a direction to turn.
import { CONFIG } from '../core/config'
import type { FindStateName } from '../core/types'
import { stableDirection } from './phrases'
import type { Direction } from './phrases'

export type GuidanceInstruction =
  | 'turn-around'
  | 'turn-right'
  | 'turn-left'
  | 'bear-right'
  | 'bear-left'
  | 'straight'
  | 'around-left'
  | 'around-right'

export const GUIDANCE_PHRASES: Record<GuidanceInstruction, string> = {
  'turn-around': 'Turn around.',
  'turn-right': 'Turn right.',
  'turn-left': 'Turn left.',
  'bear-right': 'Bear right.',
  'bear-left': 'Bear left.',
  straight: 'Straight ahead.',
  'around-left': 'Bear left around the obstacle.',
  'around-right': 'Bear right around the obstacle.',
}

/** What the path line (R7) says about the way ahead when the target is straight ahead, or null when it has no opinion. */
export type PathDecision = 'left' | 'right' | 'straight' | null

export interface GuidanceInput {
  /** Degrees to turn to face the target; positive is to the right. */
  bearing: number
  distanceM: number | null
  /** The distance is only an upper bound (the target's base is out of the frame), so it cannot be counted down. */
  distanceIsBound?: boolean
  pathDecision?: PathDecision
  state: FindStateName
  /** The target's name, for the countdown ("chair, about 5 meters"). */
  label: string
  nowMs: number
}

export interface GuidanceState {
  /** The direction zone last used, so a bearing at a boundary does not flip between two words. */
  direction: Direction | null
  /** The instruction last spoken. */
  instruction: GuidanceInstruction | null
  /** When anything was last spoken here. */
  spokenAt: number
  /** Countdown distances (meters) already announced on this approach. */
  announced: number[]
}

export function initialGuidance(): GuidanceState {
  return { direction: null, instruction: null, spokenAt: -Infinity, announced: [] }
}

/** The instruction a direction stands for, with no obstacle in the way. */
export function instructionFor(direction: Direction): GuidanceInstruction {
  switch (direction) {
    case 'ahead':
      return 'straight'
    case 'slightly-right':
      return 'bear-right'
    case 'slightly-left':
      return 'bear-left'
    case 'right':
      return 'turn-right'
    case 'left':
      return 'turn-left'
    case 'behind':
      return 'turn-around'
  }
}

/** The state right after "<label> found, <direction>." was said, so the same thing is not said again at once. */
export function seedGuidance(direction: Direction, nowMs: number): GuidanceState {
  return { direction, instruction: instructionFor(direction), spokenAt: nowMs, announced: [] }
}

/** "chair, about 5 meters". */
export const countdownPhrase = (label: string, meters: number) => `${label}, about ${meters} meters.`

/**
 * The next thing to say, if anything, and the state to carry forward. An instruction is spoken when it changes, and an
 * instruction that asks the user to do something (turn, bear, go around) is repeated every guidanceRepeatMs until they
 * do; "Straight ahead" is not repeated, because the beacon already says it. Both wait at least guideSpeechCooldownMs
 * after the last phrase. The distance countdown comes next in priority: it speaks only when no instruction is due.
 */
export function nextGuidance(
  prev: GuidanceState,
  input: GuidanceInput,
  cfg: typeof CONFIG.find = CONFIG.find,
): { state: GuidanceState; say: string | null } {
  if (input.state !== 'guiding') return { state: initialGuidance(), say: null }

  const direction = stableDirection(prev.direction, input.bearing, cfg)
  const aligned = direction === 'ahead'
  const detour = input.pathDecision === 'left' ? 'around-left' : input.pathDecision === 'right' ? 'around-right' : null
  const instruction: GuidanceInstruction = aligned && detour ? detour : instructionFor(direction)

  // Countdown bookkeeping runs every call: levels the user has moved back out beyond are forgotten, so they are
  // announced again if the approach is repeated.
  const distance = input.distanceIsBound ? null : input.distanceM
  const announced =
    distance === null ? prev.announced : prev.announced.filter((level) => distance <= level + cfg.countdownResetM)
  const roughlyAligned = Math.abs(input.bearing) <= cfg.directionSlightDeg
  const crossed =
    distance !== null && roughlyAligned ? cfg.countdownM.filter((level) => distance <= level && !announced.includes(level)) : []

  const sinceMs = input.nowMs - prev.spokenAt
  const mayTalk = sinceMs >= cfg.guideSpeechCooldownMs
  const changed = instruction !== prev.instruction
  const repeat = !changed && instruction !== 'straight' && sinceMs >= cfg.guidanceRepeatMs

  if (mayTalk && (changed || repeat)) {
    return {
      state: { direction, instruction, spokenAt: input.nowMs, announced },
      say: GUIDANCE_PHRASES[instruction],
    }
  }
  if (mayTalk && crossed.length > 0) {
    // Jumping over several levels at once says only the nearest, and counts them all as done.
    const level = Math.min(...crossed)
    return {
      state: { direction, instruction: prev.instruction, spokenAt: input.nowMs, announced: [...announced, ...crossed] },
      say: countdownPhrase(input.label, level),
    }
  }
  return { state: { ...prev, direction, announced }, say: null }
}

