// The facts about a run that go at the top of a test log. Browser-only: it reads navigator and screen.
import { CONFIG } from '../core/config'
import type { DeviceInfo, InferenceBackend, Settings } from '../core/types'
import { modelUrl } from '../detection/models'
import type { SessionMeta } from './logger'

export function deviceInfo(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    language: nav.language,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
  }
}

export function buildSessionMeta(engine: { backend: InferenceBackend; inputSize: number } | null, settings: Settings): SessionMeta {
  const inputSize = engine?.inputSize ?? CONFIG.detection.inputSize
  return {
    appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
    gitCommit: typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : 'unknown',
    model: modelUrl(inputSize).split('/').pop() ?? 'unknown',
    provider: CONFIG.detection.provider,
    backend: engine?.backend ?? null,
    inputSize,
    crossOriginIsolated: window.crossOriginIsolated,
    settings,
    device: deviceInfo(),
  }
}
