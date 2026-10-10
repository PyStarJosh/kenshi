// Debug overlay (?debug): what the model sees, how fast it runs, and a clock for lining up recordings.
import { useEffect, useState } from 'react'
import { CONFIG } from '../../core/config'
import type { FrameResult } from '../../core/types'
import type { Session, SessionSnapshot } from '../session'
import { LiveStats } from './liveStats'
import './DebugOverlay.css'

interface Props {
  session: Session
  snapshot: SessionSnapshot
}

const ms = (value: number) => value.toFixed(0)

export default function DebugOverlay({ session, snapshot }: Props) {
  const [stats] = useState(() => new LiveStats())
  const [result, setResult] = useState<FrameResult | null>(null)
  const [nowMs, setNowMs] = useState(() => performance.now())

  useEffect(
    () =>
      session.onResult((frame) => {
        stats.push(frame)
        setResult(frame)
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
  const { engine, frameSize, cameraLabel } = snapshot

  return (
    <>
      <div className="debug-boxes" aria-hidden="true">
        {result?.detections.map((d, i) => (
          <div
            key={i}
            className="debug-box"
            style={{
              left: `${d.box.x * 100}%`,
              top: `${d.box.y * 100}%`,
              width: `${d.box.width * 100}%`,
              height: `${d.box.height * 100}%`,
            }}
          >
            <span>
              {d.label} {d.confidence.toFixed(2)}
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
