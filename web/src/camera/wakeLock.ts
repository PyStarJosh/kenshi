// Screen Wake Lock: keeps the screen on while Kenshi runs. A locked screen stops the camera.

export class WakeLock {
  private sentinel: WakeLockSentinel | null = null

  /** True if this browser offers the Wake Lock API. */
  get supported(): boolean {
    return 'wakeLock' in navigator
  }

  /** Request the lock. Resolves false if it could not be held (unsupported, or the browser refused). */
  async acquire(): Promise<boolean> {
    if (!this.supported) return false
    if (this.sentinel && !this.sentinel.released) return true
    try {
      this.sentinel = await navigator.wakeLock.request('screen')
      return true
    } catch {
      // Refused, for example in low-power mode or while the page is hidden. The caller tells the user.
      this.sentinel = null
      return false
    }
  }

  async release(): Promise<void> {
    const sentinel = this.sentinel
    this.sentinel = null
    await sentinel?.release()
  }
}
