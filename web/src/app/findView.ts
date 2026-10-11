// The Find screen's view model (R6, FR-27): what to show for a Find snapshot, as plain data. Pure, so the rules (which
// screen, how the arrow turns, when the background goes green, how the distance reads) are tested without a browser.
// The numbers shown are the ones the rest of the app already uses; a distance that is only an upper bound is shown as
// such ("< 2.5 m") and never as if it were measured.
import { CONFIG } from '../core/config'
import type { FindSnapshot, FindStateName } from '../core/types'
import { stableDirection } from '../find/phrases'
import type { Direction } from '../find/phrases'
import { wrap180 } from '../sensors/heading'

export type FindScreenKind = 'home' | 'looking' | 'sweeping' | 'found' | 'guiding' | 'arrived' | 'notFound' | 'error'

export interface FindView {
  kind: FindScreenKind
  /** The big heading: the target's name, or "Find" on the home screen. */
  title: string
  /** The line under the picture: what is happening ("Turn slowly", "Within reach"). */
  headline: string
  /** Arrow rotation in degrees, unwrapped (it can pass 180 and keep turning the short way); null when there is no arrow. */
  rotationDeg: number | null
  /** The arrow is shown but its direction is not known (no heading): drawn dimmed. */
  arrowKnown: boolean
  /** Facing the target (inside 15 degrees, held to 20 once there): the whole background turns green. */
  aligned: boolean
  /** "6 m", "< 2.5 m" (an upper bound), or "--" (unknown); empty when no distance belongs on this screen. */
  distanceText: string
  /** The same distance worded for a screen reader ("6 meters"); empty when distanceText is. */
  distanceLabel: string
  /** "ahead", "to your right", "behind you"; empty when there is no bearing. */
  directionText: string
  /** The sweep ring: how many of its segments are filled; null outside a sweep. */
  ring: { filled: number; total: number } | null
  /** A check mark: found, or within reach. */
  check: boolean
  /** The Stop button belongs on every screen except the home screen. */
  showStop: boolean
  /** One sentence per state for the aria-live region. It names the state and never the changing bearing. */
  liveText: string
}

/** What the view remembers between snapshots: the arrow's angle, whether it was aligned, and the direction word. */
export interface ViewMemory {
  rotationDeg: number
  aligned: boolean
  direction: Direction | null
}

export const initialViewMemory = (): ViewMemory => ({ rotationDeg: 0, aligned: false, direction: null })

/**
 * The arrow's rotation for a bearing, as the angle equivalent to it that is nearest to where the arrow already is. Going
 * from 170 to -170 degrees is a turn of 20 degrees, not a spin of 340, so the arrow never goes the long way round. A
 * missing bearing leaves the arrow where it was.
 */
export function bearingRotation(bearingDeg: number | null, previousDeg: number): number {
  if (bearingDeg === null || !Number.isFinite(bearingDeg)) return previousDeg
  return previousDeg + wrap180(bearingDeg - previousDeg)
}

/** Inside alignedEnterDeg of straight ahead, and once aligned it stays so until the bearing passes alignedExitDeg. */
export function isAligned(bearingDeg: number | null, wasAligned: boolean, cfg = CONFIG.find): boolean {
  if (bearingDeg === null || !Number.isFinite(bearingDeg)) return false
  const size = Math.abs(bearingDeg)
  if (size < cfg.alignedEnterDeg) return true
  return wasAligned && size <= cfg.alignedExitDeg
}

const meters = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

/** "6 m", "2.5 m", "< 2.5 m" when the distance is only an upper bound, "--" when unknown. */
export function distanceText(distanceM: number | null, isBound: boolean): string {
  if (distanceM === null || !Number.isFinite(distanceM) || distanceM < 0) return '--'
  return isBound ? `< ${meters(distanceM)} m` : `${meters(distanceM)} m`
}

/** The same, for a screen reader: "6 meters", "under 2.5 meters", "distance unknown". */
export function distanceSpeech(distanceM: number | null, isBound: boolean): string {
  if (distanceM === null || !Number.isFinite(distanceM) || distanceM < 0) return 'distance unknown'
  const value = meters(distanceM)
  const unit = distanceM === 1 ? 'meter' : 'meters'
  return isBound ? `under ${value} ${unit}` : `${value} ${unit}`
}

const DIRECTION_TEXT: Record<Direction, string> = {
  ahead: 'ahead',
  'slightly-left': 'slightly to your left',
  'slightly-right': 'slightly to your right',
  left: 'to your left',
  right: 'to your right',
  behind: 'behind you',
}

export function directionText(direction: Direction): string {
  return DIRECTION_TEXT[direction]
}

/** The segments of the sweep ring: each takes its share of the circle with a small gap, and is filled in order. */
export function ringArcs(total: number, filled: number, gapDeg = 6): { startDeg: number; endDeg: number; filled: boolean }[] {
  const step = 360 / total
  return Array.from({ length: total }, (_, i) => ({
    startDeg: i * step + gapDeg / 2,
    endDeg: (i + 1) * step - gapDeg / 2,
    filled: i < filled,
  }))
}

/** True when the search has just found the target (a short "Found" screen goes up before the guiding view). */
export function justFound(previous: FindStateName, next: FindStateName): boolean {
  return next === 'guiding' && (previous === 'idle' || previous === 'checking' || previous === 'sweeping' || previous === 'sweepChecking' || previous === 'lost')
}

const capitalize = (text: string) => (text.length === 0 ? text : text[0].toUpperCase() + text.slice(1))

/**
 * What to show. `found` says the "Found" screen is up (a short moment after the target was found); `memory` is what the
 * view remembered from the last snapshot, and the next memory comes back with the view.
 */
export function makeView(
  snapshot: FindSnapshot,
  found: boolean,
  memory: ViewMemory,
  cfg = CONFIG.find,
): { view: FindView; memory: ViewMemory } {
  const target = snapshot.target ?? ''
  const name = capitalize(target)
  const blank: FindView = {
    kind: 'home',
    title: 'Find',
    headline: '',
    rotationDeg: null,
    arrowKnown: false,
    aligned: false,
    distanceText: '',
    distanceLabel: '',
    directionText: '',
    ring: null,
    check: false,
    showStop: true,
    liveText: '',
  }
  const forget = { rotationDeg: 0, aligned: false, direction: null as Direction | null }

  switch (snapshot.state) {
    case 'idle':
      return { view: { ...blank, showStop: false }, memory: forget }
    case 'checking':
      return {
        view: { ...blank, kind: 'looking', title: name, headline: 'Looking...', liveText: `Looking for ${target}.` },
        memory: forget,
      }
    case 'lost':
      return {
        view: { ...blank, kind: 'looking', title: name, headline: 'Lost it. Scanning...', liveText: `Lost the ${target}. Scanning.` },
        memory: forget,
      }
    case 'sweeping':
    case 'sweepChecking': {
      const checking = snapshot.state === 'sweepChecking'
      const filled = checking ? cfg.maxFrames : Math.min(snapshot.sweepFrames, cfg.maxFrames)
      return {
        view: {
          ...blank,
          kind: 'sweeping',
          title: name,
          headline: checking ? 'Checking...' : 'Turn slowly',
          ring: { filled, total: cfg.maxFrames },
          liveText: checking ? `Checking the pictures for ${target}.` : `Turn slowly to your right to look for ${target}.`,
        },
        memory: forget,
      }
    }
    case 'notFound':
      return {
        view: { ...blank, kind: 'notFound', title: name, headline: `Couldn't find ${target} here`, liveText: `Could not find ${target} here.` },
        memory: forget,
      }
    case 'error':
      return {
        view: { ...blank, kind: 'error', title: name || 'Find', headline: "Find isn't available right now", liveText: "Find isn't available right now." },
        memory: forget,
      }
    case 'arrived':
      return {
        view: {
          ...blank,
          kind: 'arrived',
          title: name,
          headline: 'Within reach',
          aligned: true,
          check: true,
          liveText: `${name}: within reach.`,
        },
        memory: { rotationDeg: 0, aligned: true, direction: 'ahead' },
      }
    case 'guiding': {
      const bearing = snapshot.bearingDeg
      const aligned = isAligned(bearing, memory.aligned, cfg)
      const rotationDeg = bearingRotation(bearing, memory.rotationDeg)
      const direction = bearing === null ? memory.direction : stableDirection(memory.direction, bearing, cfg)
      const next: ViewMemory = { rotationDeg, aligned, direction }
      if (found) {
        return {
          view: { ...blank, kind: 'found', title: name, headline: `Found: ${name}`, check: true, aligned, liveText: `Found: ${name}.` },
          memory: next,
        }
      }
      return {
        view: {
          ...blank,
          kind: 'guiding',
          title: name,
          headline: bearing === null ? 'Which way you face is unknown' : '',
          rotationDeg,
          arrowKnown: bearing !== null,
          aligned,
          distanceText: distanceText(snapshot.distanceM, snapshot.distanceIsBound),
          distanceLabel: distanceSpeech(snapshot.distanceM, snapshot.distanceIsBound),
          directionText: direction === null ? '' : directionText(direction),
          liveText: `Guiding to ${target}.`,
        },
        memory: next,
      }
    }
  }
}

