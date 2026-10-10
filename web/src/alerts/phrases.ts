// Everything the alert policy says about objects, in one place (pure; no DOM).
// Fixed order: object, clock, distance, elevation. Example: "Backpack, 1 o'clock, about 2 meters, on the floor."
// These sentences never say the path is clear, safe, or free (SR-2).
import { CONFIG } from '../core/config'
import type { ClockPosition, Elevation } from '../core/types'
import { roundDistance } from '../geometry/geometry'

/** What "what's around me" says when nothing is detected: a limit, never an all-clear (SR-2). */
export const SUMMARY_NONE = "I don't detect anything right now. I can miss things, so keep using your cane."

export interface PhraseInput {
  /** The class's spoken name, for example "backpack". */
  spokenName: string
  clock: ClockPosition
  /** Distance ahead in meters, or null when unknown (the distance is then left out). */
  distanceM: number | null
  elevation: Elevation
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function clockPhrase(position: ClockPosition): string {
  if (position === 'far-left') return 'far left'
  if (position === 'far-right') return 'far right'
  return `${position} o'clock`
}

/** "about 2 meters", "about 1.5 meters", "about 1 meter"; null when the distance is unknown. */
export function distancePhrase(distanceM: number | null): string | null {
  if (distanceM === null || !Number.isFinite(distanceM)) return null
  const meters = roundDistance(distanceM, CONFIG.alerts.roundToM)
  const number = Number.isInteger(meters) ? String(meters) : meters.toFixed(1)
  return `about ${number} ${meters === 1 ? 'meter' : 'meters'}`
}

/** The height suffix; most objects have none. */
export function elevationPhrase(elevation: Elevation): string | null {
  if (elevation === 'floor') return 'on the floor'
  if (elevation === 'head') return 'at head height'
  return null
}

/** One object as a short sentence. */
export function obstaclePhrase(input: PhraseInput): string {
  const parts = [capitalize(input.spokenName), clockPhrase(input.clock)]
  const distance = distancePhrase(input.distanceM)
  if (distance) parts.push(distance)
  const elevation = elevationPhrase(input.elevation)
  if (elevation) parts.push(elevation)
  return `${parts.join(', ')}.`
}

/** The answer to "what's around me": the objects in the order given, or the none-detected sentence. */
export function summaryPhrase(items: readonly PhraseInput[]): string {
  return items.length === 0 ? SUMMARY_NONE : items.map(obstaclePhrase).join(' ')
}
