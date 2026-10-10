// User settings and calibration, kept on the device. validateSettings is pure; SettingsStore adds
// persistence and change notification.
import { CONFIG } from '../core/config'
import type { Settings } from '../core/types'

const STORAGE_KEY = 'kenshi.settings.v1'

export const DEFAULT_SETTINGS: Settings = {
  eyeHeightM: CONFIG.geometry.defaultEyeHeightM,
  horizontalFovDeg: CONFIG.geometry.defaultHorizontalFovDeg,
  speechRate: CONFIG.settings.speechRate,
  spokenFeedback: true,
  toneVolume: CONFIG.settings.toneVolume,
  heartbeatVolume: CONFIG.settings.heartbeatVolume,
  testMode: false,
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Turn anything (including a corrupt or old saved value) into a complete, in-range Settings. */
export function validateSettings(raw: unknown): Settings {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const g = CONFIG.geometry
  const d = DEFAULT_SETTINGS
  return {
    eyeHeightM: number(input.eyeHeightM, d.eyeHeightM, g.minEyeHeightM, g.maxEyeHeightM),
    horizontalFovDeg: number(input.horizontalFovDeg, d.horizontalFovDeg, g.minFovDeg, g.maxFovDeg),
    speechRate: number(input.speechRate, d.speechRate, CONFIG.audio.speechRateMin, CONFIG.audio.speechRateMax),
    spokenFeedback: flag(input.spokenFeedback, d.spokenFeedback),
    toneVolume: number(input.toneVolume, d.toneVolume, 0, 1),
    heartbeatVolume: number(input.heartbeatVolume, d.heartbeatVolume, 0, 1),
    testMode: flag(input.testMode, d.testMode),
  }
}

/** The part of localStorage the store needs. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export class SettingsStore {
  private storage: StorageLike | null
  private current: Settings
  private listeners = new Set<() => void>()

  constructor(storage: StorageLike | null) {
    this.storage = storage
    this.current = this.load()
  }

  /** For useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): Settings => this.current

  /** Change some settings; values are clamped to their allowed range, then saved. */
  update(patch: Partial<Settings>): void {
    this.current = validateSettings({ ...this.current, ...patch })
    this.save()
    for (const listener of this.listeners) listener()
  }

  reset(): void {
    this.update({ ...DEFAULT_SETTINGS })
  }

  private load(): Settings {
    try {
      const text = this.storage?.getItem(STORAGE_KEY)
      return validateSettings(text ? JSON.parse(text) : null)
    } catch {
      // Unreadable or blocked storage (private mode) or corrupt JSON: start from the defaults.
      return { ...DEFAULT_SETTINGS }
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.current))
    } catch {
      // Storage is full or blocked; the settings still apply for this session.
    }
  }
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The app's one settings store. */
export const settingsStore = new SettingsStore(browserStorage())
