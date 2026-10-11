// Voice control: what a tap does. Listen for one command and run it; if recognition is unsupported,
// denied, fails, or hears nothing, the tap alone runs "what's around me" (FR-15, FR-16).
// "What's around me" is delegated (summarize() comes from the alert policy, A5).
import type { VoiceIntent } from '../core/types'
import { parseCommand, stepSpeechRate, VOICE_PHRASES } from './commands'
import type { ListenResult } from './recognizer'

export type VoiceSource = 'speech' | 'tap-fallback' | 'long-press'

export interface VoiceControlDeps {
  recognizer: { isSupported(): boolean; isListening(): boolean; listen(): Promise<ListenResult>; cancel(): void }
  /** Speak a normal-priority phrase and show it in the status area. */
  say: (text: string) => void
  /** Pause or resume speech output around the microphone, so the app does not hear itself. */
  holdSpeech: (held: boolean) => void
  earcon: (phase: 'start' | 'stop') => void
  whatsAround: () => void
  pauseDetection: () => void
  resumeDetection: () => void
  /** True while detection is paused by the user. */
  isPaused: () => boolean
  getSpeechRate: () => number
  setSpeechRate: (rate: number) => void
  /** The phrase of the last obstacle alert, or null. */
  lastAlertPhrase: () => string | null
  onIntent: (intent: VoiceIntent, source: VoiceSource) => void
  onError: (message: string) => void
}

export class VoiceControl {
  private deps: VoiceControlDeps
  private permanentlyFailed = false
  private unavailableAnnounced = false

  constructor(deps: VoiceControlDeps) {
    this.deps = deps
  }

  isListening(): boolean {
    return this.deps.recognizer.isListening()
  }

  /** A tap: cancel if listening, otherwise listen. Call inside the tap so iOS allows the microphone. */
  tap(): void {
    const { recognizer } = this.deps
    if (recognizer.isListening()) {
      recognizer.cancel()
      return
    }
    if (this.permanentlyFailed || !recognizer.isSupported()) {
      this.permanentlyFailed = true
      this.fallback()
      return
    }
    void this.listen()
  }

  /** A long press toggles detection. */
  longPress(): void {
    this.deps.recognizer.cancel()
    this.run(this.deps.isPaused() ? 'resume' : 'pause', 'long-press')
  }

  /** An urgent alert is about to speak: stop listening so it is heard at once and not recorded. */
  cancelForUrgent(): void {
    this.deps.recognizer.cancel()
  }

  private async listen(): Promise<void> {
    const { deps } = this
    deps.holdSpeech(true)
    deps.earcon('start')
    const result = await deps.recognizer.listen()
    deps.holdSpeech(false)
    deps.earcon('stop')
    switch (result.kind) {
      case 'text': {
        const intent = parseCommand(result.text)
        if (intent === 'unknown') {
          deps.say(VOICE_PHRASES.notUnderstood)
          this.run('whats-around', 'tap-fallback')
        } else {
          this.run(intent, 'speech')
        }
        return
      }
      case 'silence':
        this.run('whats-around', 'tap-fallback')
        return
      case 'cancelled':
        return
      case 'failed':
        deps.onError(result.message)
        if (result.permanent) this.permanentlyFailed = true
        this.fallback()
    }
  }

  /** Recognition is not usable: say so once, then run "what's around me". */
  private fallback(): void {
    if (!this.unavailableAnnounced) {
      this.unavailableAnnounced = true
      this.deps.say(VOICE_PHRASES.unavailable)
    }
    this.run('whats-around', 'tap-fallback')
  }

  private run(intent: VoiceIntent, source: VoiceSource): void {
    const { deps } = this
    deps.onIntent(intent, source)
    switch (intent) {
      case 'whats-around':
        deps.whatsAround()
        return
      case 'pause':
        deps.pauseDetection()
        deps.say(VOICE_PHRASES.paused)
        return
      case 'resume':
        deps.resumeDetection()
        deps.say(VOICE_PHRASES.resumed)
        return
      case 'repeat':
        deps.say(deps.lastAlertPhrase() ?? VOICE_PHRASES.nothingToRepeat)
        return
      case 'slower':
      case 'faster': {
        const current = deps.getSpeechRate()
        const next = stepSpeechRate(current, intent)
        if (next === current) {
          deps.say(intent === 'slower' ? VOICE_PHRASES.slowestReached : VOICE_PHRASES.fastestReached)
          return
        }
        deps.setSpeechRate(next)
        deps.say(intent === 'slower' ? VOICE_PHRASES.slower : VOICE_PHRASES.faster)
        return
      }
      case 'help':
        deps.say(VOICE_PHRASES.help)
        return
      case 'unknown':
        deps.whatsAround()
    }
  }
}
