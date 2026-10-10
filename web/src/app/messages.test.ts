import { describe, expect, test } from 'vitest'
import { CameraError } from '../camera/camera'
import { DetectionLoadError } from '../detection/engine'
import { describeStartFailure, MESSAGES } from './messages'

describe('describeStartFailure', () => {
  test('uses the camera error sentence', () => {
    expect(describeStartFailure(new CameraError('permission-denied'), null)).toBe(
      new CameraError('permission-denied').spoken,
    )
  })

  test('puts the camera problem before a detector problem', () => {
    const message = describeStartFailure(new CameraError('no-camera'), new DetectionLoadError('wasm-failed', 'x'))
    expect(message).toBe(new CameraError('no-camera').spoken)
  })

  test.each(['model-fetch-failed', 'webgpu-unavailable', 'wasm-failed', 'class-mismatch'] as const)(
    'has a sentence for the %s load error',
    (kind) => {
      const message = describeStartFailure(null, new DetectionLoadError(kind, 'detail'))
      expect(message.length).toBeGreaterThan(10)
      expect(message).not.toBe(MESSAGES.unknownFailure)
    },
  )

  test('falls back to a generic sentence for anything else', () => {
    expect(describeStartFailure(new Error('x'), null)).toBe(MESSAGES.unknownFailure)
  })
})

describe('safety wording', () => {
  test('no status sentence says the path is clear, safe, or free', () => {
    for (const text of Object.values(MESSAGES)) {
      expect(text).not.toMatch(/\b(clear|safe|free|all good|no obstacles)\b/i)
    }
  })
})
