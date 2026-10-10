import { useEffect, useState } from 'react'
import { AlertPolicy } from '../alerts/policy'
import { CLASSES } from '../detection/classes'
import { Tracker } from '../tracking/tracker'
import type { AudioLink } from './audioLink'
import { Pipeline } from './pipeline'
import type { Session } from './session'
import { settingsStore } from './settings'

/** Create the pipeline once and connect it to the session and the audio link for the life of the component. */
export function usePipeline(session: Session, link: AudioLink): Pipeline {
  const [pipeline] = useState(
    () =>
      new Pipeline({
        session,
        link,
        tracker: new Tracker(CLASSES),
        policy: new AlertPolicy(CLASSES),
        getSettings: () => settingsStore.getSnapshot(),
        now: () => performance.now(),
      }),
  )
  useEffect(() => pipeline.attach(), [pipeline])
  return pipeline
}
