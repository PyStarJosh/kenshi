// Debug-only text for a located box: direction, distance, method, height, and path.
// Spoken phrases are built separately, in alerts/phrases.ts, once the alert steps exist.
import type { ClockPosition, Track } from '../../core/types'
import { roundDistance } from '../../geometry/geometry'
import type { GeometryResult } from '../../geometry/geometry'

export function clockText(position: ClockPosition): string {
  if (position === 'far-left') return 'far left'
  if (position === 'far-right') return 'far right'
  return `${position} o'clock`
}

const METHOD: Record<NonNullable<GeometryResult['distanceSource']>, string> = {
  'ground-plane': 'ground',
  'box-size': 'box',
  'min-visible': 'at most',
}

type Located = Pick<GeometryResult, 'clock' | 'distanceRoundedM' | 'distanceSource' | 'elevation' | 'inPath'>

export function geometryLabel(g: Located): string {
  const distance =
    g.distanceRoundedM !== null && g.distanceSource !== null
      ? `${g.distanceRoundedM.toFixed(1)} m ${METHOD[g.distanceSource]}`
      : 'distance ?'
  const parts = [clockText(g.clock.position), distance]
  if (g.elevation === 'floor') parts.push('floor')
  if (g.elevation === 'head') parts.push('head height')
  if (g.inPath) parts.push('IN PATH')
  return parts.join(' | ')
}

/** Debug text for a track: the same fields from its smoothed geometry. */
export function trackGeometryLabel(t: Track): string {
  return geometryLabel({ ...t, distanceRoundedM: roundDistance(t.distanceM) })
}

/** Debug text for a track's identity and motion: id, confirmed state, closing speed, and time to contact. */
export function trackMotionLabel(t: Track): string {
  const parts = [`#${t.id} ${t.status === 'confirmed' ? 'confirmed' : 'tentative'}`]
  parts.push(t.timeToContactS === null ? 'ttc -' : `ttc ${t.timeToContactS.toFixed(1)} s`)
  if (t.approaching) parts.push('APPROACHING')
  return parts.join(' | ')
}
