import { describe, expect, test } from 'vitest'
import { EventBus } from '../alerts/bus'
import type { BeaconTarget } from '../audio/beacon'
import type { EventMap, FindSnapshot } from '../core/types'
import { BeaconDriver } from './beaconDriver'
import type { BeaconLike } from './beaconDriver'

function setup(withBeacon = true) {
  const bus = new EventBus<EventMap>()
  const calls: string[] = []
  const beacon: BeaconLike = {
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    update: (t: BeaconTarget) => calls.push(`update ${t.bearingDeg} ${t.distanceM}`),
    chime: () => calls.push('chime'),
  }
  const detach = new BeaconDriver(bus, () => (withBeacon ? beacon : null)).attach()
  const snap = (patch: Partial<FindSnapshot>) =>
    bus.publish('find', { state: 'idle', target: null, bearingDeg: null, distanceM: null, source: null, ...patch })
  return { bus, calls, detach, snap }
}

describe('the beacon follows the Find snapshot', () => {
  test('pulses while guiding: the target is updated before it starts, and each change updates it', () => {
    const t = setup()
    t.snap({ state: 'guiding', target: 'chair', bearingDeg: 30, distanceM: 4 })
    t.snap({ state: 'guiding', target: 'chair', bearingDeg: 20, distanceM: 3.5 })
    expect(t.calls).toEqual(['update 30 4', 'start', 'update 20 3.5', 'start'])
  })

  test.each(['idle', 'checking', 'sweeping', 'sweepChecking', 'lost', 'notFound', 'error'] as const)(
    '%s stops it, with no chime',
    (state) => {
      const t = setup()
      t.snap({ state: 'guiding', target: 'chair', bearingDeg: 0, distanceM: 2 })
      t.calls.length = 0
      t.snap({ state, target: 'chair' })
      expect(t.calls).toEqual(['stop'])
    },
  )

  test('arriving stops it and plays the chime, once', () => {
    const t = setup()
    t.snap({ state: 'guiding', target: 'chair', bearingDeg: 0, distanceM: 0.5 })
    t.calls.length = 0
    t.snap({ state: 'arrived', target: 'chair' })
    t.snap({ state: 'arrived', target: 'chair', distanceM: 0.5 })
    expect(t.calls).toEqual(['stop', 'chime', 'stop'])
    expect(t.calls.filter((c) => c === 'chime')).toHaveLength(1)
  })

  test('"arrived" without having been guiding plays no chime', () => {
    const t = setup()
    t.snap({ state: 'arrived', target: 'chair' })
    expect(t.calls).toEqual(['stop'])
  })

  test('guiding with no bearing (no heading) stops it', () => {
    const t = setup()
    t.snap({ state: 'guiding', target: 'chair', bearingDeg: 10, distanceM: 2 })
    t.calls.length = 0
    t.snap({ state: 'guiding', target: 'chair', bearingDeg: null })
    expect(t.calls).toEqual(['stop'])
  })

  test('before the audio is unlocked there is nothing to drive, and nothing breaks', () => {
    const t = setup(false)
    expect(() => t.snap({ state: 'guiding', target: 'chair', bearingDeg: 0, distanceM: 2 })).not.toThrow()
    expect(t.calls).toEqual([])
  })

  test('detaching stops the beacon and stops listening', () => {
    const t = setup()
    t.snap({ state: 'guiding', target: 'chair', bearingDeg: 0, distanceM: 2 })
    t.calls.length = 0
    t.detach()
    expect(t.calls).toEqual(['stop'])
    t.snap({ state: 'guiding', target: 'chair', bearingDeg: 0, distanceM: 2 })
    expect(t.calls).toEqual(['stop'])
  })
})
