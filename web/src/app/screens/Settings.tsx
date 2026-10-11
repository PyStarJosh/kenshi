// Settings: eye height and field of view (with calibration). Reachable from the Start screen, out of the way.
import { useState } from 'react'
import { CONFIG } from '../../core/config'
import { settingsStore } from '../settings'
import { useSettings } from '../useSettings'
import './Sheet.css'

interface Props {
  onBack: () => void
  onCalibrate: () => void
}

export default function SettingsScreen({ onBack, onCalibrate }: Props) {
  const settings = useSettings()
  const { minEyeHeightM, maxEyeHeightM, defaultEyeHeightM, defaultHorizontalFovDeg } = CONFIG.geometry
  const [eyeText, setEyeText] = useState(settings.eyeHeightM.toFixed(2))
  const [status, setStatus] = useState('')

  function changeEyeHeight(text: string) {
    setEyeText(text)
    const value = Number(text)
    if (text.trim() === '' || !Number.isFinite(value) || value < minEyeHeightM || value > maxEyeHeightM) {
      setStatus(`Enter a height between ${minEyeHeightM} and ${maxEyeHeightM} meters.`)
      return
    }
    settingsStore.update({ eyeHeightM: value })
    setStatus(`Eye height set to ${value.toFixed(2)} meters.`)
  }

  function resetGeometry() {
    settingsStore.update({ eyeHeightM: defaultEyeHeightM, horizontalFovDeg: defaultHorizontalFovDeg })
    setEyeText(defaultEyeHeightM.toFixed(2))
    setStatus('Eye height and field of view are back to their defaults.')
  }

  return (
    <div className="sheet">
      <h1>Settings</h1>

      <div className="field">
        <label htmlFor="eye-height">Eye height in meters</label>
        <input
          id="eye-height"
          type="number"
          inputMode="decimal"
          step="0.01"
          min={minEyeHeightM}
          max={maxEyeHeightM}
          value={eyeText}
          onChange={(e) => changeEyeHeight(e.target.value)}
          onBlur={() => setEyeText(settings.eyeHeightM.toFixed(2))}
        />
        <p className="hint">
          The height of the phone above the floor when you hold it at eye level. Distances depend on it.
        </p>
        <p role="status" aria-live="polite" className="sheet-status">
          {status}
        </p>
      </div>

      <div className="field">
        <p className="value">Horizontal field of view: {settings.horizontalFovDeg.toFixed(1)} degrees</p>
        <p className="hint">
          The starting value is {defaultHorizontalFovDeg} degrees. Calibrating on your own phone makes direction and
          distance more accurate.
        </p>
        <button type="button" onClick={onCalibrate}>
          Calibrate field of view
        </button>
      </div>

      <div className="field">
        <label className="check" htmlFor="test-mode">
          <input
            id="test-mode"
            type="checkbox"
            checked={settings.testMode}
            onChange={(e) => settingsStore.update({ testMode: e.target.checked })}
          />
          Test mode
        </label>
        <p className="hint">
          Records each walk so you can save the log, replay it, and score it. Shows the session clock and a large caption
          for every spoken alert. Off by default; nothing is recorded while it is off.
        </p>
      </div>

      <div className="row">
        <button type="button" onClick={resetGeometry}>
          Reset eye height and field of view
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  )
}
