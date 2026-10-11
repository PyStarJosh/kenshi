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
  /** ?debug: find the path line even when Find is idle. */
  pathAlways = false,
): FindRunner {
  const [runner] = useState(() => {
    let grabber: { video: HTMLVideoElement; grab: () => Promise<ImageBitmap | null> } | null = null
    return new FindRunner({
      bus: pipeline.bus,
      orientationAt: (timeMs) => session.getOrientationAt(timeMs),
      orientationLatest: (nowMs) => session.getOrientationLatest(nowMs),
      isRunning: () => session.getSnapshot().state === 'running',
      getTracks: () => pipeline.getTracks(),
      getPathDecision: (nowMs) => pipeline.getPathDecision(nowMs),
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
      isSpeaking: () => link.isSpeaking(),
      setTimer: (callback, ms) => setInterval(callback, ms),
      clearTimer: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    })
  })
  useEffect(() => {
    link.setFindActive(() => runner.isActive())
    // The detector also finds the free-space path (R7) while guiding to a target (it is not used while searching, so it
    // costs nothing then), steering toward the target when it is in view.
    session.setPathSource(() =>
      runner.isGuiding() || pathAlways
        ? { targetX: runner.getTargetColumn(), hfovDeg: settingsStore.getSnapshot().horizontalFovDeg }
        : null,
    )
    const detach = runner.attach()
    // The beacon follows the Find snapshot on the bus: pulses while guiding, a chime on arrival, silence otherwise.
    const detachBeacon = new BeaconDriver(pipeline.bus, () => link.getBeacon()).attach()
    return () => {
      detachBeacon()
      session.setPathSource(null)
      detach()
      link.setFindActive(() => false)
    }
  }, [runner, link, pipeline, session, pathAlways])
  return runner
}
