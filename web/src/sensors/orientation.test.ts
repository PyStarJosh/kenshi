import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CONFIG } from '../core/config'
import { OrientationSensor } from './orientation'
import type { OrientationDeps, OrientationStatus } from './orientation'

function setup(overrides: Partial<OrientationDeps> = {}) {
  let time = 0
  const handlers = new Set<(event: Event) => void>()
  const sensor = new OrientationSensor({
    target: {
      addEventListener: (_type, handler) => handlers.add(handler as (event: Event) => void),
      removeEventListener: (_type, handler) => handlers.delete(handler as (event: Event) => void),
    },
    now: () => time,
    screenAngle: () => 90,
    requestPermission: undefined,
    ...overrides,
  })
  return {
    sensor,
    handlers,
    /** Deliver a reading at a given time. Sideways and level is beta 0, gamma -90. */
    emit(beta: number | null, gamma: number | null, atMs: number) {
      time = atMs
      for (const handler of [...handlers]) handler({ beta, gamma } as unknown as Event)
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('permission', () => {
  test('where the browser does not ask, permission is granted', async () => {
    expect(await setup().sensor.requestPermission()).toBe(true)
  })

  test('granted', async () => {
    const t = setup({ requestPermission: async () => 'granted' })
    expect(await t.sensor.requestPermission()).toBe(true)
    t.sensor.start()
    expect(t.sensor.getStatus()).toBe('waiting')
  })

  test('denied: reports denied, never listens, and stays denied after stop', async () => {
    const t = setup({ requestPermission: async () => 'denied' })
    expect(await t.sensor.requestPermission()).toBe(false)
    expect(t.sensor.getStatus()).toBe('denied')
    t.sensor.start()
    expect(t.handlers.size).toBe(0)
    t.sensor.stop()
    expect(t.sensor.getStatus()).toBe('denied')
  })

  test('a prompt that throws counts as denied', async () => {
    const t = setup({
      requestPermission: async () => {
        throw new Error('needs a user gesture')
      },
    })
    expect(await t.sensor.requestPermission()).toBe(false)
    expect(t.sensor.getStatus()).toBe('denied')
  })
})

describe('readings', () => {
  test('the first reading is used as is and the status becomes ready', () => {
    const t = setup()
    const seen: OrientationStatus[] = []
    t.sensor.onStatus((s) => seen.push(s))
    t.sensor.start()
    t.emit(5, -80, 100)
    const sample = t.sensor.latest(100)!
    expect(sample.pitchDeg).toBeCloseTo(-9.96, 1)
    expect(sample.rollDeg).toBeCloseTo(5.08, 1)
    expect(sample.timeMs).toBe(100)
    expect(seen).toEqual(['waiting', 'ready'])
  })

  test('later readings are smoothed', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -90, 0) // level
    t.emit(0, -80, 16) // looks 10 degrees down
    const alpha = CONFIG.orientation.smoothing
    expect(t.sensor.latest(16)!.pitchDeg).toBeCloseTo(-10 * alpha, 3)
  })

  test('readings without angles are ignored', () => {
    const t = setup()
    t.sensor.start()
    t.emit(null, null, 10)
    expect(t.sensor.latest(10)).toBeNull()
    expect(t.sensor.getStatus()).toBe('waiting')
  })

  test('the latest reading goes stale', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -90, 0)
    expect(t.sensor.latest(CONFIG.orientation.staleAfterMs)).not.toBeNull()
    expect(t.sensor.latest(CONFIG.orientation.staleAfterMs + 1)).toBeNull()
  })

  test('at() pairs a moment with the nearest reading', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -90, 100) // level
    t.emit(0, -60, 200) // looks well down
    expect(t.sensor.at(110)!.timeMs).toBe(100)
    expect(t.sensor.at(190)!.timeMs).toBe(200) // the reading just after is closer
  })

  test('at() holds the last reading while the phone is still, up to the stale limit', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -90, 100)
    expect(t.sensor.at(100 + 900)!.timeMs).toBe(100) // 900 ms later, no new event: still valid
    expect(t.sensor.at(100 + CONFIG.orientation.staleAfterMs)!.timeMs).toBe(100)
    expect(t.sensor.at(100 + CONFIG.orientation.staleAfterMs + 1)).toBeNull()
  })

  test('at() ignores a later reading that is too far after the moment', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -90, 1000)
    expect(t.sensor.at(1000 - CONFIG.orientation.maxSampleGapMs)!.timeMs).toBe(1000)
    expect(t.sensor.at(1000 - CONFIG.orientation.maxSampleGapMs - 1)).toBeNull()
  })

  test('old readings are dropped from the history', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -90, 0)
    t.emit(0, -90, CONFIG.orientation.historyMs + 100)
    // The first reading was pruned, so only the later one remains (and it is too far after time 0).
    expect(t.sensor.at(0)).toBeNull()
    expect(t.sensor.at(CONFIG.orientation.historyMs + 100)).not.toBeNull()
  })
})

describe('availability', () => {
  test('no reading within the timeout means unavailable', () => {
    const t = setup()
    t.sensor.start()
    vi.advanceTimersByTime(CONFIG.orientation.noDataTimeoutMs + 1)
    expect(t.sensor.getStatus()).toBe('unavailable')
  })

  test('a reading before the timeout cancels it', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -90, 10)
    vi.advanceTimersByTime(CONFIG.orientation.noDataTimeoutMs * 2)
    expect(t.sensor.getStatus()).toBe('ready')
  })

  test('a late reading recovers from unavailable', () => {
    const t = setup()
    t.sensor.start()
    vi.advanceTimersByTime(CONFIG.orientation.noDataTimeoutMs + 1)
    t.emit(0, -90, 5000)
    expect(t.sensor.getStatus()).toBe('ready')
  })

  test('stop removes the listener, clears readings, and goes idle', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -90, 10)
    t.sensor.stop()
    expect(t.handlers.size).toBe(0)
    expect(t.sensor.latest(10)).toBeNull()
    expect(t.sensor.getStatus()).toBe('idle')
  })

  test('after stop and start the first reading is not blended with the old one', () => {
    const t = setup()
    t.sensor.start()
    t.emit(0, -80, 10) // 10 degrees down
    t.sensor.stop()
    t.sensor.start()
    t.emit(0, -90, 20) // level
    expect(t.sensor.latest(20)!.pitchDeg).toBeCloseTo(0, 6)
  })
})
