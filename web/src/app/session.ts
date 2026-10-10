// Session: owns the live run. Start opens the camera, loads the detector, and starts the frame loop;
// pause, hide, and shutdown stop them again. The UI only talks to this class.
import { Camera } from '../camera/camera'
import type { CameraInfo, FrameSize } from '../camera/camera'
import { createBitmapGrabber, createFrameRequester, FrameScheduler } from '../camera/scheduler'
import { WakeLock } from '../camera/wakeLock'
import { CONFIG } from '../core/config'
import type { FrameResult, OrientationSample } from '../core/types'
import { DetectionEngine } from '../detection/engine'
import { modelUrl } from '../detection/models'
import type { EngineInfo, ProviderChoice } from '../detection/protocol'
import { createOrientationSensor } from '../sensors/orientation'
import type { OrientationStatus } from '../sensors/orientation'
import { describeDetectionStopped, describeStartFailure, MESSAGES, runningMessage } from './messages'

export type SessionState = 'idle' | 'starting' | 'running' | 'paused'

export interface SessionSnapshot {
  state: SessionState
  /** The sentence for the status line. */
  message: string
  frameSize: FrameSize | null
  engine: EngineInfo | null
  cameraLabel: string | null
  /** State of the tilt sensor; "denied" or "unavailable" means geometry is degraded. */
  orientation: OrientationStatus
}

export interface OrientationLike {
  requestPermission(): Promise<boolean>
  start(): void
  stop(): void
  getStatus(): OrientationStatus
  onStatus(listener: (status: OrientationStatus) => void): () => void
  latest(nowMs: number): OrientationSample | null
  at(timeMs: number): OrientationSample | null
}

export interface CameraLike {
  start(): Promise<CameraInfo>
  stop(): void
  onFrameSize(listener: (size: FrameSize) => void): () => void
  onEnded(listener: () => void): () => void
}

export interface WakeLockLike {
  acquire(): Promise<boolean>
  release(): Promise<void>
}

export interface EngineLike {
  init(modelUrl: string, provider: ProviderChoice): Promise<EngineInfo>
  detect(bitmap: ImageBitmap, frameId: number, captureTimeMs: number): Promise<FrameResult | null>
  terminate(): void
}

export interface SchedulerLike {
  start(): void
  stop(): void
}

export interface SchedulerHandlers {
  onResult: (result: FrameResult) => void
  onError: (error: unknown, consecutiveErrors: number) => void
}

export interface SessionDeps {
  camera: CameraLike
  wakeLock: WakeLockLike
  orientation: OrientationLike
  createEngine: () => EngineLike
  createScheduler: (engine: EngineLike, handlers: SchedulerHandlers) => SchedulerLike
  now: () => number
}

const IDLE: SessionSnapshot = {
  state: 'idle',
  message: MESSAGES.idle,
  frameSize: null,
  engine: null,
  cameraLabel: null,
  orientation: 'idle',
}

export class Session {
  private deps: SessionDeps
  private snapshot: SessionSnapshot = IDLE
  private listeners = new Set<() => void>()
  private resultListeners = new Set<(result: FrameResult) => void>()
  private engine: EngineLike | null = null
  private scheduler: SchedulerLike | null = null
  private startedAtMs: number | null = null
  private hidden = false
  private resumeWhenVisible = false
  private wakeLockHeld = true

  constructor(deps: SessionDeps) {
    this.deps = deps
    // The camera and sensor belong to this session, so these listeners live as long as it does.
    deps.camera.onFrameSize((frameSize) => this.update({ frameSize }))
    deps.camera.onEnded(() => this.handleCameraEnded())
    deps.orientation.onStatus((orientation) => this.handleOrientationStatus(orientation))
  }

  /** The tilt reading closest to a moment (a frame's capture time), or null if there is none. */
  getOrientationAt(timeMs: number): OrientationSample | null {
    return this.deps.orientation.at(timeMs)
  }

  /** The newest tilt reading, or null if there is none or it is stale. */
  getOrientationLatest(nowMs: number): OrientationSample | null {
    return this.deps.orientation.latest(nowMs)
  }

  /** For useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SessionSnapshot => this.snapshot

  onResult(listener: (result: FrameResult) => void): () => void {
    this.resultListeners.add(listener)
    return () => this.resultListeners.delete(listener)
  }

  /** When Start was tapped, in performance.now() milliseconds; null before the first Start. */
  getStartedAtMs(): number | null {
    return this.startedAtMs
  }

  /** Call from the Start tap. Everything that needs the user gesture is requested first. */
  async start(): Promise<void> {
    if (this.snapshot.state !== 'idle') return
    // iOS only shows the motion-sensor prompt for a user gesture, so ask before anything else.
    const motion = this.deps.orientation.requestPermission()
    this.update({ state: 'starting', message: MESSAGES.starting })
    this.startedAtMs = this.deps.now()
    const engine = this.deps.createEngine()
    this.engine = engine
    const lock = this.deps.wakeLock.acquire()
    const [camera, detector] = await Promise.allSettled([
      this.deps.camera.start(),
      engine.init(modelUrl(CONFIG.detection.inputSize), CONFIG.detection.provider),
    ])
    const wakeLockHeld = await lock
    await motion // a refusal shows up as the sensor status "denied", which run() reports
    if (this.engine !== engine) {
      // Shut down while starting: undo whatever the start managed to open.
      this.deps.camera.stop()
      void this.deps.wakeLock.release()
      return
    }
    if (camera.status === 'rejected' || detector.status === 'rejected') {
      this.releaseEverything()
      this.update({
        ...IDLE,
        message: describeStartFailure(
          camera.status === 'rejected' ? camera.reason : null,
          detector.status === 'rejected' ? detector.reason : null,
        ),
      })
      return
    }
    this.update({ engine: detector.value, cameraLabel: camera.value.label, frameSize: camera.value.frameSize })
    this.run(engine, wakeLockHeld)
    if (this.hidden) this.pause('hidden')
  }

  pause(reason: 'user' | 'hidden' = 'user'): void {
    if (this.snapshot.state !== 'running') return
    this.resumeWhenVisible = reason === 'hidden'
    this.stopLoop()
    this.update({ state: 'paused', message: reason === 'hidden' ? MESSAGES.pausedHidden : MESSAGES.paused })
  }

  async resume(): Promise<void> {
    if (this.snapshot.state !== 'paused' || !this.engine) return
    this.resumeWhenVisible = false
    const engine = this.engine
    this.update({ state: 'starting', message: MESSAGES.resuming })
    const lock = this.deps.wakeLock.acquire()
    try {
      const info = await this.deps.camera.start()
      const wakeLockHeld = await lock
      if (this.engine !== engine) {
        this.deps.camera.stop()
        void this.deps.wakeLock.release()
        return
      }
      this.update({ cameraLabel: info.label, frameSize: info.frameSize })
      this.run(engine, wakeLockHeld)
    } catch (error) {
      await lock
      void this.deps.wakeLock.release()
      this.update({ state: 'paused', message: describeStartFailure(error, null) })
    }
  }

  /** The page went to the background (iOS stops the camera there anyway). */
  handleHidden(): void {
    this.hidden = true
    this.pause('hidden')
  }

  handleVisible(): void {
    this.hidden = false
    if (this.resumeWhenVisible) void this.resume()
  }

  /** Stop everything and return to idle. The session can be started again. */
  shutdown(): void {
    this.releaseEverything()
    this.resumeWhenVisible = false
    this.update({ ...IDLE })
  }

  private run(engine: EngineLike, wakeLockHeld: boolean): void {
    this.scheduler = this.deps.createScheduler(engine, {
      onResult: (result) => {
        for (const listener of this.resultListeners) listener(result)
      },
      onError: (error, consecutive) => {
        if (consecutive < CONFIG.detection.maxConsecutiveErrors) return
        this.stopLoop()
        this.update({ state: 'paused', message: describeDetectionStopped(error) })
      },
    })
    this.scheduler.start()
    this.wakeLockHeld = wakeLockHeld
    this.deps.orientation.start()
    const orientation = this.deps.orientation.getStatus()
    this.update({ state: 'running', orientation, message: this.runningText(orientation) })
  }

  private runningText(orientation: OrientationStatus): string {
    return runningMessage({
      wakeLockHeld: this.wakeLockHeld,
      tiltAvailable: orientation !== 'denied' && orientation !== 'unavailable',
    })
  }

  /** The tilt sensor changed state: keep the snapshot current and, while running, say what is wrong. */
  private handleOrientationStatus(orientation: OrientationStatus): void {
    if (this.snapshot.state === 'running') {
      this.update({ orientation, message: this.runningText(orientation) })
    } else {
      this.update({ orientation })
    }
  }

  private handleCameraEnded(): void {
    if (this.snapshot.state !== 'running') return
    this.stopLoop()
    this.update({ state: 'paused', message: MESSAGES.cameraStopped })
  }

  /** Stop the frame loop, the camera, the tilt sensor, and the wake lock; keep the loaded detector. */
  private stopLoop(): void {
    this.scheduler?.stop()
    this.scheduler = null
    this.deps.camera.stop()
    this.deps.orientation.stop()
    void this.deps.wakeLock.release()
  }

  private releaseEverything(): void {
    this.stopLoop()
    this.engine?.terminate()
    this.engine = null
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
}

/** Build a session wired to the real camera, detector, and wake lock. */
export function createSession(getVideo: () => HTMLVideoElement | null): Session {
  return new Session({
    camera: new Camera(getVideo),
    wakeLock: new WakeLock(),
    orientation: createOrientationSensor(),
    createEngine: () => new DetectionEngine(),
    createScheduler: (engine, handlers) => {
      const video = getVideo()
      if (!video) throw new Error('The video element is not mounted')
      return new FrameScheduler({
        maxFps: CONFIG.detection.maxFps,
        frameGapTolerance: CONFIG.detection.frameGapTolerance,
        requestFrame: createFrameRequester(video),
        grab: createBitmapGrabber(video),
        detect: (bitmap, frameId, captureTimeMs) => engine.detect(bitmap, frameId, captureTimeMs),
        now: () => performance.now(),
        ...handlers,
      })
    },
    now: () => performance.now(),
  })
}
