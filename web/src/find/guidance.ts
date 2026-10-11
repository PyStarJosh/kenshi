// Guidance (R5, FR-25): what to say next while guiding to the target, as a pure function of the bearing, the distance,
// and what was last said. The words are GPS-style ("Turn right", "Bear left", "Straight ahead", "Turn around"), the
// distance is told in words as the target gets nearer ("Chair is near.", "Chair is close."), and nothing is repeated
// more often than CONFIG.find allows.
// Nothing here says the way is clear or safe (SR-2): an instruction is only ever a direction to turn.
import { CONFIG } from '../core/config'
import type { FindStateName } from '../core/types'
import { bandPhrase, spokenBand, stableDirection } from './phrases'
import type { Direction, DistanceBand } from './phrases'

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
  /** The distance is only an upper bound (the target's base is out of the frame), so it can only ever say "close". */
  distanceIsBound?: boolean
  pathDecision?: PathDecision
  state: FindStateName
  /** The target's name, for the distance words ("Chair is near."). */
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
  /** The nearest distance word said on this approach, or null. */
  band: DistanceBand | null
}

export function initialGuidance(): GuidanceState {
  return { direction: null, instruction: null, spokenAt: -Infinity, band: null }
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
 * The state right after "<label> found, <direction>." (and its distance word, if one was said) was spoken, so the same
 * thing is not said again at once.
 */
export function seedGuidance(direction: Direction, nowMs: number, band: DistanceBand | null = null): GuidanceState {
  return { direction, instruction: instructionFor(direction), spokenAt: nowMs, band }
}

const BAND_RANK: Record<DistanceBand, number> = { close: 0, near: 1, far: 2 }

/** The far edge of a distance word, in meters ("far" has none). */
function bandEdgeM(band: DistanceBand, cfg: typeof CONFIG.find): number {
  return band === 'close' ? cfg.distanceCloseM : band === 'near' ? cfg.distanceNearM : Infinity
}

/**
 * The next thing to say, if anything, and the state to carry forward. An instruction is spoken when it changes, and an
 * instruction that asks the user to do something (turn, bear, go around) is repeated every guidanceRepeatMs until they
 * do; "Straight ahead" is not repeated, because the beacon already says it. Both wait at least guideSpeechCooldownMs
 * after the last phrase. The distance word comes next in priority: it speaks only when no instruction is due.
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

  // Distance words: one is said when the target comes into a nearer one (far, then near, then close) while roughly
  // facing it. The bookkeeping runs every call: once the user is back out beyond the word last said by bandResetM it is
  // forgotten, so a repeated approach is told again.
  const band = spokenBand(input.distanceM, input.distanceIsBound === true, cfg)
  let told = prev.band
  const measured = input.distanceIsBound !== true && input.distanceM !== null
  if (told !== null && band !== null && measured && (input.distanceM as number) > bandEdgeM(told, cfg) + cfg.bandResetM) {
    told = band
  }
  const roughlyAligned = Math.abs(input.bearing) <= cfg.directionSlightDeg
  const nearer = band !== null && roughlyAligned && (told === null || BAND_RANK[band] < BAND_RANK[told])

  const sinceMs = input.nowMs - prev.spokenAt
  const mayTalk = sinceMs >= cfg.guideSpeechCooldownMs && input.speaking !== true
  const changed = instruction !== prev.instruction
  const repeat = !changed && instruction !== 'straight' && sinceMs >= cfg.guidanceRepeatMs

  if (mayTalk && (changed || repeat)) {
    return {
      state: { direction, instruction, spokenAt: input.nowMs, band: told },
      say: GUIDANCE_PHRASES[instruction],
    }
  }
  if (mayTalk && nearer) {
    return {
      state: { direction, instruction: prev.instruction, spokenAt: input.nowMs, band },
      say: bandPhrase(input.label, band as DistanceBand),
    }
  }
  return { state: { ...prev, direction, band: told }, say: null }
}

