// The things Find can look for: the quick-pick list (always works, even when speech recognition does not), the
// cleanup of a spoken target, and the link from a target name to a detector class so a thing the on-device
// detector already sees can skip the network (the YOLO shortcut). Pure.
import { CONFIG } from '../core/config'
import type { ClassInfo, Track } from '../core/types'
import { CLASSES } from '../detection/classes'
import { wrap180 } from '../sensors/heading'
import type { YoloSighting } from './findController'

// Things a person should not walk into get "within reach" earlier (owner request): stairs first, then doors and the
// like (a restroom is found by its door or sign).
const STAIRS = /\b(stairs?|staircases?|stairways?|steps?|escalators?)\b/
const DOORWAY = /\b(doors?|doorways?|exits?|entrances?|elevators?|lifts?|gates?|restrooms?|bathrooms?|washrooms?)\b/

/**
 * How near the target must be to count as within reach: CONFIG.find.arrivalStairsM for stairs, arrivalDoorM for doors,
 * exits, elevators and restrooms, arrivalDistanceM for anything else. A box cut off at the bottom gives only an upper
 * bound, so it is judged against at least arrivalClippedM.
 */
export function arrivalDistanceFor(target: string, clipped: boolean, cfg = CONFIG.find): number {
  const base = STAIRS.test(target) ? cfg.arrivalStairsM : DOORWAY.test(target) ? cfg.arrivalDoorM : cfg.arrivalDistanceM
  return clipped ? Math.max(base, cfg.arrivalClippedM) : base
}

/** The quick-pick buttons, in order. */
export const QUICK_PICKS = ['Exit', 'Door', 'Elevator', 'Stairs', 'Restroom sign', 'Chair', 'Trash can', 'Person'] as const

// Restrooms go to Gemini, which reads their doors and signs (owner request), and a men's or women's one is asked for by
// one clear name however it was said: "mens room", "ladies bathroom", "female toilets", "the gents".
const RESTROOM_WORDS = /\b(rest ?rooms?|bath ?rooms?|wash ?rooms?|toilets?|lavatory|lavatories|loos?|wcs?)\b/
const WOMEN_WORDS = /\b(women|womens|woman|womans|female|females|ladies|lady|girls|girl)\b/
const MEN_WORDS = /\b(men|mens|man|mans|male|males|gents|gent|gentlemen|gentlemens|boys|boy)\b/

/** "men's restroom" or "women's restroom" for a name that asks for one, else null. */
export function genderedRestroom(name: string): "men's restroom" | "women's restroom" | null {
  const plain = name.replace(/'/g, '')
  // A restroom word, or just "<who> room" ("ladies room", "mens room"), or "gents" on its own.
  const asksForRestroom = RESTROOM_WORDS.test(plain) || /^\S+ rooms?$/.test(plain) || plain === 'gents'
  if (!asksForRestroom) return null
  if (WOMEN_WORDS.test(plain)) return "women's restroom"
  if (MEN_WORDS.test(plain)) return "men's restroom"
  return null
}

/** "find my keys" and "the Keys." both become "keys"; "the ladies room" becomes "women's restroom". Empty text gives ''. */
export function cleanTarget(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|a|an|my|some|any)(?:\s+|$)/, '')
    .replace(/\s+(?:please|now|for me)$/, '')
    .trim()
  return (genderedRestroom(cleaned) ?? cleaned).slice(0, CONFIG.find.maxTargetChars)
}

// The detector knows 80 everyday classes (COCO). A target that is one of their names, or its plural, already maps to
// it ("chair", "chairs", "traffic light", "bowl"). These are the other words people use for the same things, and a
// few names that stand for several classes at once. Exit, door, elevator, stairs, a restroom (and a restroom sign) and a
// trash can are not among the 80 classes, so they always go to Gemini; a toilet or a sink on its own is a class.
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
export function findYoloSighting(
  target: string,
  tracks: readonly Track[],
  preferTrackId: number | null = null,
  near: { angleDeg: number; maxDeg: number } | null = null,
): YoloSighting | null {
  const labels = detectorLabelsFor(target)
  if (labels.length === 0) return null
  const matches = tracks.filter((t) => labels.includes(t.label) && t.status === 'confirmed')
  if (matches.length === 0) return null
  matches.sort((a, b) => a.distanceM - b.distanceM || b.confidence - a.confidence)
  // Keep following the object already being followed, so two chairs in view do not swap places as their
  // estimated distances wobble.
  // If it is gone, only one where it was is taken for it (the same object under a new id), not another of the kind.
  const onSpot = near === null ? matches : matches.filter((t) => Math.abs(wrap180(t.clock.angleDeg - near.angleDeg)) <= near.maxDeg)
  if (near !== null) onSpot.sort((a, b) => Math.abs(wrap180(a.clock.angleDeg - near.angleDeg)) - Math.abs(wrap180(b.clock.angleDeg - near.angleDeg)))
  const best = matches.find((t) => t.id === preferTrackId) ?? onSpot[0]
  if (best === undefined) return null
  return {
    angleDeg: best.clock.angleDeg,
    distanceM: best.distanceM,
    trackId: best.id,
    clipped: best.box.y + best.box.height >= 1 - CONFIG.geometry.edgeTouchMargin,
  }
}
