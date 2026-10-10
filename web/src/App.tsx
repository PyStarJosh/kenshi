import type { CSSProperties } from 'react'
import { lazy, Suspense } from 'react'
import { useSession } from './app/useSession'

const DebugOverlay = lazy(() => import('./app/screens/DebugOverlay.tsx'))

const debugEnabled = new URLSearchParams(window.location.search).has('debug')
const DEFAULT_ASPECT = 16 / 9

export default function App() {
  const { session, snapshot, setVideo } = useSession()
  const { state, message, frameSize } = snapshot
  const live = state === 'running' || state === 'paused'
  const aspect = frameSize ? frameSize.width / frameSize.height : DEFAULT_ASPECT

  return (
    <main className="app">
      <div
        className={live ? 'stage' : 'stage stage-off'}
        style={{ '--ar': aspect } as CSSProperties}
      >
        <video ref={setVideo} className="video" aria-hidden="true" />
        {debugEnabled && live && (
          <Suspense fallback={null}>
            <DebugOverlay session={session} snapshot={snapshot} />
          </Suspense>
        )}
      </div>

      {!live && (
        <div className="start-screen">
          <h1>Kenshi</h1>
          <button
            type="button"
            className="start"
            disabled={state === 'starting'}
            onClick={() => void session.start()}
          >
            Start
          </button>
          {import.meta.env.DEV && (
            <p className="dev-line">crossOriginIsolated: {String(window.crossOriginIsolated)}</p>
          )}
        </div>
      )}

      {live && (
        <button
          type="button"
          className="pause"
          onClick={() => (state === 'running' ? session.pause() : void session.resume())}
        >
          {state === 'running' ? 'Pause' : 'Resume'}
        </button>
      )}

      <p role="status" aria-live="polite" className="status">
        {message}
      </p>
    </main>
  )
}
