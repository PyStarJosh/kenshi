// Connects the live session to the health monitor and the audio engine: frames and the session's tilt
// readings go into the monitor, its state and warnings go to the engine, and the heartbeat ticks on the
// same check timer. Audio settings come from the settings store.
// AlertEvents arrive through handleAlert (the pipeline delivers them from the event bus); the pipeline also
// supplies the live track lookup and the "what's around me" summarizer, and listens for alert outcomes.
import { AudioEngine } from '../audio/engine'
import type { AlertTimes, AlertTiming, TrackLookup } from '../audio/engine'
import { createBrowserSpeaker } from '../audio/speech'
import { listeningTone, TonePlayer } from '../audio/tones'
import { GREETING, unlockAudioContext } from '../audio/unlock'
import { CONFIG } from '../core/config'
import type { AlertEvent, AlertOutcome, AlertPriority, FrameResult, HealthState, VoiceIntent } from '../core/types'
import { HealthMonitor } from '../health/monitor'
import type { HealthAnnouncement, RunState } from '../health/monitor'
import { VOICE_PHRASES } from '../voice/commands'
import { VoiceControl } from '../voice/control'
import type { VoiceSource } from '../voice/control'
import { createBrowserRecognizer } from '../voice/recognizer'
import { LatencyStats } from './latency'
import type { LatencyView } from './latency'
import type { Session, SessionState } from './session'
import { settingsStore } from './settings'

/** The "what's around me" summary phrase, from the alert policy (A5). Null until that is wired in. */
export type Summarizer = () => string

export type OutcomeListener = (alert: AlertEvent, outcome: AlertOutcome, latencyMs: number | null, times: AlertTimes) => void

export interface AudioLinkView {
  unlocked: boolean
  contextState: string
  voice: string | null
  health: HealthState | null
  timing: AlertTiming | null
  lastOutcome: string | null
  /** The latest audio, speech, or motion problem, for the status area. */
  error: string | null
  /** The latest voice command phrase or recognition problem, for the status area. */
  voiceMessage: string | null
  /** The latest voice intent and where it came from, for the debug panel. */
  lastVoice: string | null
  /** Capture-to-tone and capture-to-speech percentiles over real alerts (not the test panel's). */
  latency: LatencyView
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
  private tones: TonePlayer | null = null
  private engine: AudioEngine | null = null
  private summarizer: Summarizer | null = null
  private lastAlertPhrase: string | null = null
  private voice = new VoiceControl({
    recognizer: createBrowserRecognizer(),
    say: (text) => this.say(text),
    holdSpeech: (held) => this.speech.speaker.setHeld(held),
    earcon: (phase) => this.tones?.play(listeningTone(phase), settingsStore.getSnapshot().toneVolume),
    whatsAround: () => this.say(this.summarizer ? this.summarizer() : VOICE_PHRASES.aroundSoon),
    pauseDetection: () => this.session?.pause(),
    resumeDetection: () => void this.session?.resume(),
    isPaused: () => this.session?.getSnapshot().state === 'paused',
    getSpeechRate: () => settingsStore.getSnapshot().speechRate,
    setSpeechRate: (speechRate) => settingsStore.update({ speechRate }),
    lastAlertPhrase: () => this.lastAlertPhrase,
    onIntent: (intent, source) => {
      for (const listener of this.voiceListeners) listener(intent, source)
      this.update({ lastVoice: `${intent} (${source})` })
      for (const listener of this.intentListeners) listener(intent)
    },
    onError: (message) => this.update({ voiceMessage: message }),
  })
  private session: Session | null = null
  private testTracks = new Map<number, { distanceM: number }>()
  private trackLookup: TrackLookup | null = null
  private outcomeListeners = new Set<OutcomeListener>()
  private intentListeners = new Set<(intent: VoiceIntent) => void>()
  private healthListeners = new Set<(health: HealthState) => void>()
  private voiceListeners = new Set<(intent: VoiceIntent, source: VoiceSource) => void>()
  private healthKey = ''
  private latency = new LatencyStats()
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
    voiceMessage: null,
    lastVoice: null,
    latency: { urgentTone: null, tone: null, speech: null },
    error: this.speech.available ? null : 'Speech is not available in this browser. Tones still play.',
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getView = (): AudioLinkView => this.view

  /**
   * Call synchronously inside a tap (Start, Pause, the test panel). The first call creates the
   * AudioContext, the tone player, and the engine; later calls resume audio. Motion permission is
   * requested by session.start() in the same tap.
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
      this.tones = new TonePlayer(ctx)
      this.engine = new AudioEngine({
        tones: this.tones,
        speaker: this.speech.speaker,
        // Test alerts use fake tracks; real alerts check the live tracks the pipeline supplies, and an
        // alert whose track is gone is dropped as track-gone (SR-3).
        getTrack: (id) => this.testTracks.get(id) ?? this.trackLookup?.(id) ?? null,
        now: () => performance.now(),
        onOutcome: (alert, outcome, latencyMs, times) => this.recordOutcome(alert, outcome, latencyMs, times),
        onError: (message) => this.reportError(message),
        onLatency: (alert, stage, ms) => this.recordLatency(alert, stage, ms),
      })
      this.engine.applySettings(settingsStore.getSnapshot())
    }
    if (greet) this.speech.speaker.speak({ text: GREETING, urgent: false })
    this.syncContextState()
  }

  /** Feed the monitor from the session and run the check timer. Returns a cleanup function. */
  attach(session: Session): () => void {
    this.session = session
    const syncRun = () => this.monitor.setRunState(RUN_STATE[session.getSnapshot().state], performance.now())
    syncRun()
    const offState = session.subscribe(syncRun)
    const offSettings = settingsStore.subscribe(() => this.engine?.applySettings(settingsStore.getSnapshot()))
    const restore = () => {
      if (this.ctx && this.ctx.state !== 'running') this.unlock(false)
    }
    window.addEventListener('pointerdown', restore)
    const timer = setInterval(() => this.check(), CONFIG.audio.checkIntervalMs)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pointerdown', restore)
      offSettings()
      offState()
      this.session = null
    }
  }

  /** A frame result that made it through the whole pipeline; the health monitor counts only those. */
  recordFrame(result: FrameResult): void {
    this.monitor.recordFrame(result)
  }

  /** Hear every voice command the user gives. Returns a stop function. */
  onVoiceIntent(listener: (intent: VoiceIntent) => void): () => void {
    this.intentListeners.add(listener)
    return () => this.intentListeners.delete(listener)
  }

  /** Hear each change of the health status, issues, or pause. Returns a stop function. */
  onHealth(listener: (health: HealthState) => void): () => void {
    this.healthListeners.add(listener)
    return () => this.healthListeners.delete(listener)
  }

  handleAlert(alert: AlertEvent): void {
    // Urgent alerts preempt listening (SR-4): the mic closes and the tone and phrase play at once.
    if (alert.priority === 'urgent') this.voice.cancelForUrgent()
    if (alert.kind === 'obstacle') this.lastAlertPhrase = alert.phrase
    this.engine?.handleAlert(alert)
  }

  /** The Talk button's tap. Call synchronously inside the tap (microphone permission, audio unlock). */
  tap(): void {
    this.unlock(false)
    this.voice.tap()
  }

  /** The Talk button's long press: pause or resume detection. */
  longPress(): void {
    this.unlock(false)
    this.voice.longPress()
  }

  /** The live tracks, for the engine's track-gone check and its distance-based tone pulse. Null clears it. */
  setTrackLookup(lookup: TrackLookup | null): void {
    this.trackLookup = lookup
  }

  /** Hear what happened to every alert (started, finished, preempted, dropped). Returns a stop function. */
  onAlertOutcome(listener: OutcomeListener): () => void {
    this.outcomeListeners.add(listener)
    return () => this.outcomeListeners.delete(listener)
  }

  /** Hear each voice command and where it came from. Returns a stop function. */
  onVoice(listener: (intent: VoiceIntent, source: VoiceSource) => void): () => void {
    this.voiceListeners.add(listener)
    return () => this.voiceListeners.delete(listener)
  }

  /** Where "what's around me" gets its phrase; the pipeline sets it from the alert policy. */
  setSummarizer(summarizer: Summarizer | null): void {
    this.summarizer = summarizer
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
    const tilt = this.session?.getOrientationLatest(now)
    if (tilt) this.monitor.recordOrientation(tilt)
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
    const key = `${health.status}|${health.issues.join(',')}|${health.paused}`
    if (key !== this.healthKey) {
      this.healthKey = key
      for (const listener of this.healthListeners) listener(health)
    }
    this.update({ health, timing: this.engine?.getTiming() ?? null, voice: this.speech.speaker.getVoice()?.name ?? null })
  }

  private syncContextState(): void {
    const state = this.ctx?.state ?? 'none'
    this.monitor.setFault('audio-blocked', this.ctx !== null && state !== 'running')
    this.update({ unlocked: this.ctx !== null, contextState: state })
  }

  private recordLatency(alert: AlertEvent, stage: 'tone' | 'speech', ms: number): void {
    if (alert.id.startsWith('test-')) return // the test panel's fake alerts would skew the numbers
    this.latency.record(stage, alert.priority, ms)
    this.update({ latency: this.latency.view() })
  }

  private recordOutcome(alert: AlertEvent, outcome: AlertOutcome, latencyMs: number | null, times: AlertTimes): void {
    if (alert.trackId !== null && outcome !== 'started') this.testTracks.delete(alert.trackId)
    for (const listener of this.outcomeListeners) listener(alert, outcome, latencyMs, times)
    const latency = latencyMs === null ? '' : ` after ${latencyMs.toFixed(0)} ms`
    this.update({ lastOutcome: `${alert.id} ${outcome}${latency}` })
  }

  /** Speak a voice reply (normal priority) and show it in the status area. */
  private say(text: string): void {
    this.speech.speaker.speak({ text, urgent: false })
    this.update({ voiceMessage: text })
  }

  private reportError(message: string): void {
    this.update({ error: message })
  }

  private update(patch: Partial<AudioLinkView>): void {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }
}
