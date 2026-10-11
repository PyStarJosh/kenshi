import { afterEach, describe, expect, test, vi } from 'vitest'
import { Camera, CameraError, chooseBackCamera, mapCameraError } from './camera'

const device = (deviceId: string, label: string, kind: MediaDeviceKind = 'videoinput') => ({
  deviceId,
  label,
  kind,
})

describe('chooseBackCamera', () => {
  test('prefers the plain Back Camera over virtual multi-lens devices on an iPhone', () => {
    const devices = [
      device('triple', 'Back Triple Camera'),
      device('dual', 'Back Dual Camera'),
      device('ultra', 'Back Ultra Wide Camera'),
      device('plain', 'Back Camera'),
      device('front', 'Front Camera'),
    ]
    expect(chooseBackCamera(devices)).toBe('plain')
  })

  test('without a plain "Back Camera", takes a back device that is not a multi-lens or special lens', () => {
    const devices = [
      device('tele', 'camera2 2, facing back telephoto'),
      device('main', 'camera2 0, facing back'),
      device('front', 'camera2 1, facing front'),
    ]
    expect(chooseBackCamera(devices)).toBe('main')
  })

  test('returns null when only multi-lens back devices exist, so the caller keeps its stream', () => {
    expect(chooseBackCamera([device('t', 'Back Triple Camera'), device('f', 'Front Camera')])).toBeNull()
  })

  test('ignores audio devices and front cameras', () => {
    expect(chooseBackCamera([device('m', 'Back Camera', 'audioinput'), device('f', 'Front Camera')])).toBeNull()
  })

  test('returns null for an empty list', () => {
    expect(chooseBackCamera([])).toBeNull()
  })
})

describe('Camera without a video element', () => {
  // React detaches the element before a closing screen's cleanup runs, so stop() must cope.
  test('stop does not throw when the element is gone', () => {
    expect(() => new Camera(() => null).stop()).not.toThrow()
  })

  test('frameSize is null when the element is gone', () => {
    expect(new Camera(() => null).frameSize).toBeNull()
  })

  test('stop can be called repeatedly', () => {
    const camera = new Camera(() => null)
    camera.stop()
    expect(() => camera.stop()).not.toThrow()
  })
})

describe('mapCameraError', () => {
  const named = (name: string) => Object.assign(new Error('boom'), { name })

  test.each([
    ['NotAllowedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-camera'],
    ['OverconstrainedError', 'no-camera'],
    ['NotReadableError', 'camera-busy'],
    ['AbortError', 'camera-busy'],
    ['SomethingElse', 'unknown'],
  ])('%s becomes %s', (name, kind) => {
    expect(mapCameraError(named(name)).kind).toBe(kind)
  })

  test('every kind has one short spoken sentence', () => {
    for (const kind of ['permission-denied', 'no-camera', 'camera-busy', 'insecure-page', 'unknown'] as const) {
      const { spoken } = new CameraError(kind)
      expect(spoken.length).toBeGreaterThan(10)
      expect(spoken.endsWith('.')).toBe(true)
      expect(spoken.match(/\./g)).toHaveLength(1)
    }
  })

  test('passes a CameraError through unchanged and handles non-Error values', () => {
    const original = new CameraError('insecure-page')
    expect(mapCameraError(original)).toBe(original)
    expect(mapCameraError('text').kind).toBe('unknown')
  })
})

describe('one stream at start: the lens used last time is opened directly', () => {
  function fakeMedia(options: { failId?: string; failWith?: string } = {}) {
    const opened: MediaTrackConstraints[] = []
    const storage = new Map<string, string>()
    const track = (deviceId: string) => ({
      label: deviceId === 'plain' ? 'Back Camera' : 'Back Triple Camera',
      readyState: 'live',
      getSettings: () => ({ deviceId, width: 1280, height: 720 }),
      addEventListener: () => {},
      removeEventListener: () => {},
      stop: () => {},
    })
    const stream = (deviceId: string) => {
      const t = track(deviceId)
      return { getVideoTracks: () => [t], getTracks: () => [t] }
    }
    vi.stubGlobal('window', { isSecureContext: true })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async ({ video }: { video: MediaTrackConstraints }) => {
          opened.push(video)
          const exact = (video.deviceId as { exact?: string } | undefined)?.exact
          if (exact !== undefined && exact === options.failId) throw Object.assign(new Error('no'), { name: options.failWith })
          return stream(exact ?? 'triple')
        },
        enumerateDevices: async () => [
          { deviceId: 'triple', label: 'Back Triple Camera', kind: 'videoinput' },
          { deviceId: 'plain', label: 'Back Camera', kind: 'videoinput' },
        ],
      },
    })
    const video = {
      muted: false,
      playsInline: false,
      autoplay: false,
      srcObject: null as unknown,
      videoWidth: 1280,
      videoHeight: 720,
      paused: true,
      addEventListener: () => {},
      removeEventListener: () => {},
      play: async () => {
        video.paused = false
      },
    }
    const lensStore = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    }
    const camera = new Camera(() => video as unknown as HTMLVideoElement, lensStore)
    return { camera, opened, storage, video }
  }

  afterEach(() => vi.unstubAllGlobals())

  test('the first start finds the plain lens (two streams), and the next start opens it at once (one)', async () => {
    const t = fakeMedia()
    const first = await t.camera.start()
    expect(first.label).toBe('Back Camera')
    expect(t.opened).toHaveLength(2) // the default camera, then the plain lens
    t.camera.stop()
    t.opened.length = 0
    const second = await t.camera.start()
    expect(second.label).toBe('Back Camera')
    expect(t.opened).toEqual([expect.objectContaining({ deviceId: { exact: 'plain' } })])
  })

  test('a remembered lens that is gone is forgotten and the lens is chosen again', async () => {
    const t = fakeMedia({ failId: 'old', failWith: 'OverconstrainedError' })
    t.storage.set('kenshi.camera.lens.v1', 'old')
    await t.camera.start()
    expect(t.opened[0]).toMatchObject({ deviceId: { exact: 'old' } })
    expect(t.storage.get('kenshi.camera.lens.v1')).toBe('plain')
  })

  test('a refusal is not asked again with another camera: it is the error', async () => {
    const t = fakeMedia({ failId: 'plain', failWith: 'NotAllowedError' })
    t.storage.set('kenshi.camera.lens.v1', 'plain')
    await expect(t.camera.start()).rejects.toMatchObject({ kind: 'permission-denied' })
    expect(t.opened).toHaveLength(1)
  })

  test('the stream is live until stopped, and a kept stream plays again without opening a new one', async () => {
    const t = fakeMedia()
    await t.camera.start()
    expect(t.camera.isLive()).toBe(true)
    t.video.paused = true
    t.opened.length = 0
    const info = await t.camera.resumePlayback()
    expect(info.label).toBe('Back Camera')
    expect(t.video.paused).toBe(false)
    expect(t.opened).toEqual([])
    t.camera.stop()
    expect(t.camera.isLive()).toBe(false)
  })
})
