// Recognizer: one listen = one English utterance, no interim results, ended by the first final result,
// an error, silence, or the listen timeout. Safari's recognition is unreliable, so every ending is
// reported as a result and the caller always has a fallback (FR-16).
import { CONFIG } from '../core/config'

export type ListenResult =
  | { kind: 'text'; text: string }
  /** Nothing was heard before the end of speech or the timeout. */
  | { kind: 'silence' }
  /** The user tapped again to cancel. */
  | { kind: 'cancelled' }
  /**
   * Recognition is missing, denied, offline, or failed; the message is for the status line.
   * Permanent means retrying cannot help (unsupported or denied), so later taps skip listening.
   */
  | { kind: 'failed'; message: string; permanent: boolean }

/** The part of SpeechRecognition used here. */
export interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export interface RecognizerDeps {
  supported: () => boolean
  create: () => RecognitionLike | null
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

/** Messages for the errors SpeechRecognition reports; anything else reads as a plain failure. */
const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access was denied.',
  'service-not-allowed': 'Speech recognition is not allowed on this device.',
  network: 'Speech recognition needs a connection.',
  'audio-capture': 'No microphone was found.',
}

const PERMANENT_ERRORS = new Set(['not-allowed', 'service-not-allowed'])

export class Recognizer {
  private deps: RecognizerDeps
  private active: { recognition: RecognitionLike; finish: (result: ListenResult) => void } | null = null

  constructor(deps: RecognizerDeps) {
    this.deps = deps
  }

  /** False when this browser has no speech recognition. */
  isSupported(): boolean {
    return this.deps.supported()
  }

  isListening(): boolean {
    return this.active !== null
  }

  /** Start listening; resolves exactly once. Call inside a tap so iOS shows the microphone prompt. */
  listen(): Promise<ListenResult> {
    if (this.active) return Promise.resolve({ kind: 'cancelled' })
    return new Promise((resolve) => {
      let recognition: RecognitionLike | null = null
      try {
        recognition = this.deps.create()
      } catch (error) {
        resolve({ kind: 'failed', message: String(error), permanent: false })
        return
      }
      if (!recognition) {
        resolve({ kind: 'failed', message: 'Speech recognition is not supported here.', permanent: true })
        return
      }
      const session = recognition
      let text = ''
      let settled = false
      const timer = this.deps.setTimer(() => session.stop(), CONFIG.voice.listenTimeoutMs)
      const finish = (result: ListenResult) => {
        if (settled) return
        settled = true
        this.deps.clearTimer(timer)
        this.active = null
        session.onresult = null
        session.onerror = null
        session.onend = null
        resolve(result)
      }
      session.lang = 'en-US'
      session.continuous = false
      session.interimResults = false
      session.maxAlternatives = 1
      session.onresult = (event) => {
        const last = event.results[event.results.length - 1]
        const heard = last?.[0]?.transcript?.trim() ?? ''
        if (heard) text = heard // kept even if not final: Safari may end without ever marking a result final
        if (last?.isFinal) session.stop()
      }
      session.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') return
        finish({
          kind: 'failed',
          message: ERROR_MESSAGES[event.error] ?? `Speech recognition failed: ${event.error}.`,
          permanent: PERMANENT_ERRORS.has(event.error),
        })
      }
      session.onend = () => finish(text ? { kind: 'text', text } : { kind: 'silence' })
      this.active = { recognition: session, finish }
      try {
        session.start()
      } catch (error) {
        finish({ kind: 'failed', message: `Speech recognition could not start: ${String(error)}`, permanent: false })
      }
    })
  }

  /** Stop listening now and resolve the pending listen() as cancelled. */
  cancel(): void {
    const active = this.active
    if (!active) return
    active.finish({ kind: 'cancelled' })
    try {
      active.recognition.abort()
    } catch {
      // The recognizer already ended; nothing more to stop.
    }
  }
}

type RecognitionConstructor = new () => RecognitionLike

/** A Recognizer on the browser's SpeechRecognition (webkit-prefixed in Safari). */
export function createBrowserRecognizer(): Recognizer {
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return new Recognizer({
    supported: () => Ctor !== undefined,
    create: () => (Ctor ? new Ctor() : null),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
}
