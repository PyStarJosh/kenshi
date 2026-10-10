// Debug overlay (?debug): what the model sees and where it puts it, how fast it runs, and a clock
// for lining up recordings.
import { useEffect, useState } from 'react'
import { CONFIG } from '../../core/config'
import type { FrameResult } from '../../core/types'
import { CLASSES } from '../../detection/classes'
import { locateDetection } from '../../geometry/geometry'
import type { GeometryResult } from '../../geometry/geometry'
import { settingsStore } from '../settings'
import type { Session, SessionSnapshot } from '../session'
import { geometryLabel } from './geometryLabel'
import { LiveStats } from './liveStats'
import './DebugOverlay.css'

interface Props {
  session: Session
  snapshot: SessionSnapshot
}

interface Shown {
  result: FrameResult
  /** One entry per detection, in the same order. */
  located: GeometryResult[]
}

const ms = (value: number) => value.toFixed(0)

export default function DebugOverlay({ session, snapshot }: Props) {
  const [stats] = useState(() => new LiveStats())
  const [shown, setShown] = useState<Shown | null>(null)
  const [nowMs, setNowMs] = useState(() => performance.now())

  useEffect(
    () =>
      session.onResult((result) => {
        stats.push(result)
        // Pair the frame with the tilt at the moment it was captured, not the moment it finished.
        const tilt = session.getOrientationAt(result.captureTimeMs)
        const frame = { width: result.frameWidth, height: result.frameHeight }
        const settings = settingsStore.getSnapshot()
        setShown({
          result,
          located: result.detections.map((d) => locateDetection(d, CLASSES, frame, tilt, settings)),
        })
      }),
    [session, stats],
  )

  useEffect(() => {
    const id = setInterval(() => setNowMs(performance.now()), CONFIG.debug.clockUpdateMs)
    return () => clearInterval(id)
  }, [])

  const startedAt = session.getStartedAtMs()
  const elapsedS = startedAt === null ? 0 : Math.max(0, (nowMs - startedAt) / 1000)
  const view = stats.view(nowMs)
  const tilt = session.getOrientationLatest(nowMs)
  const settings = settingsStore.getSnapshot()
  const { engine, frameSize, cameraLabel } = snapshot
  const result = shown?.result ?? null

  return (
    <>
      <div className="debug-boxes" aria-hidden="true">
        {result?.detections.map((d, i) => (
          <div
            key={i}
            className={shown!.located[i].inPath ? 'debug-box debug-box-path' : 'debug-box'}
            style={{
              left: `${d.box.x * 100}%`,
              top: `${d.box.y * 100}%`,
              width: `${d.box.width * 100}%`,
              height: `${d.box.height * 100}%`,
            }}
          >
            <span>
              {d.label} {d.confidence.toFixed(2)}
              <br />
              {geometryLabel(shown!.located[i])}
            </span>
          </div>
        ))}
      </div>
      <dl className="debug-panel">
        <dt>fps</dt>
        <dd>{view.fps.toFixed(1)}</dd>
        <dt>provider</dt>
        <dd>
          {engine ? `${engine.backend}${engine.backend === 'wasm' ? ` x${engine.threads}` : ''}` : '-'}
        </dd>
        <dt>inference p50 / p95</dt>
        <dd>
          {ms(view.inferenceP50)} / {ms(view.inferenceP95)} ms
        </dd>
        <dt>pitch / roll</dt>
        <dd>
          {tilt
            ? `${tilt.pitchDeg.toFixed(1)} / ${tilt.rollDeg.toFixed(1)} deg`
            : `none (${snapshot.orientation}), level assumed`}
        </dd>
        <dt>fov / eye height</dt>
        <dd>
          {settings.horizontalFovDeg.toFixed(1)} deg / {settings.eyeHeightM.toFixed(2)} m
        </dd>
        <dt>objects / brightness</dt>
        <dd>{result ? `${result.detections.length} / ${result.meanLuma.toFixed(2)}` : '-'}</dd>
        <dt>frame</dt>
        <dd>{frameSize ? `${frameSize.width}x${frameSize.height}` : '-'}</dd>
        <dt>model</dt>
        <dd>{engine ? engine.inputSize : '-'}</dd>
        <dt>camera</dt>
        <dd>{cameraLabel ?? '-'}</dd>
      </dl>
      <div className="debug-clock" aria-hidden="true">
        {elapsedS.toFixed(1)} s
      </div>
    </>
  )
}
