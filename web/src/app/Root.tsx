import { lazy, Suspense } from 'react'
import App from '../App.tsx'

const Benchmark = lazy(() => import('./screens/Benchmark.tsx'))

/** Shows the benchmark screen when the page is opened with ?bench, the app otherwise. */
export default function Root() {
  if (new URLSearchParams(window.location.search).has('bench')) {
    return (
      <Suspense fallback={null}>
        <Benchmark />
      </Suspense>
    )
  }
  return <App />
}
