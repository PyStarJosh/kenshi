// Tracker: follows detections across frames so each real object has one stable id, is confirmed
// once, is smoothed, and is flagged when it is closing in. Pure: no DOM, times come from the frames.
import { CONFIG } from '../core/config'
import type { BoundingBox, ClassInfo, DistanceSource, FrameResult, Settings, Track } from '../core/types'
import { locateDetection } from '../geometry/geometry'
import type { FrameDims, GeometryConfig, GeometryResult, Tilt } from '../geometry/geometry'
import { alphaFor, ema, smoothBox } from './smoothing'
import { assessApproach, closingSpeed, heightGrowthRate, timeToContact } from './timeToContact'
import type { MotionSample, TrackingConfig } from './timeToContact'

/** Geometry for a box; injectable so tests can drive the tracker with exact distances. */
export type Locator = (
  box: BoundingBox,
  classId: number,
  frame: FrameDims,
  tilt: Tilt | null,
  settings: Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>,
) => GeometryResult

interface TrackState {
  id: number
  classId: number
  label: string
  status: Track['status']
  box: BoundingBox
  confidence: number
  hitWindow: boolean[]
  consecutiveMisses: number
  firstSeenMs: number
  lastSeenMs: number
  geometry: GeometryResult
  angleDeg: number
  distanceM: number | null
  distanceSource: DistanceSource | null
  samples: MotionSample[]
  closingSpeedMps: number | null
  heightGrowthPerS: number | null
  timeToContactS: number | null
  approachSinceMs: number | null
  approaching: boolean
}

function iou(a: BoundingBox, b: BoundingBox): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  return inter / (a.width * a.height + b.width * b.height - inter)
}

function centerDistance(a: BoundingBox, b: BoundingBox): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2))
}

const longSide = (b: BoundingBox) => Math.max(b.width, b.height)

export class Tracker {
  private tracks: TrackState[] = []
  private nextId = 1

  private locate: Locator
  private cfg: TrackingConfig
  private geometryCfg: GeometryConfig

  constructor(
    classes: readonly ClassInfo[],
    locate?: Locator,
    cfg: TrackingConfig = CONFIG.tracking,
    geometryCfg: GeometryConfig = CONFIG.geometry,
  ) {
    this.locate =
      locate ??
      ((box, classId, frame, tilt, settings) =>
        locateDetection({ classId, label: '', confidence: 0, box }, classes, frame, tilt, settings))
    this.cfg = cfg
    this.geometryCfg = geometryCfg
  }

  /** Feed one frame of detections; returns every live track (confirmed and tentative). */
  update(result: FrameResult, tilt: Tilt | null, settings: Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>): Track[] {
    const nowMs = result.captureTimeMs
    const frame = { width: result.frameWidth, height: result.frameHeight }
    const { detections } = result
    const matches = this.match(detections.map((d) => ({ classId: d.classId, box: d.box })))

    const matchedDetections = new Set<number>()
    for (const [trackIndex, detectionIndex] of matches) {
      matchedDetections.add(detectionIndex)
      const d = detections[detectionIndex]
      this.applyMatch(this.tracks[trackIndex], d.box, d.confidence, nowMs, frame, tilt, settings)
    }
    const matchedTracks = new Set(matches.keys())
    this.tracks.forEach((t, i) => {
      if (matchedTracks.has(i)) return
      t.consecutiveMisses += 1
      t.hitWindow = [...t.hitWindow, false].slice(-this.cfg.confirmationWindow)
      // An object that was not seen this frame is not known to be closing in.
      t.approaching = false
      t.approachSinceMs = null
      t.timeToContactS = null
      t.closingSpeedMps = null
      t.heightGrowthPerS = null
    })

    detections.forEach((d, i) => {
      if (matchedDetections.has(i)) return
      this.tracks.push(this.createTrack(d.classId, d.label, d.box, d.confidence, nowMs, frame, tilt, settings))
    })

    this.tracks = this.tracks.filter((t) =>
      t.status === 'confirmed'
        ? nowMs - t.lastSeenMs <= this.cfg.lostAfterMs
        : t.consecutiveMisses < this.cfg.tentativeMaxMisses,
    )
    return this.tracks.map((t) => this.toTrack(t))
  }

  reset(): void {
    this.tracks = []
  }

  /** Greedy matching: by IoU first, then by center distance for small boxes. Returns trackIndex -> detectionIndex. */
  private match(detections: { classId: number; box: BoundingBox }[]): Map<number, number> {
    const matches = new Map<number, number>()
    const usedDetections = new Set<number>()

    const byIou: { t: number; d: number; score: number }[] = []
    this.tracks.forEach((track, t) =>
      detections.forEach((det, d) => {
        if (det.classId !== track.classId) return
        const score = iou(track.box, det.box)
        if (score >= this.cfg.matchIou) byIou.push({ t, d, score })
      }),
    )
    byIou.sort((a, b) => b.score - a.score)
    for (const { t, d } of byIou) {
      if (matches.has(t) || usedDetections.has(d)) continue
      matches.set(t, d)
      usedDetections.add(d)
    }

    const byDistance: { t: number; d: number; score: number }[] = []
    this.tracks.forEach((track, t) => {
      if (matches.has(t) || longSide(track.box) >= this.cfg.smallBoxMaxSide) return
      detections.forEach((det, d) => {
        if (usedDetections.has(d) || det.classId !== track.classId || longSide(det.box) >= this.cfg.smallBoxMaxSide) return
        const distance = centerDistance(track.box, det.box)
        if (distance <= this.cfg.smallBoxCenterFactor * Math.max(longSide(track.box), longSide(det.box))) {
          byDistance.push({ t, d, score: distance })
        }
      })
    })
    byDistance.sort((a, b) => a.score - b.score)
    for (const { t, d } of byDistance) {
      if (matches.has(t) || usedDetections.has(d)) continue
      matches.set(t, d)
      usedDetections.add(d)
    }
    return matches
  }

  private createTrack(
    classId: number,
    label: string,
    box: BoundingBox,
    confidence: number,
    nowMs: number,
    frame: FrameDims,
    tilt: Tilt | null,
    settings: Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>,
  ): TrackState {
    const geometry = this.locate(box, classId, frame, tilt, settings)
    const track: TrackState = {
      id: this.nextId++,
      classId,
      label,
      status: 'tentative',
      box,
      confidence,
      hitWindow: [true],
      consecutiveMisses: 0,
      firstSeenMs: nowMs,
      lastSeenMs: nowMs,
      geometry,
      angleDeg: geometry.clock.angleDeg,
      distanceM: geometry.distanceM,
      distanceSource: geometry.distanceSource,
      samples: [],
      closingSpeedMps: null,
      heightGrowthPerS: null,
      timeToContactS: null,
      approachSinceMs: null,
      approaching: false,
    }
    this.pushSample(track, nowMs)
    this.confirmIfReady(track)
    return track
  }

  private applyMatch(
    t: TrackState,
    box: BoundingBox,
    confidence: number,
    nowMs: number,
    frame: FrameDims,
    tilt: Tilt | null,
    settings: Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>,
  ): void {
    const dtMs = nowMs - t.lastSeenMs
    const factor = (alpha: number) => alphaFor(alpha, dtMs, this.cfg.smoothingRefMs)
    t.box = smoothBox(t.box, box, factor(this.cfg.boxSmoothing))
    t.confidence = ema(t.confidence, confidence, factor(this.cfg.boxSmoothing))
    t.geometry = this.locate(t.box, t.classId, frame, tilt, settings)
    t.angleDeg = ema(t.angleDeg, t.geometry.clock.angleDeg, factor(this.cfg.angleSmoothing))
    if (t.geometry.distanceM !== null) {
      if (t.distanceSource !== null && t.geometry.distanceSource !== t.distanceSource) {
        // A different method gives a different number for the same object. Restart the distance
        // history so the jump is not read as movement; the height growth covers until it refills.
        t.distanceM = t.geometry.distanceM
        for (const sample of t.samples) sample.distanceM = null
      } else {
        t.distanceM =
          t.distanceM === null ? t.geometry.distanceM : ema(t.distanceM, t.geometry.distanceM, factor(this.cfg.distanceSmoothing))
      }
      t.distanceSource = t.geometry.distanceSource
    }
    t.lastSeenMs = nowMs
    t.consecutiveMisses = 0
    t.hitWindow = [...t.hitWindow, true].slice(-this.cfg.confirmationWindow)
    this.pushSample(t, nowMs)
    this.confirmIfReady(t)
    this.updateMotion(t, nowMs, dtMs)
  }

  private pushSample(t: TrackState, nowMs: number): void {
    t.samples.push({ timeMs: nowMs, distanceM: t.geometry.distanceM === null ? null : t.distanceM, height: t.box.height })
    const from = nowMs - this.cfg.closingSpeedWindowMs
    while (t.samples.length > 0 && t.samples[0].timeMs < from) t.samples.shift()
  }

  private confirmIfReady(t: TrackState): void {
    if (t.status === 'confirmed') return
    const hits = t.hitWindow.filter(Boolean).length
    const nearAndSure =
      t.distanceM !== null &&
      t.distanceM <= this.cfg.nearConfirmDistanceM &&
      t.confidence >= this.cfg.nearConfirmConfidence
    if (hits >= this.cfg.confirmationHits || nearAndSure) t.status = 'confirmed'
  }

  private updateMotion(t: TrackState, nowMs: number, dtMs: number): void {
    const factor = alphaFor(this.cfg.closingSpeedSmoothing, dtMs, this.cfg.smoothingRefMs)
    const speed = closingSpeed(t.samples, this.cfg)
    const growth = heightGrowthRate(t.samples, this.cfg)
    // Too little recent history clears the estimate instead of keeping an old one.
    t.closingSpeedMps = speed === null ? null : t.closingSpeedMps === null ? speed : ema(t.closingSpeedMps, speed, factor)
    t.heightGrowthPerS = growth === null ? null : t.heightGrowthPerS === null ? growth : ema(t.heightGrowthPerS, growth, factor)

    // Distance mode needs a current distance and a closing speed; otherwise the height growth decides.
    const distanceMode = t.geometry.distanceM !== null && t.closingSpeedMps !== null
    t.timeToContactS = timeToContact(
      distanceMode ? t.distanceM : null,
      distanceMode ? t.closingSpeedMps : null,
      t.heightGrowthPerS,
    )
    // An object far off to the side is not coming at the user. Unknown offset counts as inside.
    const offset = t.geometry.lateralOffsetM
    const withinCorridor = offset === null || Math.abs(offset) <= this.geometryCfg.approachHalfWidthM
    const approach = assessApproach(t.approachSinceMs, t.timeToContactS, withinCorridor, nowMs, this.cfg)
    t.approachSinceMs = approach.sinceMs
    t.approaching = approach.approaching
  }

  private toTrack(t: TrackState): Track {
    const g = t.geometry
    return {
      id: t.id,
      classId: t.classId,
      label: t.label,
      status: t.status,
      box: t.box,
      confidence: t.confidence,
      recentHits: t.hitWindow.filter(Boolean).length,
      firstSeenMs: t.firstSeenMs,
      lastSeenMs: t.lastSeenMs,
      clock: { position: g.clock.position, angleDeg: t.angleDeg },
      // With no distance ever, report the farthest valid one so nothing treats it as close.
      distanceM: t.distanceM ?? this.geometryCfg.maxValidDistanceM,
      distanceSource: t.distanceSource ?? 'box-size',
      distanceGroundM: g.distanceGroundM,
      distanceBoxM: g.distanceBoxM,
      elevation: g.elevation,
      inPath: g.inPath,
      approaching: t.approaching,
      closingSpeedMps: t.geometry.distanceM !== null ? t.closingSpeedMps : null,
      timeToContactS: t.timeToContactS,
    }
  }
}
