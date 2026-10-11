import { describe, expect, test } from 'vitest'
import { CameraError } from '../camera/camera'
import type { CameraInfo, FrameSize } from '../camera/camera'
import { CONFIG } from '../core/config'
import type { FrameResult } from '../core/types'
import { DetectionLoadError } from '../detection/engine'
import type { EngineInfo } from '../detection/protocol'
import type { OrientationStatus } from '../sensors/orientation'
import { MESSAGES, runningMessage } from './messages'
import { Session } from './session'
import type { SchedulerHandlers } from './session'

const engineInfo: EngineInfo = {
  backend: 'wasm',
  fallbackReason: null,
  loadMs: 1,
  threads: 4,
  crossOriginIsolated: true,
  inputSize: 416,
}
const cameraInfo: CameraInfo = { label: 'Back Camera', frameSize: { width: 1280, height: 720 } }

function setup(
  options: {
    camera?: () => Promise<CameraInfo>
    engine?: () => Promise<EngineInfo>
    wakeLock?: boolean
    /** Status the tilt sensor reports right after it starts. */
    orientationOnStart?: OrientationStatus
  } = {},
) {
  const log: string[] = []
  let handlers: SchedulerHandlers | null = null
  let endedListener: (() => void) | null = null
  let sizeListener: ((size: FrameSize) => void) | null = null
  let orientationStatus: OrientationStatus = 'idle'
  const statusListeners = new Set<(status: OrientationStatus) => void>()
  const setOrientation = (status: OrientationStatus) => {
    if (status === orientationStatus) return
    orientationStatus = status
    for (const listener of statusListeners) listener(status)
  }
  const session = new Session({
    camera: {
      start: () => {
        log.push('camera.start')
        return (options.camera ?? (async () => cameraInfo))()
      },
      stop: () => log.push('camera.stop'),
      onFrameSize: (listener) => {
        sizeListener = listener
        return () => {}
      },
      onEnded: (listener) => {
        endedListener = listener
        return () => {}
      },
    },
    wakeLock: {
      acquire: async () => {
        log.push('wake.acquire')
        return options.wakeLock ?? true
      },
      release: async () => {
        log.push('wake.release')
      },
    },
    orientation: {
      requestPermission: async () => {
        log.push('orientation.permission')
        return options.orientationOnStart !== 'denied'
      },
      start: () => {
        log.push('orientation.start')
        setOrientation(options.orientationOnStart ?? 'waiting')
      },
      stop: () => {
        log.push('orientation.stop')
        setOrientation('idle')
      },
      getStatus: () => orientationStatus,
      onStatus: (listener) => {
        statusListeners.add(listener)
        return () => statusListeners.delete(listener)
      },
      latest: () => ({ pitchDeg: -5, rollDeg: 1, timeMs: 1 }),
      at: (timeMs) => ({ pitchDeg: -5, rollDeg: 1, timeMs }),
    },
    createEngine: () => ({
      init: (url, provider) => {
        log.push(`engine.init ${url} ${provider}`)
        return (options.engine ?? (async () => engineInfo))()
      },
      detect: async () => null,
      terminate: () => log.push('engine.terminate'),
    }),
    createScheduler: (_engine, h) => {
      handlers = h
      return { start: () => log.push('scheduler.start'), stop: () => log.push('scheduler.stop') }
    },
    now: () => 1234,
  })
  return {
    session,
    log,
    handlers: () => handlers!,
    ended: () => endedListener!(),
    resized: (size: FrameSize) => sizeListener!(size),
    setOrientation,
  }
}

describe('the free-space path request (R7)', () => {
  test('none while nothing asks for it', () => {
    const t = setup()
    expect(t.session.pathInputAt(500)).toBeUndefined()
    t.session.setPathSource(() => null)
    expect(t.session.pathInputAt(500)).toBeUndefined()
  })

  test('when asked, a frame carries the tilt from its capture time, the field of view, and the target column', () => {
    const t = setup()
    t.session.setPathSource(() => ({ targetX: 0.6, hfovDeg: 65 }))
    expect(t.session.pathInputAt(500)).toEqual({ pitchDeg: -5, hfovDeg: 65, targetX: 0.6 })
    t.session.setPathSource(() => ({ targetX: null, hfovDeg: 70 }))
    expect(t.session.pathInputAt(500)).toEqual({ pitchDeg: -5, hfovDeg: 70, targetX: null })
  })

  test('removing the source stops it', () => {
    const t = setup()
    t.session.setPathSource(() => ({ targetX: 0.5, hfovDeg: 65 }))
    t.session.setPathSource(null)
    expect(t.session.pathInputAt(500)).toBeUndefined()
  })
})

describe('start', () => {
  test('opens the camera, loads the configured model, and runs', async () => {
    const t = setup()
    await t.session.start()
    const snap = t.session.getSnapshot()
    expect(snap.state).toBe('running')
    expect(snap.message).toBe(MESSAGES.running)
    expect(snap.cameraLabel).toBe('Back Camera')
    expect(snap.engine).toEqual(engineInfo)
    expect(snap.frameSize).toEqual({ width: 1280, height: 720 })
    expect(t.log).toContain(`engine.init /models/yolo26n-${CONFIG.detection.inputSize}.onnx ${CONFIG.detection.provider}`)
    expect(t.log).toContain('scheduler.start')
    expect(t.session.getStartedAtMs()).toBe(1234)
  })

  test('asks for motion permission, the wake lock, and the camera before waiting on the detector', async () => {
    const t = setup()
    const started = t.session.start()
    expect(t.log.slice(0, 4)).toEqual([
      'orientation.permission',
      'wake.acquire',
      'camera.start',
      expect.stringContaining('engine.init'),
    ])
    await started
  })

  test('says so when the wake lock cannot be held, but still runs', async () => {
    const t = setup({ wakeLock: false })
    await t.session.start()
    expect(t.session.getSnapshot().state).toBe('running')
    expect(t.session.getSnapshot().message).toBe(runningMessage({ wakeLockHeld: false, tiltAvailable: true }))
    expect(t.session.getSnapshot().message).toMatch(/screen may lock/)
  })

  test('starts the tilt sensor when running and exposes its readings', async () => {
    const t = setup()
    await t.session.start()
    expect(t.log).toContain('orientation.start')
    expect(t.session.getOrientationAt(500)).toEqual({ pitchDeg: -5, rollDeg: 1, timeMs: 500 })
    expect(t.session.getOrientationLatest(10)?.pitchDeg).toBe(-5)
  })

  test('refused motion permission still runs, and the status line says distances are less accurate', async () => {
    const t = setup({ orientationOnStart: 'denied' })
    await t.session.start()
    const snap = t.session.getSnapshot()
    expect(snap.state).toBe('running')
    expect(snap.orientation).toBe('denied')
    expect(snap.message).toMatch(/tilt sensor is unavailable/)
    expect(snap.message).toMatch(/less accurate/)
  })

  test('the tilt sensor becoming unavailable while running updates the message, and recovery restores it', async () => {
    const t = setup()
    await t.session.start()
    expect(t.session.getSnapshot().message).toBe(MESSAGES.running)
    t.setOrientation('unavailable')
    expect(t.session.getSnapshot().message).toMatch(/tilt sensor is unavailable/)
    t.setOrientation('ready')
    expect(t.session.getSnapshot().message).toBe(MESSAGES.running)
    expect(t.session.getSnapshot().orientation).toBe('ready')
  })

  test('both problems are named in one sentence', async () => {
    const t = setup({ wakeLock: false, orientationOnStart: 'denied' })
    await t.session.start()
    const message = t.session.getSnapshot().message
    expect(message).toMatch(/screen may lock/)
    expect(message).toMatch(/tilt sensor/)
    expect(message.endsWith('.')).toBe(true)
  })

  test('a camera failure returns to idle with the spoken sentence and cleans up', async () => {
    const t = setup({
      camera: async () => {
        throw new CameraError('permission-denied')
      },
    })
    await t.session.start()
    const snap = t.session.getSnapshot()
    expect(snap.state).toBe('idle')
    expect(snap.message).toBe(new CameraError('permission-denied').spoken)
    expect(t.log).toContain('engine.terminate')
    expect(t.log).toContain('camera.stop')
    expect(t.log).not.toContain('scheduler.start')
  })

  test('a detector failure returns to idle and turns the camera off again', async () => {
    const t = setup({
      engine: async () => {
        throw new DetectionLoadError('model-fetch-failed', 'x')
      },
    })
    await t.session.start()
    expect(t.session.getSnapshot().state).toBe('idle')
    expect(t.session.getSnapshot().message).toMatch(/detector/)
    expect(t.log).toContain('camera.stop')
  })

  test('start can be pressed again after a failure', async () => {
    let fail = true
    const t = setup({
      camera: async () => {
        if (fail) throw new CameraError('camera-busy')
        return cameraInfo
      },
    })
    await t.session.start()
    fail = false
    await t.session.start()
    expect(t.session.getSnapshot().state).toBe('running')
  })

  test('a second start while running does nothing', async () => {
    const t = setup()
    await t.session.start()
    const count = t.log.length
    await t.session.start()
    expect(t.log.length).toBe(count)
  })
})

describe('pause and resume', () => {
  test('pause stops the loop, the camera, and the wake lock but keeps the detector', async () => {
    const t = setup()
    await t.session.start()
    t.log.length = 0
    t.session.pause()
    expect(t.session.getSnapshot().state).toBe('paused')
    expect(t.session.getSnapshot().message).toBe(MESSAGES.paused)
    expect(t.log).toEqual(['scheduler.stop', 'camera.stop', 'orientation.stop', 'wake.release'])
  })

  test('resume restarts the camera and the loop without reloading the detector', async () => {
    const t = setup()
    await t.session.start()
    t.session.pause()
    t.log.length = 0
    await t.session.resume()
    expect(t.session.getSnapshot().state).toBe('running')
    expect(t.log).toEqual(['wake.acquire', 'camera.start', 'scheduler.start', 'orientation.start'])
  })

  test('a failed resume stays paused with the reason, and can be tried again', async () => {
    let fail = false
    const t = setup({
      camera: async () => {
        if (fail) throw new CameraError('camera-busy')
        return cameraInfo
      },
    })
    await t.session.start()
    t.session.pause()
    fail = true
    await t.session.resume()
    expect(t.session.getSnapshot().state).toBe('paused')
    expect(t.session.getSnapshot().message).toBe(new CameraError('camera-busy').spoken)
    fail = false
    await t.session.resume()
    expect(t.session.getSnapshot().state).toBe('running')
  })
})

describe('page visibility', () => {
  test('hiding the page pauses, and showing it resumes automatically', async () => {
    const t = setup()
    await t.session.start()
    t.session.handleHidden()
    expect(t.session.getSnapshot().state).toBe('paused')
    expect(t.session.getSnapshot().message).toBe(MESSAGES.pausedHidden)
    t.session.handleVisible()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.session.getSnapshot().state).toBe('running')
  })

  test('a user pause is not undone by the page becoming visible again', async () => {
    const t = setup()
    await t.session.start()
    t.session.pause()
    t.session.handleHidden()
    t.session.handleVisible()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.session.getSnapshot().state).toBe('paused')
  })
})

describe('failures while running', () => {
  test('the camera ending by itself pauses with a message', async () => {
    const t = setup()
    await t.session.start()
    t.ended()
    expect(t.session.getSnapshot().state).toBe('paused')
    expect(t.session.getSnapshot().message).toBe(MESSAGES.cameraStopped)
  })

  test('detection stops only after repeated errors', async () => {
    const t = setup()
    await t.session.start()
    const max = CONFIG.detection.maxConsecutiveErrors
    t.handlers().onError(new Error('bad'), max - 1)
    expect(t.session.getSnapshot().state).toBe('running')
    t.handlers().onError(new Error('bad'), max)
    expect(t.session.getSnapshot().state).toBe('paused')
    expect(t.session.getSnapshot().message).toMatch(/repeated errors: bad/)
  })

  test('results are passed to listeners', async () => {
    const t = setup()
    await t.session.start()
    const seen: number[] = []
    t.session.onResult((r) => seen.push(r.frameId))
    t.handlers().onResult({ frameId: 7 } as FrameResult)
    expect(seen).toEqual([7])
  })

  test('rotating the phone updates the frame size', async () => {
    const t = setup()
    await t.session.start()
    t.resized({ width: 720, height: 1280 })
    expect(t.session.getSnapshot().frameSize).toEqual({ width: 720, height: 1280 })
  })
})

describe('shutdown', () => {
  test('releases everything and returns to idle', async () => {
    const t = setup()
    await t.session.start()
    t.log.length = 0
    t.session.shutdown()
    expect(t.session.getSnapshot().state).toBe('idle')
    expect(t.log).toEqual(['scheduler.stop', 'camera.stop', 'orientation.stop', 'wake.release', 'engine.terminate'])
  })

  test('shutting down while starting leaves no camera running', async () => {
    let finishCamera: (info: CameraInfo) => void = () => {}
    const t = setup({ camera: () => new Promise((resolve) => (finishCamera = resolve)) })
    const started = t.session.start()
    t.session.shutdown()
    finishCamera(cameraInfo)
    await started
    expect(t.session.getSnapshot().state).toBe('idle')
    expect(t.log.filter((l) => l === 'camera.stop').length).toBeGreaterThanOrEqual(2)
    expect(t.log).not.toContain('scheduler.start')
  })
})
