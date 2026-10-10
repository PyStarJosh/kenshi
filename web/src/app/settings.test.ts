import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { DEFAULT_SETTINGS, SettingsStore, validateSettings } from './settings'
import type { StorageLike } from './settings'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('validateSettings', () => {
  test('nothing at all gives the defaults, which match config', () => {
    expect(validateSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.eyeHeightM).toBe(1.6)
    expect(DEFAULT_SETTINGS.horizontalFovDeg).toBe(CONFIG.geometry.defaultHorizontalFovDeg)
  })

  test('keeps good values', () => {
    const s = validateSettings({ eyeHeightM: 1.45, horizontalFovDeg: 70, spokenFeedback: false })
    expect(s.eyeHeightM).toBe(1.45)
    expect(s.horizontalFovDeg).toBe(70)
    expect(s.spokenFeedback).toBe(false)
  })

  test('clamps out-of-range numbers', () => {
    const s = validateSettings({ eyeHeightM: 9, horizontalFovDeg: 5, toneVolume: 3, speechRate: 0 })
    expect(s.eyeHeightM).toBe(CONFIG.geometry.maxEyeHeightM)
    expect(s.horizontalFovDeg).toBe(CONFIG.geometry.minFovDeg)
    expect(s.toneVolume).toBe(1)
    expect(s.speechRate).toBe(CONFIG.audio.speechRateMin)
  })

  test('replaces values of the wrong type with the defaults', () => {
    const s = validateSettings({ eyeHeightM: '1.7', horizontalFovDeg: Number.NaN, testMode: 'yes' })
    expect(s.eyeHeightM).toBe(DEFAULT_SETTINGS.eyeHeightM)
    expect(s.horizontalFovDeg).toBe(DEFAULT_SETTINGS.horizontalFovDeg)
    expect(s.testMode).toBe(false)
  })

  test('ignores unknown fields and non-objects', () => {
    expect(validateSettings({ extra: 1 })).toEqual(DEFAULT_SETTINGS)
    expect(validateSettings('text')).toEqual(DEFAULT_SETTINGS)
    expect(validateSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
  })
})

describe('SettingsStore', () => {
  test('starts from the defaults when nothing is saved', () => {
    expect(new SettingsStore(memoryStorage()).getSnapshot()).toEqual(DEFAULT_SETTINGS)
  })

  test('update saves, and a new store reads the saved values back', () => {
    const storage = memoryStorage()
    new SettingsStore(storage).update({ eyeHeightM: 1.5, horizontalFovDeg: 63.4 })
    const again = new SettingsStore(storage).getSnapshot()
    expect(again.eyeHeightM).toBe(1.5)
    expect(again.horizontalFovDeg).toBe(63.4)
  })

  test('update clamps before saving', () => {
    const storage = memoryStorage()
    const store = new SettingsStore(storage)
    store.update({ eyeHeightM: 50 })
    expect(store.getSnapshot().eyeHeightM).toBe(CONFIG.geometry.maxEyeHeightM)
    expect(JSON.parse(storage.data['kenshi.settings.v1']).eyeHeightM).toBe(CONFIG.geometry.maxEyeHeightM)
  })

  test('listeners hear about changes, and the snapshot changes identity', () => {
    const store = new SettingsStore(memoryStorage())
    let calls = 0
    const stop = store.subscribe(() => calls++)
    const before = store.getSnapshot()
    store.update({ eyeHeightM: 1.7 })
    expect(calls).toBe(1)
    expect(store.getSnapshot()).not.toBe(before)
    stop()
    store.update({ eyeHeightM: 1.8 })
    expect(calls).toBe(1)
  })

  test('reset restores the defaults', () => {
    const store = new SettingsStore(memoryStorage())
    store.update({ eyeHeightM: 1.3, horizontalFovDeg: 80 })
    store.reset()
    expect(store.getSnapshot()).toEqual(DEFAULT_SETTINGS)
  })

  test('corrupt saved JSON falls back to the defaults', () => {
    const store = new SettingsStore(memoryStorage({ 'kenshi.settings.v1': '{not json' }))
    expect(store.getSnapshot()).toEqual(DEFAULT_SETTINGS)
  })

  test('storage that throws never breaks the store', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const store = new SettingsStore(broken)
    expect(store.getSnapshot()).toEqual(DEFAULT_SETTINGS)
    store.update({ eyeHeightM: 1.7 })
    expect(store.getSnapshot().eyeHeightM).toBe(1.7)
  })

  test('works with no storage at all', () => {
    const store = new SettingsStore(null)
    store.update({ eyeHeightM: 1.4 })
    expect(store.getSnapshot().eyeHeightM).toBe(1.4)
  })
})
