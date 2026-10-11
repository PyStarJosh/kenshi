// Debug overlay (?debug): what the model sees and where it puts it, how fast it runs, and a clock
// for lining up recordings.
import { useEffect, useState } from 'react'
import { CONFIG } from '../../core/config'
import type { FrameResult, Track } from '../../core/types'
import type { Pipeline } from '../pipeline'
import { settingsStore } from '../settings'
import type { Session, SessionSnapshot } from '../session'
import { trackGeometryLabel, trackMotionLabel } from './geometryLabel'
import { LiveStats } from './liveStats'
import './DebugOverlay.css'

interface Props {
  session: Session
  snapshot: SessionSnapshot
  pipeline: Pipeline
}

interface Shown {
  result: FrameResult
  tracks: Track[]
}

const ms = (value: number) => value.toFixed(0)

export default function DebugOverlay({ session, snapshot, pipeline }: Props) {
  const [stats] = useState(() => new LiveStats())
  const [shown, setShown] = useState<Shown | null>(null)
  const [nowMs, setNowMs] = useState(() => performance.now())

  // The pipeline publishes each frame, then its tracks, in one go.
  useEffect(() => {
    let latest: FrameResult | null = null
    const stops = [
      pipeline.bus.subscribe('frame', (result) => {
        stats.push(result)
        latest = result
      }),
      pipeline.bus.subscribe('tracks', (tracks) => {
        if (latest) setShown({ result: latest, tracks })
      }),
    ]
    return () => stops.forEach((stop) => stop())
  }, [pipeline, stats])

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
        {shown?.tracks.map((t) => (
          <div
            key={t.id}
            className={`debug-box${t.inPath ? ' debug-box-path' : ''}${t.status === 'tentative' ? ' debug-box-tentative' : ''}`}
            style={{
              left: `${t.box.x * 100}%`,
              top: `${t.box.y * 100}%`,
              width: `${t.box.width * 100}%`,
              height: `${t.box.height * 100}%`,
            }}
          >
            <span>
              {t.label} {t.confidence.toFixed(2)}
              <br />
              {trackMotionLabel(t)}
              <br />
              {trackGeometryLabel(t)}
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
        <dt>capture to result p50 / p95</dt>
        <dd>
          {ms(view.latencyP50)} / {ms(view.latencyP95)} ms
        </dd>
        <dt>heading / pitch / roll</dt>
        <dd>
          {tilt
            ? `${tilt.headingDeg === undefined ? 'none' : tilt.headingDeg.toFixed(1)} / ${tilt.pitchDeg.toFixed(1)} / ${tilt.rollDeg.toFixed(1)} deg`
            : `none (${snapshot.orientation}), level assumed`}
        </dd>
        <dt>fov / eye height</dt>
        <dd>
          {settings.horizontalFovDeg.toFixed(1)} deg / {settings.eyeHeightM.toFixed(2)} m
        </dd>
        <dt>objects / tracks / brightness</dt>
        <dd>{result ? `${result.detections.length} / ${shown!.tracks.length} / ${result.meanLuma.toFixed(2)}` : '-'}</dd>
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
