import { describe, expect, test } from 'vitest'
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
