import { useEffect, useState } from 'react'
import { buildSessionMeta } from '../telemetry/sessionMeta'
import { TelemetryLogger } from '../telemetry/logger'
import type { Pipeline } from './pipeline'
import type { Session } from './session'
import { settingsStore } from './settings'

/**
 * Create the test-mode logger once and feed it the pipeline's telemetry. A log starts with each Start tap
 * while Test mode is on and stops when the session goes back to idle; with Test mode off nothing starts.
 */
export function useTelemetry(session: Session, pipeline: Pipeline): TelemetryLogger {
  const [logger] = useState(
    () =>
      new TelemetryLogger({
        now: () => performance.now(),
        getOrientation: (nowMs) => session.getOrientationLatest(nowMs),
      }),
  )

  useEffect(() => {
    let loggedStart: number | null = null
    const offBus = pipeline.bus.subscribe('telemetry', (event) => logger.handle(event))
    // Runs inside the session's own notification, so the log is open before the first frame can arrive.
    const sync = () => {
      const { state, engine } = session.getSnapshot()
      if (state === 'idle') {
        logger.stop()
        loggedStart = null
        return
      }
      const startedAt = session.getStartedAtMs()
      const settings = settingsStore.getSnapshot()
      if (state === 'running' && settings.testMode && startedAt !== null && loggedStart !== startedAt) {
        loggedStart = startedAt
        logger.begin(buildSessionMeta(engine, settings), startedAt)
      }
    }
    sync()
    const offSession = session.subscribe(sync)
    return () => {
      offSession()
      offBus()
      logger.stop()
    }
  }, [logger, pipeline, session])

  return logger
}
