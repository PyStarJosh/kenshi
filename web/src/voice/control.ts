// Voice control: what a tap does. Listen for one command and run it. If recognition is unsupported or
// denied, say so once; a tap that hears nothing does nothing (FR-16). Objects are never read out.
// "find <target>" and "stop" start and cancel a Find; a long press cancels a Find that is running, and otherwise
// pauses or resumes detection.
import type { VoiceIntent } from '../core/types'
import { parseCommand, parseFind, stepSpeechRate, VOICE_PHRASES } from './commands'
import type { ListenResult } from './recognizer'

export type VoiceSource = 'speech' | 'tap-fallback' | 'long-press'

export interface VoiceControlDeps {
  recognizer: { isSupported(): boolean; isListening(): boolean; listen(): Promise<ListenResult>; cancel(): void }
  /** Speak a normal-priority phrase and show it in the status area. */
  say: (text: string) => void
  /** Pause or resume speech output around the microphone, so the app does not hear itself. */
  holdSpeech: (held: boolean) => void
  earcon: (phase: 'start' | 'stop') => void
  /** The microphone is about to be opened (true) or is closed again (false): the audio session must allow recording. */
  setCapture?: (capturing: boolean) => void
  /** Start looking for a target (a voice command). */
  startFind: (target: string) => void
  /** Cancel a Find that is running. */
  cancelFind: () => void
  /** True while a Find is running, so a long press and "stop" mean cancel it. */
  isFindActive: () => boolean
  pauseDetection: () => void
  resumeDetection: () => void
  /** True while detection is paused by the user. */
  isPaused: () => boolean
  getSpeechRate: () => number
  setSpeechRate: (rate: number) => void
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

  /** A long press cancels a running Find; otherwise it toggles detection. */
  longPress(): void {
    this.deps.recognizer.cancel()
    if (this.deps.isFindActive()) {
      this.run('stop', 'long-press')
      return
    }
    this.run(this.deps.isPaused() ? 'resume' : 'pause', 'long-press')
  }

  /** An urgent alert is about to speak: stop listening so it is heard at once and not recorded. */
  cancelForUrgent(): void {
    this.deps.recognizer.cancel()
  }

  private async listen(): Promise<void> {
    const { deps } = this
    // Before anything else, and inside the tap: the session must allow recording or the microphone hears nothing.
    deps.setCapture?.(true)
    deps.holdSpeech(true)
    deps.earcon('start')
    const result = await deps.recognizer.listen()
    deps.setCapture?.(false)
    deps.holdSpeech(false)
    deps.earcon('stop')
    switch (result.kind) {
      case 'text': {
        const intent = parseCommand(result.text)
        if (intent === 'unknown') deps.say(VOICE_PHRASES.notUnderstood)
        else this.run(intent, 'speech', result.text)
        return
      }
      case 'silence':
        return
      case 'cancelled':
        return
      case 'failed':
        deps.onError(result.message)
        if (result.permanent) this.permanentlyFailed = true
        this.fallback()
    }
  }

  /** Recognition is not usable: say so once. */
  private fallback(): void {
    if (this.unavailableAnnounced) return
    this.unavailableAnnounced = true
    this.deps.say(VOICE_PHRASES.unavailable)
  }

  private run(intent: VoiceIntent, source: VoiceSource, text = ''): void {
    const { deps } = this
    deps.onIntent(intent, source)
    switch (intent) {
      case 'find': {
        // Find speaks its own confirmation ("Looking for a chair."), so there is no reply here.
        const target = parseFind(text)
        if (target !== null) deps.startFind(target)
        return
      }
      case 'stop':
        // Find speaks "Find stopped." itself.
        if (deps.isFindActive()) deps.cancelFind()
        else deps.say(VOICE_PHRASES.nothingToStop)
        return
      case 'pause':
        deps.pauseDetection()
        deps.say(VOICE_PHRASES.paused)
        return
      case 'resume':
        deps.resumeDetection()
        deps.say(VOICE_PHRASES.resumed)
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
        return
    }
  }
}
