// Unlock: iOS plays Web Audio and speech only if they begin inside a user gesture, so this runs
// synchronously in the Start tap, before anything is awaited.

// Spoken only. The name is spelled Ken-shee so speech says KEN-shee (like the Mortal Kombat character); the written
// name everywhere else stays Kenshi.
export const GREETING = 'Ken-shee. Hold the phone at eye level.'

type AudioContextConstructor = typeof AudioContext

/**
 * Tell Safari this page plays media (iOS 16.4 and later), so Web Audio is not silenced by the ringer switch and is less
 * likely to be interrupted when speech starts. Quietly does nothing where the browser has no such API.
 */
export function setMediaAudioSession(): void {
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession
    if (session) session.type = 'playback'
  } catch {
    // Not supported or refused: the tones then follow the browser's default.
  }
}

/**
 * Switch the Safari audio session between playing (the tones, the beacon and speech) and playing while recording. A
 * "playback" session does not give the page the microphone: speech recognition then starts (you hear the system chime)
 * but hears only silence. So it is "play-and-record" while listening, and "playback" otherwise, so the ringer switch does
 * not mute the tones. Does nothing where the browser has no such API.
 */
export function setAudioSessionMode(mode: 'playback' | 'play-and-record'): void {
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession
    if (session) session.type = mode
  } catch {
    // Not supported or refused: the browser's default is used.
  }
}

/** Create (once) and resume the AudioContext. Returns null if this browser has no Web Audio. */
export function unlockAudioContext(
  existing: AudioContext | null,
  onError: (message: string) => void,
): AudioContext | null {
  const Ctor: AudioContextConstructor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
  if (!Ctor) return null
  const ctx = existing ?? new Ctor({ latencyHint: 'interactive' })
  // resume() must be called inside the gesture; its promise settles later.
  if (ctx.state !== 'running') {
    ctx.resume().catch((error: unknown) => onError(`Audio could not start: ${String(error)}`))
  }
  return ctx
}
