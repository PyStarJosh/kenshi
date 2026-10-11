import { useEffect, useState } from 'react'
import { createBitmapGrabber } from '../camera/scheduler'
import { sharedLocator } from '../find/locateClient'
import type { AudioLink } from './audioLink'
import { BeaconDriver } from './beaconDriver'
import { FindRunner } from './findRunner'
import type { Pipeline } from './pipeline'
import type { Session } from './session'
import { settingsStore } from './settings'

/** Create the Find runner once and connect it to the bus, the sensors and the audio link for the life of the component. */
export function useFind(
  session: Session,
  link: AudioLink,
  pipeline: Pipeline,
  getVideo: () => HTMLVideoElement | null,
): FindRunner {
  const [runner] = useState(() => {
    let grabber: { video: HTMLVideoElement; grab: () => Promise<ImageBitmap | null> } | null = null
    return new FindRunner({
      bus: pipeline.bus,
      orientationAt: (timeMs) => session.getOrientationAt(timeMs),
      orientationLatest: (nowMs) => session.getOrientationLatest(nowMs),
      isRunning: () => session.getSnapshot().state === 'running',
      getTracks: () => pipeline.getTracks(),
      getSettings: () => settingsStore.getSnapshot(),
      grab: () => {
        const video = getVideo()
        if (!video) return Promise.resolve(null)
        if (grabber?.video !== video) grabber = { video, grab: createBitmapGrabber(video) }
        return grabber.grab()
      },
      locator: sharedLocator(),
      now: () => performance.now(),
      tick: () => link.playTick(),
      setTimer: (callback, ms) => setInterval(callback, ms),
      clearTimer: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    })
  })
  useEffect(() => {
    link.setFindActive(() => runner.isActive())
    const detach = runner.attach()
    // The beacon follows the Find snapshot on the bus: pulses while guiding, a chime on arrival, silence otherwise.
    const detachBeacon = new BeaconDriver(pipeline.bus, () => link.getBeacon()).attach()
    return () => {
      detachBeacon()
      detach()
      link.setFindActive(() => false)
    }
  }, [runner, link, pipeline])
  return runner
}
