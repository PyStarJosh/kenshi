// The Find runner: the thin adapter between the pure Find controller (find/findController.ts) and the rest of the app.
// It turns bus events, clock ticks, and sensor readings into controller events, and carries out the controller's
// effects: speak (an AlertEvent on the bus, which the audio link plays), look for the target in the current frame,
// and capture a sweep frame and send it on its own. Nothing here decides anything; the rules are all in the reducer,
// where they are tested.
import { CONFIG } from '../core/config'
import type { EventMap, FindRequest, FindSnapshot, OrientationSample, Settings, Track } from '../core/types'
import type { EventBus } from '../alerts/bus'
import { initialContext, reduce, sameObjectGateDeg, snapshotOf } from '../find/findController'
import type { FindContext, FindEffect, FindEvent, FrameMeta } from '../find/findController'
import type { Capture, LocateOptions, LocateOutcome } from '../find/locateClient'
import { bearing } from '../find/targetMemory'
import { cleanTarget, findYoloSighting } from '../find/targets'
import type { FrameDims } from '../geometry/geometry'
import { targetColumn } from '../geometry/pathInput'

export interface FindRunnerDeps {
  bus: EventBus<EventMap>
  /** The orientation at a moment (a frame's capture time), or null. */
  orientationAt: (timeMs: number) => OrientationSample | null
  orientationLatest: (nowMs: number) => OrientationSample | null
  /** True while detection is running (not idle, starting, or paused). */
  isRunning: () => boolean
  getTracks: () => readonly Track[]
  /** What the path line (R7) says about the way ahead now, or null; absent where there is no path line. */
  getPathDecision?: (nowMs: number) => 'left' | 'right' | 'straight' | null
  getSettings: () => Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>
  /** The current camera frame as a bitmap, or null when there is none yet. */
  grab: () => Promise<ImageBitmap | null>
  locator: {
    locate: (target: string, captures: readonly Capture[], options?: LocateOptions) => Promise<LocateOutcome>
    canLocate: (paced?: boolean) => boolean
  }
  now: () => number
  /** A soft tick sound, played when a sweep frame is captured. */
  tick: () => void
  /** True while a phrase is waiting or being spoken, so guidance does not queue up behind it. */
  isSpeaking?: () => boolean
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

interface Grabbed extends Capture {
  meta: FrameMeta
}

/** How often the controller is ticked besides once per detected frame, so timers run on a still camera. */
const TICK_MS = 250

export class FindRunner {
  private readonly deps: FindRunnerDeps
  private ctx: FindContext = initialContext()
  private frameDims: FrameDims = { width: 1280, height: 720 }
  private alertCount = 0
  private snapshot: FindSnapshot = snapshotOf(initialContext(), null)
  private listeners = new Set<() => void>()

  constructor(deps: FindRunnerDeps) {
    this.deps = deps
  }

  /** Listen to the bus and run the tick timer. Returns a function that undoes it. */
  attach(): () => void {
    const { bus } = this.deps
    const timer = this.deps.setTimer(() => this.tick(), TICK_MS)
    const stops = [
      bus.subscribe('findRequest', (request: FindRequest) => this.request(request.target)),
      bus.subscribe('findCancel', () => this.cancel()),
      bus.subscribe('tracks', () => this.tick()),
    ]
    return () => {
      for (const stop of stops) stop()
      this.deps.clearTimer(timer)
      this.cancel()
    }
  }

  isActive(): boolean {
    return this.ctx.state !== 'idle'
  }

  /**
   * Where the target is in the picture, from 0 (left edge) to 1 (right edge), for steering the path line toward it;
   * null unless it is being guided to and is inside the field of view.
   */
  getTargetColumn(): number | null {
    const { memory } = this.ctx
    if (this.ctx.state !== 'guiding' || memory === null) return null
    const heading = this.deps.orientationLatest(this.deps.now())?.headingDeg
    if (heading === undefined) return null
    const hfovDeg = this.deps.getSettings().horizontalFovDeg
    return targetColumn(bearing(memory, heading), hfovDeg)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): FindSnapshot => this.snapshot

  /** Start looking for a target (from the quick-pick list or a voice command). */
  request(target: string): void {
    const now = this.deps.now()
    const sample = this.deps.orientationLatest(now)
    this.dispatch({
      type: 'request',
      target,
      nowMs: now,
      heading: sample?.headingDeg ?? null,
      yolo: findYoloSighting(cleanTarget(target), this.deps.getTracks()),
    })
  }

  cancel(): void {
    this.dispatch({ type: 'cancel' })
  }

  private tick(): void {
    if (this.ctx.state === 'idle') return
    if (!this.deps.isRunning()) {
      this.cancel()
      return
    }
    const now = this.deps.now()
    const heading = this.deps.orientationLatest(now)?.headingDeg ?? null
    // The path line speaks only while the target is roughly straight ahead; elsewhere "turn" comes first.
    const pathDecision =
      this.ctx.state === 'guiding' && this.ctx.memory !== null && heading !== null &&
      Math.abs(bearing(this.ctx.memory, heading)) <= CONFIG.find.pathAlignedDeg
        ? this.deps.getPathDecision?.(now) ?? null
        : null
    // While guiding, a track other than the followed one counts only if it is where the remembered object is.
    const { memory } = this.ctx
    const near =
      this.ctx.state === 'guiding' && memory !== null && heading !== null
        ? { angleDeg: bearing(memory, heading), maxDeg: sameObjectGateDeg(memory, CONFIG.find) }
        : null
    this.dispatch({
      type: 'tick',
      nowMs: now,
      heading,
      yolo: findYoloSighting(this.ctx.target, this.deps.getTracks(), this.ctx.followId, near),
      canLocate: this.deps.locator.canLocate(true),
      canLook: this.deps.locator.canLocate(false),
      pitch: this.deps.orientationLatest(now)?.pitchDeg ?? null,
      pathDecision,
      speaking: this.deps.isSpeaking?.() ?? false,
    })
  }

  private dispatch(event: FindEvent): void {
    const settings = this.deps.getSettings()
    const env = { hfovDeg: settings.horizontalFovDeg, eyeHeightM: settings.eyeHeightM, frame: this.frameDims }
    const step = reduce(this.ctx, event, env, CONFIG.find)
    this.ctx = step.ctx
    this.run(step.effects)
    this.publish()
  }

  private publish(): void {
    const now = this.deps.now()
    const next = snapshotOf(this.ctx, this.deps.orientationLatest(now)?.headingDeg ?? null)
    if (next.bearingDeg !== null) next.bearingDeg = Math.round(next.bearingDeg)
    const prev = this.snapshot
    if (
      prev.state === next.state &&
      prev.target === next.target &&
      prev.bearingDeg === next.bearingDeg &&
      prev.distanceM === next.distanceM &&
      prev.distanceIsBound === next.distanceIsBound &&
      prev.source === next.source &&
      prev.sweepFrames === next.sweepFrames
    ) {
      return
    }
    this.snapshot = next
    for (const listener of this.listeners) listener()
    this.deps.bus.publish('find', next)
  }

  private run(effects: FindEffect[]): void {
    // Everything said in one step goes out as one phrase, so the audio queue never drops half of it.
    const text = effects
      .filter((e): e is Extract<FindEffect, { type: 'speak' }> => e.type === 'speak')
      .map((e) => e.text)
      .join(' ')
    if (text) this.speak(text)
    for (const effect of effects) {
      if (effect.type === 'capture') this.capture(effect.id)
      else if (effect.type === 'locate') void this.look(effect.id, effect.paced)
    }
  }

  private speak(text: string): void {
    const now = this.deps.now()
    this.alertCount += 1
    this.deps.bus.publish('alert', {
      id: `find-${this.alertCount}`,
      kind: 'find',
      priority: 'normal',
      trackId: null,
      phrase: text,
      pan: null,
      frameTimeMs: now,
      createdTimeMs: now,
    })
  }

  /** Grab the camera frame with the heading and pitch it was taken at. */
  private async grabFrame(): Promise<Grabbed | null> {
    // The heading belongs to the moment the frame is taken, which is when the grab starts, not when it finishes: the
    // phone may turn a few degrees while the bitmap is made.
    const sample = this.deps.orientationAt(this.deps.now())
    const bitmap = await this.deps.grab()
    if (!bitmap) return null
    this.frameDims = { width: bitmap.width, height: bitmap.height }
    const heading = sample?.headingDeg ?? null
    const pitch = sample?.pitchDeg ?? null
    return { bitmap, heading: heading ?? 0, pitch: pitch ?? 0, meta: { heading, pitch } }
  }

  /** A sweep frame: a soft tick now, then the frame is sent on its own so the first look that finds it ends the search. */
  private capture(id: number): void {
    this.deps.tick()
    void this.sendFrame(id, false)
  }

  /** The first check, a re-check, or a pause look: a fresh frame, sent on its own. */
  private look(id: number, paced: boolean): Promise<void> {
    return this.sendFrame(id, paced)
  }

  private async sendFrame(id: number, paced: boolean): Promise<void> {
    let frame: Grabbed | null = null
    try {
      frame = await this.grabFrame()
    } catch {
      frame = null
    }
    if (frame === null) {
      this.dispatch({ type: 'failed', id, nowMs: this.deps.now(), code: 'bad_request' })
      return
    }
    // Cancelled or replaced while the frame was being grabbed: do not spend a call on it.
    if (!this.ctx.sweepPending.includes(id) && this.ctx.pending !== id) {
      frame.bitmap.close()
      return
    }
    const outcome = await this.deps.locator.locate(this.ctx.target, [frame], { paced })
    frame.bitmap.close()
    const nowMs = this.deps.now()
    if (!outcome.ok) {
      this.dispatch({ type: 'failed', id, nowMs, code: outcome.error })
      return
    }
    this.dispatch({
      type: 'located',
      id,
      nowMs,
      heading: this.deps.orientationLatest(nowMs)?.headingDeg ?? null,
      result: outcome.result,
      frames: [frame.meta],
    })
  }
}
