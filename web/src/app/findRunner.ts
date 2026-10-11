// The Find runner: the thin adapter between the pure Find controller (find/findController.ts) and the rest of the app.
// It turns bus events, clock ticks, and sensor readings into controller events, and carries out the controller's
// effects: speak (an AlertEvent on the bus, which the audio link plays), capture a sweep frame, and make a locate call.
// Nothing here decides anything; the rules are all in the reducer, where they are tested.
import { CONFIG } from '../core/config'
import type { EventMap, FindRequest, FindSnapshot, OrientationSample, Settings, Track } from '../core/types'
import type { EventBus } from '../alerts/bus'
import { initialContext, reduce, snapshotOf } from '../find/findController'
import type { FindContext, FindEffect, FindEvent, FrameMeta } from '../find/findController'
import type { Capture, LocateOutcome } from '../find/locateClient'
import { cleanTarget, findYoloSighting } from '../find/targets'
import type { FrameDims } from '../geometry/geometry'

export interface FindRunnerDeps {
  bus: EventBus<EventMap>
  /** The orientation at a moment (a frame's capture time), or null. */
  orientationAt: (timeMs: number) => OrientationSample | null
  orientationLatest: (nowMs: number) => OrientationSample | null
  /** True while detection is running (not idle, starting, or paused). */
  isRunning: () => boolean
  getTracks: () => readonly Track[]
  getSettings: () => Pick<Settings, 'eyeHeightM' | 'horizontalFovDeg'>
  /** The current camera frame as a bitmap, or null when there is none yet. */
  grab: () => Promise<ImageBitmap | null>
  locator: {
    locate: (target: string, captures: readonly Capture[]) => Promise<LocateOutcome>
    canLocate: () => boolean
  }
  now: () => number
  /** A soft tick sound, played when a sweep frame is captured. */
  tick: () => void
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

interface HeldFrame extends Capture {
  meta: FrameMeta
}

/** How often the controller is ticked besides once per detected frame, so timers run on a still camera. */
const TICK_MS = 250

/** A short line for the status text and the screen; the spoken words come from the controller. */
export function describeSnapshot(snapshot: FindSnapshot): string {
  const target = snapshot.target ?? ''
  switch (snapshot.state) {
    case 'idle':
      return ''
    case 'checking':
      return `Looking for ${target}...`
    case 'sweeping':
      return `Turn slowly to your right to look for ${target}.`
    case 'sweepChecking':
      return `Checking the pictures for ${target}...`
    case 'guiding':
      return snapshot.bearingDeg === null ? `Guiding to ${target}.` : `${target}: ${Math.abs(snapshot.bearingDeg)} degrees ${snapshot.bearingDeg >= 0 ? 'right' : 'left'}.`
    case 'lost':
      return `Lost the ${target}. Scanning.`
    case 'arrived':
      return `${target}: within reach.`
    case 'notFound':
      return `Could not find ${target} here.`
    case 'error':
      return "Find isn't available right now."
  }
}

export class FindRunner {
  private readonly deps: FindRunnerDeps
  private ctx: FindContext = initialContext()
  private held: HeldFrame[] = []
  private pendingCaptures: Promise<void>[] = []
  /** Bumped whenever held frames are thrown away, so a capture still in flight does not add its frame afterwards. */
  private generation = 0
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
    const timer = this.deps.setTimer(() => this.tickEvery(), TICK_MS)
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

  // The timer ticks too, but a repeating timer never needs to run while idle.
  private tickEvery(): void {
    this.tick()
  }

  private tick(): void {
    if (this.ctx.state === 'idle') return
    if (!this.deps.isRunning()) {
      this.cancel()
      return
    }
    const now = this.deps.now()
    this.dispatch({
      type: 'tick',
      nowMs: now,
      heading: this.deps.orientationLatest(now)?.headingDeg ?? null,
      yolo: findYoloSighting(this.ctx.target, this.deps.getTracks()),
      canLocate: this.deps.locator.canLocate(),
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
      prev.source === next.source
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
      if (effect.type === 'discardFrames') this.discard()
      else if (effect.type === 'capture') this.capture()
      else if (effect.type === 'locate') void this.locate(effect.id, effect.frames)
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

  private discard(): void {
    this.generation += 1
    for (const frame of this.held) frame.bitmap.close()
    this.held = []
  }

  /** Grab the camera frame with the heading and pitch it was taken at. */
  private async grabFrame(): Promise<HeldFrame | null> {
    const bitmap = await this.deps.grab()
    if (!bitmap) return null
    const sample = this.deps.orientationAt(this.deps.now())
    this.frameDims = { width: bitmap.width, height: bitmap.height }
    const heading = sample?.headingDeg ?? null
    const pitch = sample?.pitchDeg ?? null
    return { bitmap, heading: heading ?? 0, pitch: pitch ?? 0, meta: { heading, pitch } }
  }

  private capture(): void {
    this.deps.tick()
    const generation = this.generation
    const pending = this.grabFrame()
      .then((frame) => {
        if (!frame) return
        if (generation === this.generation) this.held.push(frame)
        else frame.bitmap.close()
      })
      .catch(() => undefined)
    this.pendingCaptures.push(pending)
  }

  private async locate(id: number, which: 'current' | 'sweep'): Promise<void> {
    const target = this.ctx.target
    let frames: HeldFrame[]
    if (which === 'sweep') {
      await Promise.all(this.pendingCaptures)
      this.pendingCaptures = []
      frames = this.held
      this.held = []
    } else {
      let frame: HeldFrame | null = null
      try {
        frame = await this.grabFrame()
      } catch {
        frame = null
      }
      frames = frame ? [frame] : []
    }
    if (frames.length === 0) {
      this.dispatch({ type: 'failed', id, nowMs: this.deps.now(), code: 'bad_request' })
      return
    }
    const outcome = await this.deps.locator.locate(target, frames)
    for (const frame of frames) frame.bitmap.close()
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
      frames: frames.map((f) => f.meta),
    })
  }
}
