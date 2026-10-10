// Audio test panel (?debug): fires sample alerts and health announcements, and shows the measured tone and
// speech delays, including p50 and p95 from capture over the real alerts (NFR-3, NFR-4).
import { useSyncExternalStore } from 'react'
import type { AlertPriority } from '../../core/types'
import { HEALTH_PHRASES } from '../../health/monitor'
import type { HealthAnnouncement } from '../../health/monitor'
import type { AudioLink } from '../audioLink'
import { formatSpread } from '../latency'
import './AudioTestPanel.css'

interface Props {
  link: AudioLink
}

interface SampleAlert {
  label: string
  priority: AlertPriority
  pan: number
  distanceM: number
  phrase: string
}

const ALERTS: SampleAlert[] = [
  { label: 'Urgent far left', priority: 'urgent', pan: -1, distanceM: 1.4, phrase: 'Pole, far left, about 1.5 meters.' },
  { label: 'Urgent 12, near', priority: 'urgent', pan: 0, distanceM: 0.6, phrase: 'Person, 12 o\'clock, about 0.5 meters.' },
  { label: 'Urgent far right', priority: 'urgent', pan: 1, distanceM: 1.4, phrase: 'Chair, far right, about 1.5 meters.' },
  { label: 'Normal 11', priority: 'normal', pan: -0.5, distanceM: 3, phrase: 'Backpack, 11 o\'clock, about 3 meters, on the floor.' },
  { label: 'Normal 12', priority: 'normal', pan: 0, distanceM: 2.5, phrase: 'Bench, 12 o\'clock, about 2.5 meters.' },
  { label: 'Normal 1', priority: 'normal', pan: 0.5, distanceM: 2, phrase: 'Bicycle, 1 o\'clock, about 2 meters.' },
  { label: 'Info', priority: 'info', pan: 0, distanceM: 0, phrase: 'This is an information message.' },
]

const HEALTH: { label: string; announcement: HealthAnnouncement }[] = [
  { label: 'Stalled', announcement: { kind: 'warning', issue: 'stalled', phrase: HEALTH_PHRASES.stalled } },
  { label: 'Low light', announcement: { kind: 'warning', issue: 'low-light', phrase: HEALTH_PHRASES['low-light'] } },
  { label: 'Lowered', announcement: { kind: 'warning', issue: 'phone-lowered', phrase: HEALTH_PHRASES.phoneLowered } },
  { label: 'Recovered', announcement: { kind: 'recovered', phrase: HEALTH_PHRASES.recovered } },
]


const ms = (value: number | null) => (value === null ? '-' : `${value.toFixed(0)} ms`)

export default function AudioTestPanel({ link }: Props) {
  const view = useSyncExternalStore(link.subscribe, link.getView)
  const { health, timing } = view

  return (
    <section className="audio-test" aria-label="Audio test panel">
      <div className="audio-test-row">
        {ALERTS.map((sample) => (
          <button
            key={sample.label}
            type="button"
            onClick={() => link.fireTestAlert(sample.priority, sample.pan, sample.distanceM, sample.phrase)}
          >
            {sample.label}
          </button>
        ))}
      </div>
      <div className="audio-test-row">
        {HEALTH.map(({ label, announcement }) => (
          <button key={label} type="button" onClick={() => link.fireTestHealth(announcement)}>
            {label}
          </button>
        ))}
        <label>
          <input type="checkbox" onChange={(event) => link.setSimulateHealthy(event.currentTarget.checked)} />
          Heartbeat without camera
        </label>
      </div>
      <p className="audio-test-info">
        audio {view.contextState} · voice {view.voice ?? 'default'} · health {health?.status ?? '-'}
        {health && health.issues.length > 0 ? ` (${health.issues.join(', ')})` : ''} · fps{' '}
        {health ? health.fps.toFixed(1) : '-'}
        <br />
        alert→tone {ms(timing?.alertToToneMs ?? null)} · frame→tone {ms(timing?.frameToToneMs ?? null)} ·
        frame→speech {ms(timing?.frameToSpeechMs ?? null)} · last {view.lastOutcome ?? '-'} · voice cmd {view.lastVoice ?? '-'}
        <br />
        capture→tone p50 / p95 {formatSpread(view.latency.tone)} · urgent {formatSpread(view.latency.urgentTone)} ·
        capture→speech {formatSpread(view.latency.speech)}
      </p>
    </section>
  )
}
