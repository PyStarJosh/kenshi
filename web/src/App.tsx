import { useState } from 'react'

const READY_STATUS = 'Not started. Press Start to begin.'

export default function App() {
  const [status] = useState(READY_STATUS)

  return (
    <main className="screen">
      <h1>Navigator</h1>
      <button type="button" className="start">
        Start
      </button>
      <p role="status" aria-live="polite" className="status">
        {status}
      </p>
      {import.meta.env.DEV && (
        <p className="debug">crossOriginIsolated: {String(window.crossOriginIsolated)}</p>
      )}
    </main>
  )
}
