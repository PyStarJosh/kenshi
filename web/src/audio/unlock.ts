// Unlock: iOS plays Web Audio and speech only if they begin inside a user gesture, so this runs
// synchronously in the Start tap, before anything is awaited.

export const GREETING = 'Navigator on. It does not replace your cane. Hold the phone at eye level.'

type AudioContextConstructor = typeof AudioContext

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
