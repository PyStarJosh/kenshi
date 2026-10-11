// "Save test log": shares the recorded walk as a .jsonl file (download as the fallback). Shown when Test mode
// has a log and detection is not running, so a tap during a walk can never land on it.
import { useState } from 'react'
import { saveLog } from '../../telemetry/export'
import type { TelemetryLogger } from '../../telemetry/logger'

interface Props {
  logger: TelemetryLogger
}

const RESULT_TEXT = {
  shared: 'Test log shared.',
  downloaded: 'Test log downloaded.',
  cancelled: 'Test log not saved.',
} as const

export default function SaveLogButton({ logger }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  function save() {
    setBusy(true)
    // Called straight from the tap: the share sheet only opens inside a user gesture.
    saveLog(logger.getLines(), new Date())
      .then((result) => setText(RESULT_TEXT[result]))
      .catch((error: unknown) => setText(`Could not save the test log: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setBusy(false))
  }

  return (
    <div className="save-log">
      <button type="button" disabled={busy} onClick={save}>
        Save test log
      </button>
      <p role="status" aria-live="polite">
        {text}
      </p>
    </div>
  )
}
