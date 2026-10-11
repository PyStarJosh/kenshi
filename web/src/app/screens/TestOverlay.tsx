// Test mode overlay: the session clock and each spoken alert as a large caption with its session time, so an
// iPhone screen recording shows exactly what was said and when (FR-19). Labels are made from this clock.
import { useEffect, useState } from 'react'
import { CONFIG } from '../../core/config'
import type { AlertPriority } from '../../core/types'
import type { Pipeline } from '../pipeline'
import type { Session } from '../session'
import './TestOverlay.css'

interface Props {
  session: Session
  pipeline: Pipeline
}

interface Spoken {
  id: string
  priority: AlertPriority
  phrase: string
  /** Session clock, seconds. */
  atS: number
  /** performance.now() when it started, to retire it. */
  shownAtMs: number
}

const SHOWN_MS = 7000
const KEPT = 3

function formatSessionTime(seconds: number): string {
  return `${seconds.toFixed(1)} s`
}

export default function TestOverlay({ session, pipeline }: Props) {
  const [spoken, setSpoken] = useState<Spoken[]>([])
  const [nowMs, setNowMs] = useState(() => performance.now())

  useEffect(
    () =>
      pipeline.bus.subscribe('alertOutcome', ({ alert, outcome, timeMs }) => {
        if (outcome !== 'started' || alert.kind !== 'obstacle') return
        const origin = session.getStartedAtMs() ?? 0
        const entry: Spoken = { id: alert.id, priority: alert.priority, phrase: alert.phrase, atS: (timeMs - origin) / 1000, shownAtMs: timeMs }
        setSpoken((list) => [...list.filter((s) => s.id !== alert.id), entry].slice(-KEPT))
      }),
    [pipeline, session],
  )

  useEffect(() => {
    const id = setInterval(() => setNowMs(performance.now()), CONFIG.debug.clockUpdateMs)
    return () => clearInterval(id)
  }, [])

  const origin = session.getStartedAtMs()
  const visible = spoken.filter((s) => nowMs - s.shownAtMs < SHOWN_MS)

  return (
    <>
      <div className="test-clock" aria-hidden="true">
        {formatSessionTime(origin === null ? 0 : Math.max(0, (nowMs - origin) / 1000))}
      </div>
      <ol className="test-captions" aria-hidden="true">
        {visible.map((s) => (
          <li key={s.id} className={`test-caption test-caption-${s.priority}`}>
            <span className="test-caption-time">{formatSessionTime(s.atS)}</span> {s.phrase}
          </li>
        ))}
      </ol>
    </>
  )
}
