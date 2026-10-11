import type { CSSProperties } from 'react'
import { lazy, Suspense, useState, useSyncExternalStore } from 'react'
import { useAudioLink } from './app/useAudioLink'
import { useFind } from './app/useFind'
import { usePipeline } from './app/usePipeline'
import TalkButton from './app/screens/TalkButton'
import { useSession } from './app/useSession'

const DebugOverlay = lazy(() => import('./app/screens/DebugOverlay.tsx'))
const AudioTestPanel = lazy(() => import('./app/screens/AudioTestPanel.tsx'))
const FindScreen = lazy(() => import('./app/screens/FindScreen.tsx'))
const LocateDebugPanel = lazy(() => import('./app/screens/LocateDebugPanel.tsx'))
const SettingsScreen = lazy(() => import('./app/screens/Settings.tsx'))
const CalibrateScreen = lazy(() => import('./app/screens/Calibrate.tsx'))

const debugEnabled = new URLSearchParams(window.location.search).has('debug')
const DEFAULT_ASPECT = 16 / 9

type View = 'main' | 'settings' | 'calibrate'

export default function App() {
  const { session, snapshot, setVideo, getVideo } = useSession()
  const audio = useAudioLink(session)
  const pipeline = usePipeline(session, audio)
  const find = useFind(session, audio, pipeline, getVideo)
  const audioError = useSyncExternalStore(audio.subscribe, () => audio.getView().error)
  const voiceMessage = useSyncExternalStore(audio.subscribe, () => audio.getView().voiceMessage)
  const [view, setView] = useState<View>('main')
  // The camera picture is a small inset in the corner; a tap makes it fill the screen behind the Find screen.
  const [enlarged, setEnlarged] = useState(false)
  const { state, message, frameSize } = snapshot
  const live = state === 'running' || state === 'paused'
  const aspect = frameSize ? frameSize.width / frameSize.height : DEFAULT_ASPECT

  return (
    <main className="app">
      <div
        className={!live ? 'stage stage-off' : enlarged ? 'stage stage-large' : 'stage stage-inset'}
        style={{ '--ar': aspect } as CSSProperties}
      >
        <video ref={setVideo} className="video" aria-hidden="true" />
        {debugEnabled && live && (
          <Suspense fallback={null}>
            <DebugOverlay session={session} snapshot={snapshot} pipeline={pipeline} />
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

      {live && (
        <Suspense fallback={null}>
          <FindScreen runner={find} link={audio} seeThrough={enlarged} />
        </Suspense>
      )}

      {live && (
        <button
          type="button"
          className={enlarged ? 'inset-toggle inset-toggle-large' : 'inset-toggle'}
          aria-label={enlarged ? 'Make the camera view small' : 'Make the camera view large'}
          aria-pressed={enlarged}
          style={{ '--ar': aspect } as CSSProperties}
          onClick={() => setEnlarged((value) => !value)}
        />
      )}

      {debugEnabled && (
        <Suspense fallback={null}>
          <AudioTestPanel link={audio} />
        </Suspense>
      )}

      {debugEnabled && live && (
        <Suspense fallback={null}>
          <LocateDebugPanel session={session} getVideo={getVideo} />
        </Suspense>
      )}

      <p role="status" aria-live="polite" className="status">
        {[message, audioError, voiceMessage].filter(Boolean).join(' ')}
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
