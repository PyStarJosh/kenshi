// Debug-only text for a located box: direction, distance, method, height, and path.
// Spoken phrases are built separately, in alerts/phrases.ts, once the alert steps exist.
import type { ClockPosition } from '../../core/types'
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

export function geometryLabel(g: GeometryResult): string {
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
