// What Find says (SDS section 9 and 13). Pure functions and fixed sentences, so the SR-2 wording test can read them all.
// Results are hints: "not found" is a limit of the search, never a statement about the room (SR-11), and nothing here
// says the way is clear or safe (SR-2).
import { CONFIG } from '../core/config'

export type Direction = 'ahead' | 'slightly-left' | 'slightly-right' | 'left' | 'right' | 'behind'

/** How far the target is, in three levels (owner request): the app says and shows these, never meters. */
export type DepthLevel = 'far' | 'close' | 'reach'

export const FIND_PHRASES = {
  privacy: 'Find sends camera photos to Google Gemini to locate things.',
  notInView: 'Not in view. Turn slowly to your right.',
  keepTurning: 'Keep turning slowly to your right.',
  stillSearching: 'Still searching.',
  checking: 'Checking.',
  stopped: 'Find stopped.',
  unavailable: "Find isn't available right now.",
  noHeading: "I can't tell which way you turn, so I can only search what the camera sees.",
  tiltDown: 'Tilt the phone down to keep it in view.',
} as const

/** The first letter in capitals; the rest as given. */
export function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

/** "a chair", "an exit". */
export function withArticle(name: string): string {
  return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`
}

/** Which way to turn, from the signed bearing in degrees (positive is right). */
export function classifyDirection(bearingDeg: number, cfg = CONFIG.find): Direction {
  const size = Math.abs(bearingDeg)
  if (size <= cfg.directionAheadDeg) return 'ahead'
  if (size > cfg.directionBehindDeg) return 'behind'
  const right = bearingDeg > 0
  if (size <= cfg.directionSlightDeg) return right ? 'slightly-right' : 'slightly-left'
  return right ? 'right' : 'left'
}

const RANK: Record<Direction, number> = {
  ahead: 0,
  'slightly-left': 1,
  'slightly-right': 1,
  left: 2,
  right: 2,
  behind: 3,
}

/**
 * The direction word to use now, given the one last spoken. It changes only when the bearing is past the boundary by
 * the hysteresis margin, so a bearing that wobbles around 15 or 45 degrees does not make the app flip between words.
 */
export function stableDirection(previous: Direction | null, bearingDeg: number, cfg = CONFIG.find): Direction {
  const raw = classifyDirection(bearingDeg, cfg)
  if (previous === null || raw === previous || RANK[raw] === RANK[previous]) return raw
  const sign = bearingDeg < 0 ? -1 : 1
  const margin = cfg.directionHysteresisDeg
  // Moving outward needs to be past the boundary by the margin; moving inward needs to be that far back inside it.
  const test = RANK[raw] > RANK[previous] ? Math.abs(bearingDeg) - margin : Math.abs(bearingDeg) + margin
  const confirmed = classifyDirection(sign * Math.max(0, test), cfg)
  return RANK[raw] > RANK[previous] ? (RANK[confirmed] >= RANK[raw] ? raw : previous) : RANK[confirmed] <= RANK[raw] ? raw : previous
}

const SPOKEN_DIRECTION: Record<Direction, string> = {
  ahead: 'ahead',
  'slightly-left': 'slightly left',
  'slightly-right': 'slightly right',
  left: 'to your left',
  right: 'to your right',
  behind: 'behind you',
}

export function directionWords(direction: Direction): string {
  return SPOKEN_DIRECTION[direction]
}

/**
 * The level for a distance: within reach inside the arrival distance (a larger one when the distance is only an upper
 * bound, as for a box cut off at the bottom), close within levelCloseM, far beyond. An upper bound can say how near the
 * target is at most, never that it is far, so past levelCloseM it is unknown (null).
 */
export function depthLevel(distanceM: number | null, isBound: boolean, cfg = CONFIG.find): DepthLevel | null {
  if (distanceM === null || !Number.isFinite(distanceM) || distanceM < 0) return null
  if (distanceM <= (isBound ? cfg.arrivalClippedM : cfg.arrivalDistanceM)) return 'reach'
  if (distanceM <= cfg.levelCloseM) return 'close'
  return isBound ? null : 'far'
}

/** "Chair is far.", "Stairs are close." (a name ending in a plain s is taken as plural). */
export function levelPhrase(target: string, level: 'far' | 'close'): string {
  const plural = /^(people|children|men|women)$/.test(target) || /[^su']s$/.test(target)
  return `${capitalize(target)} ${plural ? 'are' : 'is'} ${level}.`
}

export const lookingFor = (target: string) => `Looking for ${withArticle(target)}.`
export const foundPhrase = (target: string, direction: Direction) => `${capitalize(target)} found, ${directionWords(direction)}.`
export const directionPhrase = (direction: Direction) => `${capitalize(directionWords(direction))}.`
export const lostPhrase = (target: string) => `Lost the ${target}. Scanning.`
export const arrivedPhrase = (target: string) => `${capitalize(target)} ahead, within reach.`

/**
 * What a sign says, for example "EXIT ->" becomes "A sign says exit, to the right." The arrow is read from the text
 * (-> or an arrow character for right, <- for left, an up arrow for ahead); with no arrow the direction is left out.
 */
export function signPhrase(hint: string): string {
  const text = hint
    .replace(/[<>←-↓⇐-⇓⟵⟶=-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  const right = /(->|=>|→|⇒|⟶)/.test(hint)
  const left = /(<-|<=|←|⇐|⟵)/.test(hint)
  const up = /(↑|⇑)/.test(hint)
  const where = right ? ', to the right' : left ? ', to the left' : up ? ', ahead' : ''
  return text ? `A sign says ${text}${where}.` : ''
}

/** Nothing found after a search. A sign Gemini read may say where to go, so it follows. */
export function notFoundPhrase(target: string, signHint: string | null): string {
  const base = `I couldn't find ${withArticle(target)} here. Try another spot or ask for something else.`
  const sign = signHint ? signPhrase(signHint) : ''
  return sign ? `${base} ${sign}` : base
}
