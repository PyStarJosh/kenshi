// Walk-mode alert policy: turns confirmed tracks into a few well-timed AlertEvents. Pure: no DOM, no clock;
// the caller passes the current time. The audio engine still makes its own last-moment stale and track-gone
// checks (SR-3) and works out the tone's pulse rate from the track's live distance; this module decides
// what is worth saying, in what order, and when.
//
// Rules (docs/SDS.md section 7):
//  - Announce a confirmed track of an announced class that is in the walking path, or is approaching.
//  - urgent: in path and (at most urgentDistanceM away, or time-to-contact at most urgentTtcS).
//    normal: any other in-path track. info: approaching but outside the path.
//  - Each track is announced once. It is announced again only when it becomes urgent, enters the path, moves
//    into a closer distance band, or changes clock position, each after its own cooldown. Never on a timer.
//  - One alert in flight. Urgent preempts a non-urgent one; otherwise waiting alerts queue (a few at most) and
//    the most urgent, then the nearest, goes first.
import { CONFIG } from '../core/config'
import type { AlertEvent, AlertOutcome, AlertPriority, ClassInfo, ClockPosition, Track } from '../core/types'
import { obstaclePhrase, summaryPhrase } from './phrases'
import type { PhraseInput } from './phrases'

export type AlertsConfig = typeof CONFIG.alerts

/** Why an alert was dropped before it was spoken. */
export type DropReason = 'stale' | 'track-gone' | 'not-eligible' | 'superseded' | 'queue-full'

/** Why an alert was raised. */
export type AlertReason = 'first' | 'urgent' | 'entered-path' | 'closer' | 'clock'

export interface DropRecord {
  /** The alert that was dropped before it was spoken. */
  alert: AlertEvent
  trackId: number
  reason: DropReason
  timeMs: number
}

export interface EmittedAlert {
  alert: AlertEvent
  reason: AlertReason
}

export interface PolicyResult {
  /** Alerts to speak now: at most one per update. */
  emitted: EmittedAlert[]
  /** Alerts that were queued and then dropped during this update. */
  drops: DropRecord[]
}

const RANK: Record<AlertPriority, number> = { urgent: 3, normal: 2, info: 1 }

/** The priority a track deserves, or null if walk mode would not announce it. */
export function priorityFor(
  track: Track,
  cfg: AlertsConfig = CONFIG.alerts,
  corridorDepthM: number = CONFIG.geometry.corridorDepthM,
): AlertPriority | null {
  if (track.status !== 'confirmed') return null
  const ttc = track.timeToContactS
  if (track.inPath && track.distanceM <= corridorDepthM) {
    const close = track.distanceM <= cfg.urgentDistanceM
    const closing = ttc !== null && ttc <= cfg.urgentTtcS
    return close || closing ? 'urgent' : 'normal'
  }
  if (track.approaching && ttc !== null && ttc <= cfg.approachMaxTtcS) return 'info'
  return null
}

/** Stereo pan for the lead-in tone: -1 is full left, +1 full right, reaching full at panFullAngleDeg. */
export function panFor(angleDeg: number, fullAngleDeg: number = CONFIG.alerts.panFullAngleDeg): number {
  if (!Number.isFinite(angleDeg)) return 0
  return Math.max(-1, Math.min(1, angleDeg / fullAngleDeg))
}

/** Which distance band a distance falls in: 0 is the nearest band, bands.length is beyond the last. */
export function bandIndex(distanceM: number, bandsM: readonly number[]): number {
  const index = bandsM.findIndex((edge) => distanceM <= edge)
  return index === -1 ? bandsM.length : index
}

/** What was last announced (or queued) for a track; later changes are measured against it. */
interface Memory {
  priority: AlertPriority
  band: number
  inPath: boolean
  clock: ClockPosition
  atMs: number
  urgentAtMs: number
}

interface Candidate {
  alert: AlertEvent
  trackId: number
  priority: AlertPriority
  distanceM: number
  reason: AlertReason
  /** The memory to restore if this alert is dropped, so the track can be announced again. */
  revert: Memory | null
}

interface InFlight {
  id: string
  trackId: number
  urgent: boolean
  sentMs: number
  /** The memory to restore if this alert is dropped or cut off before it is heard. */
  revert: Memory | null
}

interface Raised {
  track: Track
  priority: AlertPriority
  reason: AlertReason
}

const DROP_LOG_LIMIT = 50

/** Better first: higher priority, then nearer. */
function compare(a: { priority: AlertPriority; distanceM: number }, b: { priority: AlertPriority; distanceM: number }): number {
  return RANK[b.priority] - RANK[a.priority] || a.distanceM - b.distanceM
}

export class AlertPolicy {
  private classes: readonly ClassInfo[]
  private cfg: AlertsConfig
  private corridorDepthM: number
  private memory = new Map<number, Memory>()
  private pending = new Map<number, Candidate>()
  private inFlight: InFlight | null = null
  private lastEndMs = -Infinity
  private counter = 0
  private dropLog: DropRecord[] = []

  constructor(
    classes: readonly ClassInfo[],
    cfg: AlertsConfig = CONFIG.alerts,
    corridorDepthM: number = CONFIG.geometry.corridorDepthM,
  ) {
    this.classes = classes
    this.cfg = cfg
    this.corridorDepthM = corridorDepthM
  }

  /**
   * Call once per frame with the current tracks. `frameTimeMs` is when that frame was captured (alert age is
   * measured from it); `nowMs` is the current time. At most one alert comes back to be spoken. A frame older
   * than the stale limit announces nothing and drops whatever is waiting.
   */
  update(tracks: readonly Track[], nowMs: number, frameTimeMs: number): PolicyResult {
    const drops: DropRecord[] = []
    const present = new Map(tracks.map((t) => [t.id, t]))

    for (const id of [...this.memory.keys()]) if (!present.has(id)) this.memory.delete(id)
    if (nowMs - frameTimeMs > this.cfg.staleLimitMs) {
      // Everything this frame says is already too old to speak: drop what is waiting and announce nothing from it.
      for (const candidate of [...this.pending.values()]) this.dropCandidate(candidate, 'stale', nowMs, drops, true)
      return { emitted: [], drops }
    }
    this.refreshPending(present, nowMs, frameTimeMs, drops)

    const raised: Raised[] = []
    for (const track of tracks) {
      if (!this.classes[track.classId]?.alertable) continue
      const priority = priorityFor(track, this.cfg, this.corridorDepthM)
      if (priority === null) continue
      const memory = this.memory.get(track.id)
      // Falling back below urgent makes a later return to urgent a new escalation.
      if (memory && priority !== 'urgent' && memory.priority === 'urgent') memory.priority = priority
      const reason = this.reasonToAnnounce(track, priority, memory, nowMs)
      if (reason) raised.push({ track, priority, reason })
    }
    raised.sort(
      (a, b) =>
        compare(
          { priority: a.priority, distanceM: a.track.distanceM },
          { priority: b.priority, distanceM: b.track.distanceM },
        ) || a.track.id - b.track.id,
    )
    for (const r of raised) this.admit(r, nowMs, frameTimeMs, drops)

    const emitted: EmittedAlert[] = []
    const next = this.release(nowMs)
    if (next) emitted.push({ alert: next.alert, reason: next.reason })
    return { emitted, drops }
  }

  /**
   * Tell the policy what happened to an alert it sent, so it knows when the next one may go. An alert that was
   * dropped by the audio engine or cut off before it finished was not heard, so its track may be announced again.
   */
  notifyOutcome(alertId: string, outcome: AlertOutcome, nowMs: number): void {
    const flight = this.inFlight
    if (!flight || flight.id !== alertId || outcome === 'started' || outcome === 'queued') return
    this.inFlight = null
    this.lastEndMs = nowMs
    if (outcome !== 'finished') this.restore(flight)
  }

  /** The answer to "what's around me": the nearest few confirmed objects, in clock order from left to right. */
  summarize(tracks: readonly Track[]): string {
    const nearest = tracks
      .filter((t) => t.status === 'confirmed' && this.classes[t.classId]?.alertable && t.distanceM <= this.cfg.summaryMaxDistanceM)
      .sort((a, b) => a.distanceM - b.distanceM || a.id - b.id)
      .slice(0, this.cfg.summaryMaxItems)
      .sort((a, b) => a.clock.angleDeg - b.clock.angleDeg || a.distanceM - b.distanceM)
    return summaryPhrase(nearest.map((t) => this.describe(t)))
  }

  /** Forget everything: after a pause or a restart the old tracks no longer exist. */
  reset(): void {
    this.memory.clear()
    this.pending.clear()
    this.inFlight = null
    this.lastEndMs = -Infinity
  }

  /** The most recent drops, oldest first, for telemetry and the debug overlay. */
  getDropLog(): readonly DropRecord[] {
    return this.dropLog
  }

  pendingCount(): number {
    return this.pending.size
  }

  private describe(track: Track): PhraseInput {
    return {
      spokenName: this.classes[track.classId]?.spokenName ?? track.label,
      clock: track.clock.position,
      distanceM: Number.isFinite(track.distanceM) ? track.distanceM : null,
      elevation: track.elevation,
    }
  }

  private reasonToAnnounce(track: Track, priority: AlertPriority, memory: Memory | undefined, nowMs: number): AlertReason | null {
    const cfg = this.cfg
    if (!memory) return 'first'
    if (priority === 'urgent' && memory.priority !== 'urgent' && nowMs - memory.urgentAtMs >= cfg.urgentCooldownMs) return 'urgent'
    const sinceMs = nowMs - memory.atMs
    if (track.inPath && !memory.inPath && sinceMs >= cfg.closerBandCooldownMs) return 'entered-path'
    if (bandIndex(track.distanceM, cfg.distanceBandsM) < memory.band && sinceMs >= cfg.closerBandCooldownMs) return 'closer'
    if (track.clock.position !== memory.clock && sinceMs >= cfg.clockChangeCooldownMs) return 'clock'
    return null
  }

  /**
   * A waiting alert follows its track: it is rewritten from the latest frame (so it never goes stale just
   * because speech was busy), and dropped if its track is gone or no longer worth announcing.
   */
  private refreshPending(present: Map<number, Track>, nowMs: number, frameTimeMs: number, drops: DropRecord[]): void {
    for (const candidate of [...this.pending.values()]) {
      const track = present.get(candidate.trackId)
      if (!track) {
        this.dropCandidate(candidate, 'track-gone', nowMs, drops, false)
      } else if (!this.classes[track.classId]?.alertable || priorityFor(track, this.cfg, this.corridorDepthM) === null) {
        this.dropCandidate(candidate, 'not-eligible', nowMs, drops, true)
      } else {
        candidate.alert = {
          ...candidate.alert,
          phrase: obstaclePhrase(this.describe(track)),
          pan: panFor(track.clock.angleDeg),
          frameTimeMs,
        }
        candidate.distanceM = track.distanceM
      }
    }
  }

  /** Queue an alert, replacing an older one for the same track and keeping the queue short. */
  private admit(r: Raised, nowMs: number, frameTimeMs: number, drops: DropRecord[]): void {
    const { track, priority, reason } = r
    const key = { priority, distanceM: track.distanceM }
    if (priority !== 'urgent') {
      const others = [...this.pending.values()].filter((c) => c.trackId !== track.id)
      if (others.length >= this.cfg.maxQueuedAlerts) {
        const worst = others.sort(compare)[others.length - 1]
        // Not better than what is already waiting: hold it back (its memory is untouched, so it comes up again).
        if (compare(key, worst) >= 0) return
        this.dropCandidate(worst, 'queue-full', nowMs, drops, true)
      }
    }
    const previous = this.pending.get(track.id)
    const memory = this.memory.get(track.id)
    if (previous) this.dropCandidate(previous, 'superseded', nowMs, drops, false)

    this.counter += 1
    const alert: AlertEvent = {
      id: `alert-${this.counter}`,
      kind: 'obstacle',
      priority,
      trackId: track.id,
      phrase: obstaclePhrase(this.describe(track)),
      pan: panFor(track.clock.angleDeg),
      frameTimeMs,
      createdTimeMs: nowMs,
    }
    this.pending.set(track.id, {
      alert,
      trackId: track.id,
      priority,
      distanceM: track.distanceM,
      reason,
      revert: previous ? previous.revert : memory ? { ...memory } : null,
    })
    this.memory.set(track.id, {
      priority,
      band: bandIndex(track.distanceM, this.cfg.distanceBandsM),
      inPath: track.inPath,
      clock: track.clock.position,
      atMs: nowMs,
      urgentAtMs: priority === 'urgent' ? nowMs : (memory?.urgentAtMs ?? -Infinity),
    })
  }

  /** The alert to speak now, if the rules allow one. */
  private release(nowMs: number): Candidate | null {
    if (this.inFlight && nowMs - this.inFlight.sentMs > this.cfg.inFlightTimeoutMs) {
      // Treat it as finished at the moment it timed out, not now, so the minimum gap does not start again.
      this.lastEndMs = this.inFlight.sentMs + this.cfg.inFlightTimeoutMs
      this.inFlight = null
    }
    const best = [...this.pending.values()].sort(compare)[0]
    if (!best) return null
    if (best.priority === 'urgent') {
      if (this.inFlight?.urgent) return null // an urgent alert is never cut off by another one
    } else if (this.inFlight || nowMs - this.lastEndMs < this.cfg.minGapMs) {
      return null
    }
    // An urgent alert cutting off one that is still being spoken: that one was not fully heard.
    if (this.inFlight) this.restore(this.inFlight)
    this.pending.delete(best.trackId)
    this.inFlight = {
      id: best.alert.id,
      trackId: best.trackId,
      urgent: best.priority === 'urgent',
      sentMs: nowMs,
      revert: best.revert,
    }
    return best
  }

  /** Let a track whose alert was not heard be announced again, unless a newer alert for it is already waiting. */
  private restore(flight: InFlight): void {
    if (this.pending.has(flight.trackId)) return
    if (flight.revert) this.memory.set(flight.trackId, flight.revert)
    else this.memory.delete(flight.trackId)
  }

  private dropCandidate(candidate: Candidate, reason: DropReason, nowMs: number, drops: DropRecord[], revert: boolean): void {
    this.pending.delete(candidate.trackId)
    const record: DropRecord = { alert: candidate.alert, trackId: candidate.trackId, reason, timeMs: nowMs }
    drops.push(record)
    this.dropLog.push(record)
    if (this.dropLog.length > DROP_LOG_LIMIT) this.dropLog.shift()
    if (!revert) return
    // The alert never reached the user, so let the track be announced again.
    if (candidate.revert) this.memory.set(candidate.trackId, candidate.revert)
    else this.memory.delete(candidate.trackId)
  }
}
