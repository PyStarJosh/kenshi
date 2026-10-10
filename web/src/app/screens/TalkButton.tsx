// The Talk area: the whole live screen is one large button. A tap listens for a command, a tap while
// listening cancels, and holding for about a second pauses or resumes detection.
import { useState } from 'react'
import { TalkGesture } from '../../voice/gesture'
import type { AudioLink } from '../audioLink'

interface Props {
  link: AudioLink
}

export default function TalkButton({ link }: Props) {
  const [gesture] = useState(
    () =>
      new TalkGesture({
        now: () => performance.now(),
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        onTap: () => link.tap(),
        onLongPress: () => link.longPress(),
      }),
  )

  return (
    <button
      type="button"
      className="talk"
      onPointerDown={() => gesture.pressStart()}
      onPointerUp={() => gesture.pressEnd()}
      onPointerCancel={() => gesture.pressCancel()}
      onPointerLeave={() => gesture.pressCancel()}
      onContextMenu={(event) => event.preventDefault()}
      // Keyboard and VoiceOver activations arrive as a click with no pointer (detail 0); a touch or mouse
      // click was already handled by the pointer events above.
      onClick={(event) => {
        if (event.detail === 0) gesture.tap()
      }}
    >
      Talk
    </button>
  )
}
