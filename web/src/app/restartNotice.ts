// After the page reloads by itself while Kenshi is running (iOS does this to free memory, or after the page crashed), the
// app starts over at the Start screen, silently: sound needs a tap. The page notes in sessionStorage (which survives a
// reload of the same tab) that it was running, so after such a reload the status line says what happened.
const KEY = 'kenshi.wasRunning.v1'

export const RESTART_NOTICE = 'Kenshi restarted because the page reloaded. Press Start to continue.'

/** The part of sessionStorage the notice needs. */
export interface FlagStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Note whether the camera and detector are running (a reload from now on interrupts them). */
export function noteRunning(storage: FlagStorage | null, running: boolean): void {
  try {
    if (running) storage?.setItem(KEY, '1')
    else storage?.removeItem(KEY)
  } catch {
    // Storage blocked: no notice after a reload, nothing else changes.
  }
}

/** The notice if the page reloaded while running, once; null otherwise. */
export function takeRestartNotice(storage: FlagStorage | null): string | null {
  try {
    if (storage?.getItem(KEY) !== '1') return null
    storage.removeItem(KEY)
    return RESTART_NOTICE
  } catch {
    return null
  }
}

/** This tab's sessionStorage, or null where it is blocked. */
export function sessionFlagStorage(): FlagStorage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}
