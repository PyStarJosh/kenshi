import { useEffect, useState } from 'react'
import { AudioLink } from './audioLink'
import type { Session } from './session'

/** Create the audio link once and attach it to the session for the life of the component. */
export function useAudioLink(session: Session): AudioLink {
  const [link] = useState(() => new AudioLink())
  useEffect(() => link.attach(session), [link, session])
  return link
}
