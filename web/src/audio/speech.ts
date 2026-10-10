// Speech: one phrase at a time, at most one waiting, and urgent phrases preempt everything (SR-4).
// The Speaker logic runs against small interfaces so it can be tested without a browser.
import { CONFIG } from '../core/config'

export interface VoiceLike {
  name: string
  lang: string
  localService: boolean
}

export interface UtteranceLike {
  text: string
  rate: number
  voice: VoiceLike | null
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}

export interface SynthLike {
  speak(utterance: UtteranceLike): void
  cancel(): void
}

/** How a request ended. "dropped" means prepare() refused it (for example, the alert went stale). */
export type SpeechOutcome = 'finished' | 'preempted' | 'dropped' | 'failed'

export interface SpeechRequest {
  text: string
  urgent: boolean
  /**
   * Runs just before the phrase starts, for the stale check and the lead-in tone.
   * Returns how long to wait before speaking, or null to drop the phrase.
   */
  prepare?: () => number | null
  /** The utterance started, in performance.now() milliseconds. */
  onStart?: (timeMs: number) => void
  onDone?: (outcome: SpeechOutcome, detail?: string) => void
}

export interface SpeakerDeps {
  synth: SynthLike
  createUtterance: (text: string) => UtteranceLike
  now: () => number
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

interface Current {
  request: SpeechRequest
  utterance: UtteranceLike | null
  timer: unknown
}

/**
 * Prefer an enhanced or premium local English voice, then any local English voice (US first),
 * then any English voice. Null keeps the browser default.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[]): V | null {
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'))
  const local = english.filter((voice) => voice.localService)
  const enhanced = local.filter((voice) => /enhanced|premium/i.test(voice.name))
  const us = (list: V[]) => list.find((voice) => voice.lang.toLowerCase().replace('_', '-') === 'en-us')
  return us(enhanced) ?? enhanced[0] ?? us(local) ?? local[0] ?? english[0] ?? null
}

export class Speaker {
  private deps: SpeakerDeps
  private current: Current | null = null
  private pending: SpeechRequest | null = null
  private rate = CONFIG.audio.defaultSpeechRate
  private voice: VoiceLike | null = null
  private enabled = true

  constructor(deps: SpeakerDeps) {
    this.deps = deps
  }

  setRate(rate: number): void {
    this.rate = rate
  }

  setVoice(voice: VoiceLike | null): void {
    this.voice = voice
  }

  getVoice(): VoiceLike | null {
    return this.voice
  }

  /** With spoken feedback off, prepare() still runs (tones still play) but nothing is spoken. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** True while a phrase is waiting for its lead-in or being spoken. */
  isBusy(): boolean {
    return this.current !== null
  }

  speak(request: SpeechRequest): void {
    if (request.urgent) {
      this.interrupt()
      this.begin(request)
      return
    }
    if (this.current) {
      // Only the newest waiting phrase is kept.
      this.pending?.onDone?.('preempted')
      this.pending = request
      return
    }
    this.begin(request)
  }

  /** Stop the current phrase and drop the waiting one. */
  interrupt(): void {
    const pending = this.pending
    this.pending = null
    pending?.onDone?.('preempted')
    if (this.current) this.finish(this.current, 'preempted', undefined, false)
    this.deps.synth.cancel()
  }

  private begin(request: SpeechRequest): void {
    const waitMs = request.prepare ? request.prepare() : 0
    if (waitMs === null) {
      request.onDone?.('dropped')
      this.next()
      return
    }
    const current: Current = { request, utterance: null, timer: null }
    this.current = current
    if (waitMs > 0) {
      current.timer = this.deps.setTimer(() => this.utter(current), waitMs)
    } else {
      // Speak synchronously, so a call inside a tap still counts as a user gesture on iOS.
      this.utter(current)
    }
  }

  private utter(current: Current): void {
    if (this.current !== current) return
    const { request } = current
    if (!this.enabled) {
      this.finish(current, 'finished')
      return
    }
    const utterance = this.deps.createUtterance(request.text)
    utterance.rate = this.rate
    utterance.voice = this.voice
    utterance.onstart = () => {
      if (this.current === current) request.onStart?.(this.deps.now())
    }
    utterance.onend = () => this.finish(current, 'finished')
    utterance.onerror = (event) => {
      const outcome = event.error === 'interrupted' || event.error === 'canceled' ? 'preempted' : 'failed'
      this.finish(current, outcome, event.error)
    }
    current.utterance = utterance
    // Some iOS versions never fire onend; this keeps the speaker from staying busy forever.
    const { speechWatchdogBaseMs, speechWatchdogPerCharMs } = CONFIG.audio
    const watchdogMs = (speechWatchdogBaseMs + request.text.length * speechWatchdogPerCharMs) / Math.max(this.rate, 0.1)
    current.timer = this.deps.setTimer(() => this.finish(current, 'finished'), watchdogMs)
    this.deps.synth.speak(utterance)
  }

  private finish(current: Current, outcome: SpeechOutcome, detail?: string, advance = true): void {
    if (this.current !== current) return
    this.current = null
    if (current.timer !== null) this.deps.clearTimer(current.timer)
    current.request.onDone?.(outcome, detail)
    if (advance) this.next()
  }

  private next(): void {
    const pending = this.pending
    if (!pending || this.current) return
    this.pending = null
    this.begin(pending)
  }
}

/**
 * A Speaker on the browser's speechSynthesis, with voice selection once voices are listed.
 * Without speechSynthesis it returns a Speaker that stays silent (tones still play) and available false.
 */
export function createBrowserSpeaker(): { speaker: Speaker; available: boolean } {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    const speaker = new Speaker({
      synth: { speak: () => {}, cancel: () => {} },
      createUtterance: (text) => ({ text, rate: 1, voice: null, onstart: null, onend: null, onerror: null }),
      now: () => performance.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    })
    speaker.setEnabled(false)
    return { speaker, available: false }
  }
  const synth = window.speechSynthesis
  const speaker = new Speaker({
    synth: { speak: (u) => synth.speak(u as SpeechSynthesisUtterance), cancel: () => synth.cancel() },
    createUtterance: (text) => new SpeechSynthesisUtterance(text) as UtteranceLike,
    now: () => performance.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  const chooseVoice = () => speaker.setVoice(pickVoice(synth.getVoices()))
  chooseVoice()
  synth.addEventListener('voiceschanged', chooseVoice)
  return { speaker, available: true }
}
