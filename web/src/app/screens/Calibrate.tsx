// Calibrate field of view: a live view with a center line, spoken and written steps, and the math in
// calibration.ts. The camera does not report its field of view, so the user measures it.
import { useEffect, useRef, useState } from 'react'
import { Camera, mapCameraError } from '../../camera/camera'
import { CONFIG } from '../../core/config'
import { createOrientationSensor } from '../../sensors/orientation'
import type { OrientationSensor } from '../../sensors/orientation'
import { CALIBRATION_DISTANCE_M, CALIBRATION_STEPS, fovFromWall } from '../calibration'
import type { FovResult } from '../calibration'
import { settingsStore } from '../settings'
import { useSettings } from '../useSettings'
import { speak, stopSpeaking } from './speak'
import './Sheet.css'

// Pitch and roll within this many degrees count as level.
const LEVEL_TOLERANCE_DEG = 2

export default function CalibrateScreen({ onDone }: { onDone: () => void }) {
  const settings = useSettings()
  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<Camera | null>(null)
  const sensorRef = useRef<OrientationSensor | null>(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [tilt, setTilt] = useState<{ pitchDeg: number; rollDeg: number } | null>(null)
  const [width, setWidth] = useState('')
  const [distance, setDistance] = useState(String(CALIBRATION_DISTANCE_M))
  const [result, setResult] = useState<FovResult | null>(null)
  const [status, setStatus] = useState('')

  useEffect(
    () => () => {
      cameraRef.current?.stop()
      sensorRef.current?.stop()
      stopSpeaking()
    },
    [],
  )

  useEffect(() => {
    if (!cameraOn) return
    const id = setInterval(() => {
      const sample = sensorRef.current?.latest(performance.now()) ?? null
      setTilt(sample ? { pitchDeg: sample.pitchDeg, rollDeg: sample.rollDeg } : null)
    }, 200)
    return () => clearInterval(id)
  }, [cameraOn])

  const readSteps = () => speak(CALIBRATION_STEPS.join(' '), settings.speechRate)

  async function startCamera() {
    // Both prompts are requested from this tap; the sensor first, because iOS needs the gesture for it.
    const sensor = createOrientationSensor()
    sensorRef.current = sensor
    const motion = sensor.requestPermission()
    const camera = new Camera(() => videoRef.current)
    cameraRef.current = camera
    setStatus('Starting the camera.')
    readSteps()
    try {
      await camera.start()
      await motion
      sensor.start()
      setCameraOn(true)
      setStatus('The camera is on. Follow the steps, then enter the measurement.')
    } catch (error) {
      const spoken = mapCameraError(error).spoken
      setStatus(spoken)
      speak(spoken, settings.speechRate)
    }
  }

  function compute() {
    const outcome = fovFromWall(Number(width), Number(distance))
    setResult(outcome)
    setStatus(outcome.ok ? `The field of view is ${outcome.fovDeg.toFixed(1)} degrees.` : outcome.reason)
  }

  function save() {
    if (!result?.ok) return
    settingsStore.update({ horizontalFovDeg: result.fovDeg })
    const saved = `Saved. The field of view is ${result.fovDeg.toFixed(1)} degrees.`
    setStatus(saved)
    speak(saved, settings.speechRate)
  }

  const level =
    tilt !== null && Math.abs(tilt.pitchDeg) <= LEVEL_TOLERANCE_DEG && Math.abs(tilt.rollDeg) <= LEVEL_TOLERANCE_DEG

  return (
    <div className="sheet calibrate">
      <div className="calibrate-view">
        <video ref={videoRef} className="calibrate-video" aria-hidden="true" muted playsInline autoPlay />
        {cameraOn && <div className="centerline" aria-hidden="true" />}
        {cameraOn && (
          <p className="tilt-readout" aria-hidden="true">
            {tilt
              ? `pitch ${tilt.pitchDeg.toFixed(1)}  roll ${tilt.rollDeg.toFixed(1)}  ${level ? 'level' : 'not level'}`
              : 'tilt sensor unavailable'}
          </p>
        )}
      </div>

      <div className="calibrate-controls">
        <h1>Calibrate field of view</h1>
        <ol className="steps">
          {CALIBRATION_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="hint">
          Current field of view: {settings.horizontalFovDeg.toFixed(1)} degrees. The allowed range is{' '}
          {CONFIG.geometry.minFovDeg} to {CONFIG.geometry.maxFovDeg}.
        </p>

        <div className="row">
          <button type="button" onClick={readSteps}>
            Read steps aloud
          </button>
          {!cameraOn && (
            <button type="button" onClick={() => void startCamera()}>
              Start camera
            </button>
          )}
        </div>

        {cameraOn && (
          <>
            <div className="field">
              <label htmlFor="wall-distance">Distance from the wall in meters</label>
              <input
                id="wall-distance"
                type="number"
                inputMode="decimal"
                step="0.05"
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="wall-width">Width between the two marks in meters</label>
              <input
                id="wall-width"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={width}
                onChange={(e) => setWidth(e.target.value)}
              />
            </div>
            <div className="row">
              <button type="button" onClick={compute} disabled={width.trim() === ''}>
                Compute
              </button>
              <button type="button" onClick={save} disabled={!result?.ok}>
                Save
              </button>
            </div>
          </>
        )}

        <div className="row">
          <button type="button" onClick={onDone}>
            Done
          </button>
        </div>
        <p role="status" aria-live="polite" className="sheet-status">
          {status}
        </p>
      </div>
    </div>
  )
}
