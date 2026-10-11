// Connects the Find snapshot on the event bus to the beacon (R5): pulses run only while guiding, follow the bearing and
// distance as they change, stop on idle, lost, error and the rest, and a chime plays on arrival. Nothing here decides
// what the pulses sound like; that is audio/beacon.ts.
import type { EventBus } from '../alerts/bus'
import type { BeaconTarget } from '../audio/beacon'
import type { EventMap, FindSnapshot, FindStateName } from '../core/types'

export interface BeaconLike {
  start(): void
  stop(): void
  update(target: BeaconTarget): void
  chime(): void
}

export class BeaconDriver {
  private readonly bus: EventBus<EventMap>
  private readonly getBeacon: () => BeaconLike | null
  private previous: FindStateName = 'idle'

  /** getBeacon gives the beacon, or null before the audio has been unlocked. */
  constructor(bus: EventBus<EventMap>, getBeacon: () => BeaconLike | null) {
    this.bus = bus
    this.getBeacon = getBeacon
  }

  /** Start listening. Returns a function that undoes it and stops the beacon. */
  attach(): () => void {
    const stop = this.bus.subscribe('find', (snapshot) => this.onSnapshot(snapshot))
    return () => {
      stop()
      this.getBeacon()?.stop()
      this.previous = 'idle'
    }
  }

  private onSnapshot(snapshot: FindSnapshot): void {
    const beacon = this.getBeacon()
    const before = this.previous
    this.previous = snapshot.state
    if (beacon === null) return
    if (snapshot.state === 'guiding' && snapshot.bearingDeg !== null) {
      beacon.update({ bearingDeg: snapshot.bearingDeg, distanceM: snapshot.distanceM })
      beacon.start()
      return
    }
    beacon.stop()
    if (snapshot.state === 'arrived' && before === 'guiding') beacon.chime()
  }
}
