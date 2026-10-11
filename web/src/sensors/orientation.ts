// Device orientation: asks permission (iOS needs a tap), then provides smoothed camera pitch and roll
// for the current screen orientation, and the camera heading. Without a reading, geometry falls back to
// "level" and says so. The one listener below feeds all three, so there is no second permission or listener.
import { CONFIG } from '../core/config'
import type { OrientationSample } from '../core/types'
import { cameraAttitude, smoothAngle } from './attitude'
import { cameraForward, headingFromForward, HeadingTracker } from './heading'

/** idle: not listening. waiting: listening, no reading yet. ready: readings arrive. */
export type OrientationStatus = 'idle' | 'waiting' | 'ready' | 'denied' | 'unavailable'

export interface OrientationDeps {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  now: () => number
  /** screen.orientation.angle: 0 upright, 90 or 270 sideways, 180 upside down. */
  screenAngle: () => number
  /** Present only where the browser asks first (iOS Safari); must be called from a tap. */
  requestPermission: (() => Promise<'granted' | 'denied'>) | undefined
}

export class OrientationSensor {
  private deps: OrientationDeps
  private status: OrientationStatus = 'idle'
  private listeners = new Set<(status: OrientationStatus) => void>()
  private denied = false
  private smoothed: { pitchDeg: number; rollDeg: number } | null = null
  private heading = new HeadingTracker(CONFIG.orientation.headingSmoothing)
  private history: OrientationSample[] = []
  private noDataTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: OrientationDeps) {
    this.deps = deps
  }

  /**
   * Ask for permission. Call this synchronously from the Start tap, because iOS only shows the
   * prompt for a user gesture. Resolves false if the user refused or the browser would not ask.
   */
  async requestPermission(): Promise<boolean> {
    const ask = this.deps.requestPermission
    if (!ask) return true
    try {
      this.denied = (await ask()) !== 'granted'
    } catch {
      // Not called from a gesture, or the prompt failed: treat it as refused so geometry degrades visibly.
      this.denied = true
    }
    if (this.denied) this.setStatus('denied')
    return !this.denied
  }

  /** Start listening. If permission was refused this only reports "denied". */
  start(): void {
    if (this.denied) {
      this.setStatus('denied')
      return
    }
    this.deps.target.addEventListener('deviceorientation', this.onEvent)
    this.setStatus('waiting')
    this.noDataTimer = setTimeout(() => {
      if (this.status === 'waiting') this.setStatus('unavailable')
    }, CONFIG.orientation.noDataTimeoutMs)
  }

  stop(): void {
    this.deps.target.removeEventListener('deviceorientation', this.onEvent)
    if (this.noDataTimer) clearTimeout(this.noDataTimer)
    this.noDataTimer = null
    this.smoothed = null
    this.heading.reset()
    this.history = []
    this.setStatus(this.denied ? 'denied' : 'idle')
  }

  getStatus(): OrientationStatus {
    return this.status
  }

  onStatus(listener: (status: OrientationStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The newest reading, or null if there is none or it is too old to trust. */
  latest(nowMs: number): OrientationSample | null {
    const last = this.history[this.history.length - 1]
    return last && nowMs - last.timeMs <= CONFIG.orientation.staleAfterMs ? last : null
  }

  /**
   * The tilt at a moment (for example a frame's capture time). Orientation holds until it changes, so
   * the last reading before the moment counts for up to staleAfterMs; a reading just after the moment
   * is used if it is closer (within maxSampleGapMs). Null if neither exists.
   */
  at(timeMs: number): OrientationSample | null {
    let before: OrientationSample | null = null
    let after: OrientationSample | null = null
    for (const sample of this.history) {
      if (sample.timeMs <= timeMs) {
        if (!before || sample.timeMs > before.timeMs) before = sample
      } else if (!after || sample.timeMs < after.timeMs) {
        after = sample
      }
    }
    const heldBefore = before && timeMs - before.timeMs <= CONFIG.orientation.staleAfterMs ? before : null
    const nearAfter = after && after.timeMs - timeMs <= CONFIG.orientation.maxSampleGapMs ? after : null
    if (heldBefore && nearAfter) {
      return nearAfter.timeMs - timeMs < timeMs - heldBefore.timeMs ? nearAfter : heldBefore
    }
    return heldBefore ?? nearAfter
  }

  private onEvent = (event: Event): void => {
    const { alpha, beta, gamma } = event as DeviceOrientationEvent
    if (beta === null || gamma === null || beta === undefined || gamma === undefined) return
    const reading = cameraAttitude(beta, gamma, this.deps.screenAngle())
    const factor = CONFIG.orientation.smoothing
    const previous = this.smoothed
    this.smoothed = previous
      ? {
          pitchDeg: smoothAngle(previous.pitchDeg, reading.pitchDeg, factor),
          rollDeg: smoothAngle(previous.rollDeg, reading.rollDeg, factor),
        }
      : reading
    const headingDeg =
      typeof alpha === 'number'
        ? this.heading.update(
            headingFromForward(
              cameraForward(alpha, beta, gamma),
              Math.cos((CONFIG.orientation.headingMaxPitchDeg * Math.PI) / 180),
            ),
          )
        : null
    const timeMs = this.deps.now()
    this.history.push(headingDeg === null ? { ...this.smoothed, timeMs } : { ...this.smoothed, headingDeg, timeMs })
    while (this.history.length > 0 && timeMs - this.history[0].timeMs > CONFIG.orientation.historyMs) {
      this.history.shift()
    }
    if (this.status !== 'ready') {
      if (this.noDataTimer) clearTimeout(this.noDataTimer)
      this.noDataTimer = null
      this.setStatus('ready')
    }
  }

  private setStatus(status: OrientationStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.listeners) listener(status)
  }
}

type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied'> }

/** A sensor wired to the real window. */
export function createOrientationSensor(): OrientationSensor {
  const api = window.DeviceOrientationEvent as unknown as PermissionApi | undefined
  return new OrientationSensor({
    target: window,
    now: () => performance.now(),
    screenAngle: () => screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0,
    requestPermission: typeof api?.requestPermission === 'function' ? () => api.requestPermission!() : undefined,
  })
}
