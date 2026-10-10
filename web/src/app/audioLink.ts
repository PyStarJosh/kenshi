// Connects the live session to the health monitor and the audio engine: frames and pitch go into the
// monitor, its state and warnings go to the engine, and the heartbeat ticks on the same check timer.
// AlertEvents arrive through handleAlert once the alert policy (A5) and the event bus exist.
import { AudioEngine } from '../audio/engine'
import type { AlertTiming } from '../audio/engine'
import { createBrowserSpeaker } from '../audio/speech'
import { TonePlayer } from '../audio/tones'
import { GREETING, unlockAudioContext } from '../audio/unlock'
import { CONFIG } from '../core/config'
import type { AlertEvent, AlertOutcome, AlertPriority, HealthState } from '../core/types'
import { HealthMonitor } from '../health/monitor'
import type { HealthAnnouncement, RunState } from '../health/monitor'
import { watchPitch } from '../health/pitch'
import type { Session, SessionState } from './session'

export interface AudioLinkView {
  unlocked: boolean
  contextState: string
  voice: string | null
  health: HealthState | null
  timing: AlertTiming | null
  lastOutcome: string | null
  /** The latest audio, speech, or motion problem, for the status area. */
  error: string | null
}

const RUN_STATE: Record<SessionState, RunState> = {
  idle: 'stopped',
  starting: 'stopped',
  running: 'running',
  paused: 'paused',
}

export class AudioLink {
  private monitor = new HealthMonitor()
  private speech = createBrowserSpeaker()
  private ctx: AudioContext | null = null
  private engine: AudioEngine | null = null
  private stopPitch: (() => void) | null = null
  private testTracks = new Map<number, { distanceM: number }>()
  private testCount = 0
  private simulateHealthy = false
  private listeners = new Set<() => void>()
  private view: AudioLinkView = {
    unlocked: false,
    contextState: 'none',
    voice: null,
    health: null,
    timing: null,
    lastOutcome: null,
    error: this.speech.available ? null : 'Speech is not available in this browser. Tones still play.',
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getView = (): AudioLinkView => this.view

  /**
   * Call synchronously inside a tap (Start, Pause, the test panel). The first call creates the
   * AudioContext, the tone player, and the engine, and starts motion updates; later calls resume audio.
   */
  unlock(greet: boolean): void {
    const ctx = unlockAudioContext(this.ctx, (message) => this.reportError(message))
    if (!ctx) {
      this.reportError('This browser cannot play sounds.')
      return
    }
    if (!this.ctx) {
      this.ctx = ctx
      ctx.addEventListener('statechange', () => this.syncContextState())
      this.engine = new AudioEngine({
        tones: new TonePlayer(ctx),
        speaker: this.speech.speaker,
        // Real tracks join this lookup with the tracker (A4); until then only test alerts pass the
        // track check, and any other obstacle alert is dropped as track-gone (SR-3).
        getTrack: (id) => this.testTracks.get(id) ?? null,
        now: () => performance.now(),
        onOutcome: (alert, outcome, latencyMs) => this.recordOutcome(alert, outcome, latencyMs),
        onError: (message) => this.reportError(message),
      })
    }
    this.stopPitch ??= watchPitch(
      (sample) => this.monitor.recordOrientation(sample),
      (message) => this.reportError(message),
    )
    if (greet) this.speech.speaker.speak({ text: GREETING, urgent: false })
    this.syncContextState()
  }

  /** Feed the monitor from the session and run the check timer. Returns a cleanup function. */
  attach(session: Session): () => void {
    const syncRun = () => this.monitor.setRunState(RUN_STATE[session.getSnapshot().state], performance.now())
    syncRun()
    const offState = session.subscribe(syncRun)
    const offResult = session.onResult((result) => this.monitor.recordFrame(result))
    const restore = () => {
      if (this.ctx && this.ctx.state !== 'running') this.unlock(false)
    }
    window.addEventListener('pointerdown', restore)
    const timer = setInterval(() => this.check(), CONFIG.audio.checkIntervalMs)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pointerdown', restore)
      offResult()
      offState()
      this.stopPitch?.()
      this.stopPitch = null
    }
  }

  handleAlert(alert: AlertEvent): void {
    this.engine?.handleAlert(alert)
  }

  /** ?debug test panel: an alert with a fake track at the given distance. */
  fireTestAlert(priority: AlertPriority, pan: number, distanceM: number, phrase: string): void {
    this.unlock(false)
    const now = performance.now()
    this.testCount += 1
    const trackId = -this.testCount
    this.testTracks.set(trackId, { distanceM })
    this.handleAlert({
      id: `test-${this.testCount}`,
      kind: priority === 'info' ? 'status' : 'obstacle',
      priority,
      trackId: priority === 'info' ? null : trackId,
      phrase,
      pan,
      frameTimeMs: now,
      createdTimeMs: now,
    })
  }

  /** ?debug test panel: play a health warning or the recovery phrase. */
  fireTestHealth(announcement: HealthAnnouncement): void {
    this.unlock(false)
    this.engine?.announceHealth(announcement)
  }

  /** ?debug test panel: pretend detection is healthy while no session runs, so the heartbeat ticks. */
  setSimulateHealthy(on: boolean): void {
    this.unlock(false)
    this.simulateHealthy = on
  }

  private check(): void {
    const now = performance.now()
    const { state, announcements } = this.monitor.update(now)
    const health =
      this.simulateHealthy && state.status === 'stopped' && !state.paused
        ? { ...state, status: 'healthy' as const, issues: [] }
        : state
    if (this.engine) {
      this.engine.setHealth(health)
      for (const announcement of announcements) this.engine.announceHealth(announcement)
      this.engine.tickHeartbeat()
    }
    this.update({ health, timing: this.engine?.getTiming() ?? null, voice: this.speech.speaker.getVoice()?.name ?? null })
  }

  private syncContextState(): void {
    const state = this.ctx?.state ?? 'none'
    this.monitor.setFault('audio-blocked', this.ctx !== null && state !== 'running')
    this.update({ unlocked: this.ctx !== null, contextState: state })
  }

  private recordOutcome(alert: AlertEvent, outcome: AlertOutcome, latencyMs: number | null): void {
    if (alert.trackId !== null && outcome !== 'started') this.testTracks.delete(alert.trackId)
    const latency = latencyMs === null ? '' : ` after ${latencyMs.toFixed(0)} ms`
    this.update({ lastOutcome: `${alert.id} ${outcome}${latency}` })
  }

  private reportError(message: string): void {
    this.update({ error: message })
  }

  private update(patch: Partial<AudioLinkView>): void {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }
}
