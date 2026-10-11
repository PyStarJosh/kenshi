import { useEffect, useState, useSyncExternalStore } from 'react'
import { createSession } from './session'
import type { Session, SessionSnapshot } from './session'

/**
 * Create the session once and wire it to page visibility.
 * Pass setVideo as the ref of the <video> element.
 */
export function useSession(): {
  session: Session
  snapshot: SessionSnapshot
  setVideo: (element: HTMLVideoElement | null) => void
  /** The mounted <video> element, for tools (the ?debug locate button) that grab a frame themselves. */
  getVideo: () => HTMLVideoElement | null
} {
  const [{ session, setVideo, getVideo }] = useState(() => {
    const holder: { video: HTMLVideoElement | null } = { video: null }
    return {
      session: createSession(() => holder.video),
      setVideo: (element: HTMLVideoElement | null) => {
        holder.video = element
      },
      getVideo: () => holder.video,
    }
  })

  useEffect(() => {
    const onVisibilityChange = () => (document.hidden ? session.handleHidden() : session.handleVisible())
    const onPageHide = () => session.handleHidden()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onVisibilityChange)
      session.shutdown()
    }
  }, [session])

  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return { session, snapshot, setVideo, getVideo }
}
