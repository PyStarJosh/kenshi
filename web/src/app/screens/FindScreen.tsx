// The Find screen (R6, FR-27), modeled on precision finding: the target's name, a big arrow that turns to point at it,
// the distance in very large type, and a green background when you are facing it. All the decisions are in findView.ts;
// this file only draws them. The screen never takes touches itself (except its buttons), so the Talk button underneath
// still hears a tap (listen) and a long press anywhere (cancel Find).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { CONFIG } from '../../core/config'
import { QUICK_PICKS } from '../../find/targets'
import type { AudioLink } from '../audioLink'
import type { FindRunner } from '../findRunner'
import { initialViewMemory, justFound, makeView, ringArcs } from '../findView'
import type { FindView } from '../findView'
import './FindScreen.css'

interface Props {
  runner: FindRunner
  link: AudioLink
  /** The camera picture is enlarged behind the screen: the screen lets it show through. */
  seeThrough: boolean
}

/** The view for the runner's current snapshot, with the short "Found" screen put in front of the first guiding view. */
function useFindView(runner: FindRunner): FindView {
  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot)
  const [previous, setPrevious] = useState(snapshot.state)
  const [found, setFound] = useState(false)
  // Decided while rendering, so the first guiding frame is never drawn before the Found screen.
  if (snapshot.state !== previous) {
    setPrevious(snapshot.state)
    setFound(justFound(previous, snapshot.state))
  }
  useEffect(() => {
    if (!found) return
    const timer = setTimeout(() => setFound(false), CONFIG.find.foundScreenMs)
    return () => clearTimeout(timer)
  }, [found])

  // What the view remembers (the arrow's angle, the green hysteresis) is kept the same way, and only when it changed.
  const [memory, setMemory] = useState(initialViewMemory)
  const out = useMemo(() => makeView(snapshot, found, memory), [snapshot, found, memory])
  const next = out.memory
  if (next.rotationDeg !== memory.rotationDeg || next.aligned !== memory.aligned || next.direction !== memory.direction) {
    setMemory(next)
  }
  return out.view
}

const RING_RADIUS = 44

function arcPath(startDeg: number, endDeg: number): string {
  const point = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180
    return `${(50 + RING_RADIUS * Math.cos(rad)).toFixed(2)} ${(50 + RING_RADIUS * Math.sin(rad)).toFixed(2)}`
  }
  return `M ${point(startDeg)} A ${RING_RADIUS} ${RING_RADIUS} 0 0 1 ${point(endDeg)}`
}

function Ring({ filled, total }: { filled: number; total: number }) {
  return (
    <svg className="find-visual" viewBox="0 0 100 100" aria-hidden="true">
      {ringArcs(total, filled).map((arc) => (
        <path key={arc.startDeg} d={arcPath(arc.startDeg, arc.endDeg)} className={arc.filled ? 'ring-on' : 'ring-off'} />
      ))}
    </svg>
  )
}

function Arrow({ rotationDeg, known }: { rotationDeg: number; known: boolean }) {
  return (
    <svg className={known ? 'find-visual' : 'find-visual find-dim'} viewBox="0 0 100 100" aria-hidden="true">
      <path
        className="arrow"
        style={{ transform: `rotate(${rotationDeg}deg)` }}
        d="M50 4 L90 54 H64 V96 H36 V54 H10 Z"
      />
    </svg>
  )
}

function Check() {
  return (
    <svg className="find-visual" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="44" className="check-ring" />
      <path d="M28 52 L44 68 L74 34" className="check-mark" />
    </svg>
  )
}

function Home({ runner, link }: { runner: FindRunner; link: AudioLink }) {
  return (
    <>
      <h1 className="find-title">Find</h1>
      <div className="find-home">
        <button type="button" className="find-say" onClick={() => link.tap()}>
          Say a target
        </button>
        <div className="find-picks">
          {QUICK_PICKS.map((name) => (
            <button key={name} type="button" onClick={() => runner.request(name)}>
              {name}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function Active({ view, runner }: { view: FindView; runner: FindRunner }) {
  let visual = null
  if (view.ring) visual = <Ring filled={view.ring.filled} total={view.ring.total} />
  else if (view.check) visual = <Check />
  else if (view.rotationDeg !== null) visual = <Arrow rotationDeg={view.rotationDeg} known={view.arrowKnown} />

  return (
    <>
      <h1 className="find-title">{view.title}</h1>
      <div className="find-body">
        {visual}
        <div className="find-readout">
          {view.distanceText && (
            <p className="find-distance">
              <span aria-hidden="true">{view.distanceText}</span>
              <span className="sr-only">{view.distanceLabel}</span>
            </p>
          )}
          {view.directionText && <p className="find-direction">{view.directionText}</p>}
          {view.headline && <p className="find-headline">{view.headline}</p>}
        </div>
      </div>
      <button type="button" className="find-stop" onClick={() => runner.cancel()}>
        Stop
      </button>
    </>
  )
}

export default function FindScreen({ runner, link, seeThrough }: Props) {
  const view = useFindView(runner)
  const className = ['find-screen', view.aligned ? 'find-aligned' : '', seeThrough ? 'find-see-through' : ''].filter(Boolean).join(' ')

  return (
    <section className={className} aria-label="Find">
      <p role="status" aria-live="polite" className="sr-only">
        {view.liveText}
      </p>
      {view.kind === 'home' ? <Home runner={runner} link={link} /> : <Active view={view} runner={runner} />}
    </section>
  )
}
