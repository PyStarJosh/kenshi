// Audio engine: turns AlertEvents and health announcements into a lead-in tone and a phrase,
// and ticks the heartbeat while detection is healthy. One phrase at a time; urgent preempts (SR-4).
import { CONFIG } from '../core/config'
import type { AlertEvent, AlertOutcome, HealthState, Settings } from '../core/types'
import type { HealthAnnouncement } from '../health/monitor'
import { heartbeatDue } from './heartbeat'
import type { Speaker, SpeechOutcome } from './speech'
import { alertTone, heartbeatTone, warningTone } from './tones'
import type { TonePlayerLike } from './tones'

/** Distance for the pulse rate, or null when the track no longer exists. */
export type TrackLookup = (trackId: number) => { distanceM: number } | null

export type AudioSettings = Pick<Settings, 'speechRate' | 'spokenFeedback' | 'toneVolume' | 'heartbeatVolume'>

/** Latest measured delays, in milliseconds, for the debug panel and telemetry. */
export interface AlertTiming {
  alertId: string
  /** AlertEvent creation to tone start. */
  alertToToneMs: number | null
  /** Frame capture to tone start (NFR-3). */
  frameToToneMs: number | null
  /** Frame capture to speech start (NFR-4). */
  frameToSpeechMs: number | null
}

export interface AudioEngineDeps {
  tones: TonePlayerLike
  speaker: Pick<Speaker, 'speak' | 'isBusy' | 'setRate' | 'setEnabled'>
  getTrack: TrackLookup
  now: () => number
  onOutcome: (alert: AlertEvent, outcome: AlertOutcome, latencyMs: number | null) => void
  onError: (message: string) => void
}

export type AlertVerdict = 'ok' | 'dropped-stale' | 'dropped-track-gone'

/** SR-3: drop an alert that is too old, or whose track is gone, before it makes any sound. */
export function screenAlert(alert: AlertEvent, nowMs: number, getTrack: TrackLookup): AlertVerdict {
  if (nowMs - alert.frameTimeMs > CONFIG.alerts.staleLimitMs) return 'dropped-stale'
  if (alert.trackId !== null && getTrack(alert.trackId) === null) return 'dropped-track-gone'
  return 'ok'
}

const SPEECH_TO_ALERT_OUTCOME: Record<Exclude<SpeechOutcome, 'dropped' | 'failed'>, AlertOutcome> = {
  finished: 'finished',
  preempted: 'preempted',
}

export class AudioEngine {
  private deps: AudioEngineDeps
  private settings: AudioSettings = {
    speechRate: CONFIG.settings.speechRate,
    spokenFeedback: true,
    toneVolume: CONFIG.settings.toneVolume,
    heartbeatVolume: CONFIG.settings.heartbeatVolume,
  }
  private health: HealthState | null = null
  private lastTickMs = -Infinity
  private timing: AlertTiming | null = null

  constructor(deps: AudioEngineDeps) {
    this.deps = deps
  }

  applySettings(settings: AudioSettings): void {
    this.settings = { ...settings }
    this.deps.speaker.setRate(settings.speechRate)
    this.deps.speaker.setEnabled(settings.spokenFeedback)
  }

  getTiming(): AlertTiming | null {
    return this.timing
  }

  handleAlert(alert: AlertEvent): void {
    const { deps } = this
    const urgent = alert.priority === 'urgent'
    let toneStarted = false
    deps.speaker.speak({
      text: alert.phrase,
      urgent,
      prepare: () => {
        const nowMs = deps.now()
        const verdict = screenAlert(alert, nowMs, deps.getTrack)
        if (verdict !== 'ok') {
          deps.onOutcome(alert, verdict, null)
          return null
        }
        this.timing = { alertId: alert.id, alertToToneMs: null, frameToToneMs: null, frameToSpeechMs: null }
        if (alert.pan === null) return 0
        if (urgent) deps.tones.stop()
        const distanceM = alert.trackId === null ? null : (deps.getTrack(alert.trackId)?.distanceM ?? null)
        const tone = deps.tones.play(alertTone(alert.priority, alert.pan, distanceM), this.settings.toneVolume)
        toneStarted = true
        this.timing.alertToToneMs = tone.startMs - alert.createdTimeMs
        this.timing.frameToToneMs = tone.startMs - alert.frameTimeMs
        deps.onOutcome(alert, 'started', this.timing.frameToToneMs)
        return Math.max(0, tone.endMs - nowMs) + CONFIG.audio.toneToSpeechGapMs
      },
      onStart: (timeMs) => {
        if (this.timing?.alertId === alert.id) this.timing.frameToSpeechMs = timeMs - alert.frameTimeMs
        if (!toneStarted) deps.onOutcome(alert, 'started', timeMs - alert.frameTimeMs)
      },
      onDone: (outcome, detail) => this.reportDone(alert, outcome, detail),
    })
  }

  announceHealth(announcement: HealthAnnouncement): void {
    const { deps } = this
    const warning = announcement.kind === 'warning'
    deps.speaker.speak({
      text: announcement.phrase,
      urgent: warning,
      prepare: () => {
        if (!warning) return 0
        deps.tones.stop()
        const tone = deps.tones.play(warningTone(), this.settings.toneVolume)
        return Math.max(0, tone.endMs - deps.now()) + CONFIG.audio.toneToSpeechGapMs
      },
      onDone: (outcome, detail) => {
        if (outcome === 'failed') deps.onError(`Speech failed: ${detail ?? 'unknown error'}`)
      },
    })
  }

  setHealth(health: HealthState): void {
    this.health = health
  }

  /** Call every CONFIG.audio.checkIntervalMs; plays a tick when one is due. */
  tickHeartbeat(): void {
    const nowMs = this.deps.now()
    const due = heartbeatDue({
      nowMs,
      lastTickMs: this.lastTickMs,
      intervalMs: CONFIG.audio.heartbeatIntervalMs,
      health: this.health,
      speaking: this.deps.speaker.isBusy(),
      toneBusyUntilMs: this.deps.tones.busyUntilMs(),
    })
    if (!due) return
    this.lastTickMs = nowMs
    this.deps.tones.play(heartbeatTone(), this.settings.heartbeatVolume)
  }

  private reportDone(alert: AlertEvent, outcome: SpeechOutcome, detail?: string): void {
    // "dropped" was already reported with its reason by prepare().
    if (outcome === 'dropped') return
    if (outcome === 'failed') {
      this.deps.onError(`Speech failed: ${detail ?? 'unknown error'}`)
      return
    }
    this.deps.onOutcome(alert, SPEECH_TO_ALERT_OUTCOME[outcome], null)
  }
}
