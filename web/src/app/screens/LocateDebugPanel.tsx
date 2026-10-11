// Locate test panel (?debug): sends the current camera frame and a typed target to /api/locate and shows the raw
// outcome as JSON, with the round-trip time. For checking Find's function on the deployed URL (step R2). Heading and
// pitch come from the orientation sensor at the moment of the frame; heading is 0 if the sensor has none.
import { useState } from 'react'
import { createBitmapGrabber } from '../../camera/scheduler'
import { sharedLocator } from '../../find/locateClient'
import type { Session } from '../session'
import './LocateDebugPanel.css'

interface Props {
  session: Session
  getVideo: () => HTMLVideoElement | null
}

export default function LocateDebugPanel({ session, getVideo }: Props) {
  const locator = sharedLocator()
  const [target, setTarget] = useState('chair')
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState('')

  const run = async () => {
    const video = getVideo()
    if (!video) {
      setOutput('No camera frame yet. Press Start first.')
      return
    }
    setBusy(true)
    setOutput('Sending...')
    const started = performance.now()
    try {
      const bitmap = await createBitmapGrabber(video)()
      if (!bitmap) {
        setOutput('The camera has no frame yet. Try again in a moment.')
        return
      }
      const tilt = session.getOrientationLatest(performance.now())
      const outcome = await locator.locate(target, [
        { bitmap, heading: tilt?.headingDeg ?? 0, pitch: tilt?.pitchDeg ?? 0 },
      ])
      bitmap.close()
      const roundTripMs = Math.round(performance.now() - started)
      setOutput(`${JSON.stringify(outcome, null, 2)}\nround trip ${roundTripMs} ms`)
    } catch (error) {
      setOutput(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="locate-debug" aria-label="Locate test panel">
      <div className="locate-debug-row">
        <input
          type="text"
          value={target}
          maxLength={60}
          aria-label="Target"
          onChange={(event) => setTarget(event.currentTarget.value)}
        />
        <button type="button" disabled={busy} onClick={() => void run()}>
          Locate
        </button>
      </div>
      {output && <pre>{output}</pre>}
    </section>
  )
}
