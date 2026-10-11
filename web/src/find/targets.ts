// The things Find can look for: the quick-pick list (always works, even when speech recognition does not), the
// cleanup of a spoken target, and the link from a target name to a detector class so a thing the on-device
// detector already sees can skip the network (the YOLO shortcut). Pure.
import { CONFIG } from '../core/config'
import type { ClassInfo, Track } from '../core/types'
import { CLASSES } from '../detection/classes'
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

// The detector knows 80 everyday classes (COCO). A target that is one of their names, or its plural, already maps to
// it ("chair", "chairs", "traffic light", "bowl"). These are the other words people use for the same things, and a
// few names that stand for several classes at once (a bathroom has a toilet or a sink in it). Exit, door, elevator,
// stairs, a restroom sign and a trash can are not among the 80 classes, so they always go to Gemini.
export const DETECTOR_SYNONYMS: Record<string, readonly string[]> = {
  // People
  people: ['person'],
  human: ['person'],
  someone: ['person'],
  somebody: ['person'],
  man: ['person'],
  woman: ['person'],
  child: ['person'],
  kid: ['person'],
  pedestrian: ['person'],
  // Seats, tables, beds
  seat: ['chair'],
  'office chair': ['chair'],
  'dining chair': ['chair'],
  armchair: ['chair', 'couch'],
  sofa: ['couch'],
  settee: ['couch'],
  loveseat: ['couch'],
  table: ['dining table'],
  'dinner table': ['dining table'],
  'kitchen table': ['dining table'],
  'park bench': ['bench'],
  // Screens and gadgets
  television: ['tv'],
  telly: ['tv'],
  monitor: ['tv'],
  computer: ['laptop'],
  notebook: ['laptop'],
  phone: ['cell phone'],
  cellphone: ['cell phone'],
  smartphone: ['cell phone'],
  'mobile phone': ['cell phone'],
  mobile: ['cell phone'],
  'remote control': ['remote'],
  'tv remote': ['remote'],
  'computer mouse': ['mouse'],
  // Kitchen
  mug: ['cup'],
  'coffee cup': ['cup'],
  teacup: ['cup'],
  'water bottle': ['bottle'],
  fridge: ['refrigerator'],
  freezer: ['refrigerator'],
  stove: ['oven'],
  cooker: ['oven'],
  doughnut: ['donut'],
  // Bags
  rucksack: ['backpack'],
  purse: ['handbag'],
  bag: ['handbag', 'backpack', 'suitcase'],
  luggage: ['suitcase'],
  // Vehicles and street
  bike: ['bicycle'],
  cycle: ['bicycle'],
  motorbike: ['motorcycle'],
  plane: ['airplane'],
  aeroplane: ['airplane'],
  aircraft: ['airplane'],
  lorry: ['truck'],
  hydrant: ['fire hydrant'],
  'traffic signal': ['traffic light'],
  stoplight: ['traffic light'],
  'stop light': ['traffic light'],
  // Home
  plant: ['potted plant'],
  houseplant: ['potted plant'],
  'house plant': ['potted plant'],
  basin: ['sink'],
  washbasin: ['sink'],
  'hair dryer': ['hair drier'],
  hairdryer: ['hair drier'],
  'blow dryer': ['hair drier'],
  teddy: ['teddy bear'],
  brolly: ['umbrella'],
  // A bathroom is found by the fixtures in it
  bathroom: ['toilet', 'sink'],
  restroom: ['toilet', 'sink'],
  washroom: ['toilet', 'sink'],
  lavatory: ['toilet', 'sink'],
  loo: ['toilet', 'sink'],
  // Sport
  ball: ['sports ball'],
  football: ['sports ball'],
  'soccer ball': ['sports ball'],
  basketball: ['sports ball'],
  volleyball: ['sports ball'],
  racket: ['tennis racket'],
  racquet: ['tennis racket'],
  bat: ['baseball bat'],
  // Animals
  puppy: ['dog'],
  kitten: ['cat'],
}

/** The name and its plausible singulars: "chairs" gives "chair", "buses" gives "bus", "berries" gives "berry". */
function candidates(name: string): string[] {
  const out = [name]
  if (name.endsWith('ies')) out.push(`${name.slice(0, -3)}y`)
  if (name.endsWith('es') && name.length > 4) out.push(name.slice(0, -2))
  if (name.endsWith('s') && !name.endsWith('ss') && name.length > 3) out.push(name.slice(0, -1))
  return out
}

/**
 * The detector class labels a target name stands for, or none when the detector does not know the thing. A class's
 * own label or spoken name (or its plural) always counts; DETECTOR_SYNONYMS adds everyday words. Whole names only, so
 * "orange chair" never turns into the fruit.
 */
export function detectorLabelsFor(target: string, classes: readonly ClassInfo[] = CLASSES): string[] {
  const name = cleanTarget(target)
  if (name === '') return []
  const names = candidates(name)
  // hasOwn: a spoken "constructor" must not find a property of Object itself.
  const key = names.find((n) => Object.hasOwn(DETECTOR_SYNONYMS, n))
  if (key !== undefined) return [...DETECTOR_SYNONYMS[key]]
  const hit = classes.find((c) => names.includes(c.label) || names.includes(c.spokenName))
  return hit ? [hit.label] : []
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
  const labels = detectorLabelsFor(target)
  if (labels.length === 0) return null
  const matches = tracks.filter((t) => labels.includes(t.label) && t.status === 'confirmed')
  if (matches.length === 0) return null
  matches.sort((a, b) => a.distanceM - b.distanceM || b.confidence - a.confidence)
  const best = matches[0]
  return { angleDeg: best.clock.angleDeg, distanceM: best.distanceM }
}
