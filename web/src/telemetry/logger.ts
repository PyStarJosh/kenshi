// Test-mode logger: keeps a field-test walk in memory as JSON lines on the session clock (zero is the Start
// tap), so the walk can be scored and replayed offline (FR-19). It records only between begin() and stop(),
// so with Test mode off nothing is logged. Pure apart from the injected clock and timer.
import { CONFIG } from '../core/config'
import type { OrientationSample, TelemetryEvent } from '../core/types'

export type SessionEvent = Extract<TelemetryEvent, { kind: 'session' }>

/** What the caller knows about the run; the logger adds the version, wall-clock time, and the CONFIG. */
export type SessionMeta = Omit<SessionEvent, 'kind' | 'timeMs' | 'version' | 'startedAtIso' | 'config'>

export const LOG_VERSION = 1

export type LoggerStatus = 'off' | 'recording' | 'near-full' | 'full'

/** What the UI reacts to. It changes only when one of these fields does, never once per frame. */
export interface LoggerView {
  status: LoggerStatus
  /** True once anything was recorded and until the next begin(), so the Save button can show. */
  hasLog: boolean
  /** A warning for the spotter, or null. */
  message: string | null
}

export interface LoggerStats {
  entries: number
  bytes: number
  maxBytes: number
}

export type TelemetryConfig = typeof CONFIG.telemetry

export interface LoggerDeps {
  /** performance.now() */
  now: () => number
  /** The newest tilt reading, or null. */
  getOrientation: (nowMs: number) => OrientationSample | null
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  cfg?: TelemetryConfig
}

const OFF: LoggerView = { status: 'off', hasLog: false, message: null }

/** Re-express every time in an event on the session clock. Returns a new event; the input is left alone. */
export function toSessionClock(event: TelemetryEvent, originMs: number): TelemetryEvent {
  const t = (ms: number) => ms - originMs
  const tn = (ms: number | null | undefined) => (typeof ms === 'number' ? t(ms) : (ms ?? null))
  switch (event.kind) {
    case 'session':
    case 'run-state':
    case 'voice':
    case 'error':
      return { ...event, timeMs: t(event.timeMs) }
    case 'health':
      return { ...event, timeMs: t(event.timeMs), health: { ...event.health, updatedTimeMs: t(event.health.updatedTimeMs) } }
    case 'frame':
      return {
        ...event,
        timeMs: t(event.timeMs),
        captureTimeMs: t(event.captureTimeMs),
        receivedTimeMs: t(event.receivedTimeMs),
        orientation: event.orientation && { ...event.orientation, timeMs: t(event.orientation.timeMs) },
      }
    case 'orientation':
      return { ...event, timeMs: t(event.timeMs), sample: { ...event.sample, timeMs: t(event.sample.timeMs) } }
    case 'tracks':
      return {
        ...event,
        timeMs: t(event.timeMs),
        tracks: event.tracks.map((k) => ({ ...k, firstSeenMs: t(k.firstSeenMs), lastSeenMs: t(k.lastSeenMs) })),
      }
    case 'alert':
      return {
        ...event,
        timeMs: t(event.timeMs),
        alert: shiftAlert(event.alert, originMs),
        toneStartMs: tn(event.toneStartMs),
        speechStartMs: tn(event.speechStartMs),
      }
    case 'drop':
      return { ...event, timeMs: t(event.timeMs), alert: shiftAlert(event.alert, originMs) }
  }
}

function shiftAlert<A extends { frameTimeMs: number; createdTimeMs: number }>(alert: A, originMs: number): A {
  return { ...alert, frameTimeMs: alert.frameTimeMs - originMs, createdTimeMs: alert.createdTimeMs - originMs }
}

function round(value: unknown, digits: number): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(digits)) : value
  if (Array.isArray(value)) return value.map((v) => round(v, digits))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v, digits)]))
  }
  return value
}

/** One JSON line. Entries meant for reading (tracks, tilt) are rounded; the ones a replay needs keep full precision. */
export function encodeEvent(event: TelemetryEvent): string {
  const rounded = event.kind === 'tracks' || event.kind === 'orientation' ? round(event, 3) : event
  return JSON.stringify(rounded)
}

export class TelemetryLogger {
  private deps: LoggerDeps
  private cfg: TelemetryConfig
  private lines: string[] = []
  private bytes = 0
  private originMs = 0
  private active = false
  private full = false
  private nearFull = false
  private frameCount = 0
  private lastTracksMs = -Infinity
  private lastTracksEmpty = true
  private lastSampleMs = -Infinity
  private lastHealthKey = ''
  private timer: unknown = null
  private view: LoggerView = OFF
  private listeners = new Set<() => void>()

  constructor(deps: LoggerDeps) {
    this.deps = deps
    this.cfg = deps.cfg ?? CONFIG.telemetry
  }

  /** For useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getView = (): LoggerView => this.view

  getStats(): LoggerStats {
    return { entries: this.lines.length, bytes: this.bytes, maxBytes: this.cfg.maxBytes }
  }

  /** The recorded lines, oldest first, without line endings. */
  getLines(): readonly string[] {
    return this.lines
  }

  isActive(): boolean {
    return this.active
  }

  /**
   * Start a fresh log. `originMs` is the performance.now() time of the Start tap, so the log's clock matches the
   * on-screen session clock. Anything recorded before is discarded.
   */
  begin(meta: SessionMeta, originMs: number, config: Record<string, unknown> = JSON.parse(JSON.stringify(CONFIG))): void {
    this.stopTimer()
    this.lines = []
    this.bytes = 0
    this.full = false
    this.nearFull = false
    this.frameCount = 0
    this.lastTracksMs = -Infinity
    this.lastTracksEmpty = true
    this.lastSampleMs = -Infinity
    this.lastHealthKey = ''
    this.originMs = originMs
    this.active = true
    const now = this.deps.now()
    this.handle({
      kind: 'session',
      timeMs: now,
      version: LOG_VERSION,
      startedAtIso: new Date().toISOString(),
      config,
      ...meta,
    })
    this.handle({ kind: 'run-state', timeMs: now, state: 'running' })
    const setTimer = this.deps.setTimer ?? ((callback, ms) => setInterval(callback, ms))
    this.timer = setTimer(() => this.sampleOrientation(), this.cfg.orientationSampleMs)
    this.refreshView()
  }

  /** Stop recording; what was recorded stays available for export. */
  stop(): void {
    if (!this.active) return
    this.active = false
    this.stopTimer()
    this.refreshView()
  }

  /** Record one event stamped on the performance.now() clock. Ignored unless a log is running. */
  handle(event: TelemetryEvent): void {
    if (!this.active) return
    if (event.kind === 'frame' && this.frameCount++ % Math.max(1, this.cfg.frameLogEvery) !== 0) return
    if (event.kind === 'tracks' && !this.wantTracks(event)) return
    if (event.kind === 'health' && !this.healthChanged(event)) return
    this.push(encodeEvent(toSessionClock(event, this.originMs)))
  }

  private wantTracks(event: Extract<TelemetryEvent, { kind: 'tracks' }>): boolean {
    const empty = event.tracks.length === 0
    // An empty snapshot is worth one line (the objects are gone), not one per frame.
    if (empty && this.lastTracksEmpty) return false
    if (!empty && event.timeMs - this.lastTracksMs < this.cfg.trackSnapshotMs) return false
    this.lastTracksMs = event.timeMs
    this.lastTracksEmpty = empty
    return true
  }

  // The health monitor reports every few hundred ms; the log keeps the changes.
  private healthChanged(event: Extract<TelemetryEvent, { kind: 'health' }>): boolean {
    const { status, issues, paused, backend } = event.health
    const key = JSON.stringify([status, [...issues].sort(), paused, backend])
    if (key === this.lastHealthKey) return false
    this.lastHealthKey = key
    return true
  }

  private sampleOrientation(): void {
    const now = this.deps.now()
    const sample = this.deps.getOrientation(now)
    if (!sample || sample.timeMs === this.lastSampleMs) return
    this.lastSampleMs = sample.timeMs
    this.handle({ kind: 'orientation', timeMs: now, sample })
  }

  private push(line: string): void {
    if (this.full) return
    if (this.bytes + line.length + 1 > this.cfg.maxBytes) {
      this.full = true
      this.active = false
      this.stopTimer()
      // One last line says why the log ends here; it may go slightly over the cap.
      const message = 'The test log is full, so recording stopped. Save it now.'
      const end = JSON.stringify({ kind: 'error', timeMs: this.deps.now() - this.originMs, source: 'telemetry', message })
      this.lines.push(end)
      this.bytes += end.length + 1
      this.refreshView()
      return
    }
    this.lines.push(line)
    this.bytes += line.length + 1
    if (!this.nearFull && this.bytes >= this.cfg.maxBytes * this.cfg.warnAtFraction) {
      this.nearFull = true
      this.refreshView()
    } else if (this.lines.length === 1) {
      this.refreshView()
    }
  }

  private refreshView(): void {
    const status: LoggerStatus = this.full ? 'full' : !this.active ? 'off' : this.nearFull ? 'near-full' : 'recording'
    const message =
      status === 'full'
        ? 'The test log is full, so recording stopped. Save it now.'
        : status === 'near-full'
          ? 'The test log is almost full. Finish the walk and save it.'
          : null
    const hasLog = this.lines.length > 0
    if (status === this.view.status && hasLog === this.view.hasLog && message === this.view.message) return
    this.view = { status, hasLog, message }
    for (const listener of this.listeners) listener()
  }

  private stopTimer(): void {
    if (this.timer === null) return
    const clear = this.deps.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
    clear(this.timer)
    this.timer = null
  }
}
