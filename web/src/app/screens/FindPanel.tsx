// The quick-pick list for Find (R4). It always works, even when speech recognition does not (Safari's is unreliable).
// A plain row of large buttons over the camera view; the real Find screen with the arrow replaces it in step R6.
import { useSyncExternalStore } from 'react'
import { QUICK_PICKS } from '../../find/targets'
import type { FindRunner } from '../findRunner'
import { describeSnapshot } from '../findRunner'
import './FindPanel.css'

interface Props {
  runner: FindRunner
}

export default function FindPanel({ runner }: Props) {
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot)
  const active = snapshot.state !== 'idle'
  const text = describeSnapshot(snapshot)

  return (
    <section className="find-panel" aria-label="Find">
      <div className="find-picks">
        {QUICK_PICKS.map((name) => (
          <button key={name} type="button" onClick={() => runner.request(name)}>
            {name}
          </button>
        ))}
        {active && (
          <button type="button" className="find-stop" onClick={() => runner.cancel()}>
            Stop
          </button>
        )}
      </div>
      {text && (
        <p role="status" className="find-text">
          {text}
        </p>
      )}
    </section>
  )
}
