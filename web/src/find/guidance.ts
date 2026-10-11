// Guidance (R5, FR-25): what to say next while guiding to the target, as a pure function of the bearing, the distance,
// and what was last said. The words are GPS-style ("Turn right", "Bear left", "Straight ahead", "Turn around"), the
// distance is told in three levels (far, close, within reach), and nothing is repeated more often than CONFIG.find allows.
// Nothing here says the way is clear or safe (SR-2): an instruction is only ever a direction to turn.
import { CONFIG } from '../core/config'
import type { FindStateName } from '../core/types'
import { depthLevel, levelPhrase, stableDirection } from './phrases'
import type { DepthLevel, Direction } from './phrases'

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
  /** The distance is only an upper bound (the target's base is out of the frame), so it can never say "far". */
  distanceIsBound?: boolean
  pathDecision?: PathDecision
  state: FindStateName
  /** The target's name, for the level ("Chair is close."). */
  label: string
  nowMs: number
  /**
   * Something is being said right now. A new instruction would only wait in line and be old by the time it is spoken
   * (and the speaker keeps only the newest waiting phrase), so guidance waits for the end of the phrase instead.
   */
  speaking?: boolean
}

export interface GuidanceState {
  /** The direction zone last used, so a bearing at a boundary does not flip between two words. */
  direction: Direction | null
  /** The instruction last spoken. */
  instruction: GuidanceInstruction | null
  /** When anything was last spoken here. */
  spokenAt: number
  /** The nearest level said on this approach, or null. */
  level: DepthLevel | null
}

export function initialGuidance(): GuidanceState {
  return { direction: null, instruction: null, spokenAt: -Infinity, level: null }
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

/**
 * The state right after "<label> found, <direction>." was said, so the same thing is not said again at once. The level
 * the target is at when found is taken as already known: only a nearer one is announced afterwards.
 */
export function seedGuidance(direction: Direction, nowMs: number, level: DepthLevel | null = null): GuidanceState {
  return { direction, instruction: instructionFor(direction), spokenAt: nowMs, level }
}

const LEVEL_RANK: Record<DepthLevel, number> = { reach: 0, close: 1, far: 2 }

/** The far edge of a level, in meters. */
function levelEdgeM(level: DepthLevel, cfg: typeof CONFIG.find): number {
  return level === 'reach' ? cfg.arrivalDistanceM : level === 'close' ? cfg.levelCloseM : Infinity
}

/**
 * The next thing to say, if anything, and the state to carry forward. An instruction is spoken when it changes, and an
 * instruction that asks the user to do something (turn, bear, go around) is repeated every guidanceRepeatMs until they
 * do; "Straight ahead" is not repeated, because the beacon already says it. Both wait at least guideSpeechCooldownMs
 * after the last phrase. The depth level comes next in priority: it speaks only when no instruction is due. "Within reach" is left to the arrival phrase.
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

  // Depth: far or close is said when the target comes into a nearer level while roughly facing it. The bookkeeping
  // runs every call: once the user is back out beyond the level last said by levelResetM it is forgotten, so a repeated
  // approach is told again.
  const level = depthLevel(input.distanceM, input.distanceIsBound === true, cfg)
  let told = prev.level
  const measured = input.distanceIsBound !== true && input.distanceM !== null
  if (told !== null && level !== null && measured && (input.distanceM as number) > levelEdgeM(told, cfg) + cfg.levelResetM) {
    told = level
  }
  const roughlyAligned = Math.abs(input.bearing) <= cfg.directionSlightDeg
  const nearer =
    (level === 'far' || level === 'close') && roughlyAligned && (told === null || LEVEL_RANK[level] < LEVEL_RANK[told])

  const sinceMs = input.nowMs - prev.spokenAt
  const mayTalk = sinceMs >= cfg.guideSpeechCooldownMs && input.speaking !== true
  const changed = instruction !== prev.instruction
  const repeat = !changed && instruction !== 'straight' && sinceMs >= cfg.guidanceRepeatMs

  if (mayTalk && (changed || repeat)) {
    return {
      state: { direction, instruction, spokenAt: input.nowMs, level: told },
      say: GUIDANCE_PHRASES[instruction],
    }
  }
  if (mayTalk && nearer) {
    return {
      state: { direction, instruction: prev.instruction, spokenAt: input.nowMs, level },
      say: levelPhrase(input.label, level as 'far' | 'close'),
    }
  }
  return { state: { ...prev, direction, level: told }, say: null }
}

