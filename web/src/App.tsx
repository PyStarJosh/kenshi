import type { CSSProperties } from 'react'
import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { useAudioLink } from './app/useAudioLink'
import { useSettings } from './app/useSettings'
import { useTelemetry } from './app/useTelemetry'
import { usePipeline } from './app/usePipeline'
import TalkButton from './app/screens/TalkButton'
import { useSession } from './app/useSession'

const DebugOverlay = lazy(() => import('./app/screens/DebugOverlay.tsx'))
const AudioTestPanel = lazy(() => import('./app/screens/AudioTestPanel.tsx'))
const SettingsScreen = lazy(() => import('./app/screens/Settings.tsx'))
const CalibrateScreen = lazy(() => import('./app/screens/Calibrate.tsx'))
const TestOverlay = lazy(() => import('./app/screens/TestOverlay.tsx'))
const SaveLogButton = lazy(() => import('./app/screens/SaveLogButton.tsx'))

const debugEnabled = new URLSearchParams(window.location.search).has('debug')
const DEFAULT_ASPECT = 16 / 9

type View = 'main' | 'settings' | 'calibrate'

export default function App() {
  const { session, snapshot, setVideo } = useSession()
  const audio = useAudioLink(session)
  const pipeline = usePipeline(session, audio)
  const logger = useTelemetry(session, pipeline)
  const logView = useSyncExternalStore(logger.subscribe, logger.getView)
  const { testMode } = useSettings()
  const audioError = useSyncExternalStore(audio.subscribe, () => audio.getView().error)
  const voiceMessage = useSyncExternalStore(audio.subscribe, () => audio.getView().voiceMessage)
  const [view, setView] = useState<View>('main')
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
            <DebugOverlay session={session} snapshot={snapshot} pipeline={pipeline} />
          </Suspense>
        )}
        {testMode && live && (
          <Suspense fallback={null}>
            <TestOverlay session={session} pipeline={pipeline} />
          </Suspense>
        )}
      </div>

      {!live && (
        <div className="start-screen">
          <h1>Kenshi</h1>
          <p className="cane-note">Kenshi complements your white cane. It does not replace it.</p>
          <button
            type="button"
            className="start"
            disabled={state === 'starting'}
            onClick={() => {
              // Audio and speech must be unlocked inside this tap, before anything is awaited.
              audio.unlock(true)
              void session.start()
            }}
          >
            Start
          </button>
          <button
            type="button"
            className="settings-button"
            disabled={state === 'starting'}
            onClick={() => setView('settings')}
          >
            Settings
          </button>
          {import.meta.env.DEV && (
            <p className="dev-line">crossOriginIsolated: {String(window.crossOriginIsolated)}</p>
          )}
        </div>
      )}

      {live && (
        <TalkButton link={audio} />
      )}

      {testMode && state === 'paused' && logView.hasLog && (
        <Suspense fallback={null}>
          <SaveLogButton logger={logger} />
        </Suspense>
      )}

      {debugEnabled && (
        <Suspense fallback={null}>
          <AudioTestPanel link={audio} />
        </Suspense>
      )}

      <p role="status" aria-live="polite" className="status">
        {[message, audioError, voiceMessage, logView.message].filter(Boolean).join(' ')}
      </p>

      {view !== 'main' && (
        <Suspense fallback={null}>
          {view === 'settings' ? (
            <SettingsScreen onBack={() => setView('main')} onCalibrate={() => setView('calibrate')} />
          ) : (
            <CalibrateScreen onDone={() => setView('settings')} />
          )}
        </Suspense>
      )}
    </main>
  )
}
