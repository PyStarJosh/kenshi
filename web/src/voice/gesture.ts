// Talk gesture: a short press is a tap, a press held for longPressMs is a long press (fired while still
// held, so the user gets feedback without lifting). Taps closer together than tapDebounceMs count once.
import { CONFIG } from '../core/config'

export interface GestureDeps {
  now: () => number
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  onTap: () => void
  onLongPress: () => void
}

export class TalkGesture {
  private deps: GestureDeps
  private timer: unknown = null
  private down = false
  private longFired = false
  private lastTapMs = -Infinity

  constructor(deps: GestureDeps) {
    this.deps = deps
  }

  pressStart(): void {
    if (this.down) return
    this.down = true
    this.longFired = false
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      this.longFired = true
      this.deps.onLongPress()
    }, CONFIG.voice.longPressMs)
  }

  pressEnd(): void {
    if (!this.down) return
    this.down = false
    this.clearTimer()
    if (this.longFired) return
    this.tap()
  }

  /** The finger slid away or the system took the touch: nothing fires. */
  pressCancel(): void {
    this.down = false
    this.clearTimer()
  }

  /** A tap without a press (keyboard, VoiceOver activation). */
  tap(): void {
    const nowMs = this.deps.now()
    if (nowMs - this.lastTapMs < CONFIG.voice.tapDebounceMs) return
    this.lastTapMs = nowMs
    this.deps.onTap()
  }

  private clearTimer(): void {
    if (this.timer === null) return
    this.deps.clearTimer(this.timer)
    this.timer = null
  }
}
