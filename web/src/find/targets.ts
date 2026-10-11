// The things Find can look for: the quick-pick list (always works, even when speech recognition does not), the
// cleanup of a spoken target, and the link from a target name to a detector class so a thing the on-device
// detector already sees can skip the network (the YOLO shortcut). Pure.
import { CONFIG } from '../core/config'
import type { ClassInfo, Track } from '../core/types'
import type { YoloSighting } from './findController'

/** The quick-pick buttons, in order. */
export const QUICK_PICKS = ['Exit', 'Door', 'Elevator', 'Stairs', 'Restroom sign', 'Chair', 'Trash can', 'Person'] as const

/** "find my keys" and "the Keys." both become "keys". Empty text gives ''. */
export function cleanTarget(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an|my|some|any)(?:\s+|$)/, '')
    .replace(/\s+(?:please|now|for me)$/, '')
    .trim()
  return cleaned.slice(0, CONFIG.find.maxTargetChars)
}

// What people say for things the detector knows (a COCO class label on the right). Anything else goes to Gemini.
const DETECTOR_NAMES: Record<string, string> = {
  person: 'person',
  people: 'person',
  someone: 'person',
  chair: 'chair',
  chairs: 'chair',
  seat: 'chair',
  couch: 'couch',
  sofa: 'couch',
  bench: 'bench',
  table: 'dining table',
  'dining table': 'dining table',
  bed: 'bed',
  toilet: 'toilet',
  sink: 'sink',
  tv: 'tv',
  television: 'tv',
  laptop: 'laptop',
  phone: 'cell phone',
  'cell phone': 'cell phone',
  bottle: 'bottle',
  cup: 'cup',
  backpack: 'backpack',
  suitcase: 'suitcase',
  umbrella: 'umbrella',
  bicycle: 'bicycle',
  bike: 'bicycle',
  car: 'car',
  bus: 'bus',
  dog: 'dog',
  cat: 'cat',
  plant: 'potted plant',
  fridge: 'refrigerator',
  refrigerator: 'refrigerator',
  clock: 'clock',
  book: 'book',
}

/** The detector class label for a target name, or null when the detector does not know the thing. */
export function detectorLabelFor(target: string): string | null {
  return DETECTOR_NAMES[cleanTarget(target)] ?? null
}

/** True when a label is one of the detector's classes (a guard for the table above). */
export function isDetectorLabel(label: string, classes: readonly ClassInfo[]): boolean {
  return classes.some((c) => c.label === label)
}

/**
 * The best confirmed track of the target's class in view, as a bearing and distance, or null. Nearest first, then
 * the most confident. A target the detector does not know never matches.
 */
export function findYoloSighting(target: string, tracks: readonly Track[]): YoloSighting | null {
  const label = detectorLabelFor(target)
  if (label === null) return null
  const matches = tracks.filter((t) => t.label === label && t.status === 'confirmed')
  if (matches.length === 0) return null
  matches.sort((a, b) => a.distanceM - b.distanceM || b.confidence - a.confidence)
  const best = matches[0]
  return { angleDeg: best.clock.angleDeg, distanceM: best.distanceM }
}
