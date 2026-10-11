// Audio test panel (?debug): fires sample alerts (tones and a neutral phrase, never an object) and health
// announcements, and shows the measured tone and speech delays.
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
  { label: 'Urgent left', priority: 'urgent', pan: -1, distanceM: 1.4, phrase: 'Test, urgent, left.' },
  { label: 'Urgent near', priority: 'urgent', pan: 0, distanceM: 0.6, phrase: 'Test, urgent, center.' },
  { label: 'Urgent right', priority: 'urgent', pan: 1, distanceM: 1.4, phrase: 'Test, urgent, right.' },
  { label: 'Normal left', priority: 'normal', pan: -0.5, distanceM: 3, phrase: 'Test, normal, left.' },
  { label: 'Normal center', priority: 'normal', pan: 0, distanceM: 2.5, phrase: 'Test, normal, center.' },
  { label: 'Normal right', priority: 'normal', pan: 0.5, distanceM: 2, phrase: 'Test, normal, right.' },
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
