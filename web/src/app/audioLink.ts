// Connects the live session to the health monitor and the audio engine: frames and the session's tilt
// readings go into the monitor, its state and warnings go to the engine, and the heartbeat ticks on the
// same check timer. Audio settings come from the settings store.
// AlertEvents arrive through handleAlert once the alert policy (A5) and the event bus exist.
import { AudioEngine } from '../audio/engine'
import type { AlertTiming } from '../audio/engine'
import { createBrowserSpeaker } from '../audio/speech'
import { listeningTone, TonePlayer } from '../audio/tones'
import { GREETING, unlockAudioContext } from '../audio/unlock'
import { CONFIG } from '../core/config'
import type { AlertEvent, AlertOutcome, AlertPriority, HealthState } from '../core/types'
import { HealthMonitor } from '../health/monitor'
import type { HealthAnnouncement, RunState } from '../health/monitor'
import { VOICE_PHRASES } from '../voice/commands'
import { VoiceControl } from '../voice/control'
import { createBrowserRecognizer } from '../voice/recognizer'
import type { Session, SessionState } from './session'
import { settingsStore } from './settings'

/** The "what's around me" summary phrase, from the alert policy (A5). Null until that is wired in. */
export type Summarizer = () => string

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
    onIntent: (intent, source) => this.update({ lastVoice: `${intent} (${source})` }),
    onError: (message) => this.update({ voiceMessage: message }),
  })
  private session: Session | null = null
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
    voiceMessage: null,
    lastVoice: null,
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
        // Real tracks join this lookup with the tracker (A4); until then only test alerts pass the
        // track check, and any other obstacle alert is dropped as track-gone (SR-3).
        getTrack: (id) => this.testTracks.get(id) ?? null,
        now: () => performance.now(),
        onOutcome: (alert, outcome, latencyMs) => this.recordOutcome(alert, outcome, latencyMs),
        onError: (message) => this.reportError(message),
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
    const offResult = session.onResult((result) => this.monitor.recordFrame(result))
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
      offResult()
      offState()
      this.session = null
    }
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

  /** Where "what's around me" gets its phrase; the alert policy (A5) or the test panel sets it. */
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
