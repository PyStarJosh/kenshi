// Offline replay of a test log: the logged detections and tilt go back through the same tracker, geometry, and
// alert policy the app runs, with the logged settings or overrides, and the alerts that come out are returned
// (and can be written as a log). With unchanged settings the alerts match the walk, because the pipeline's
// order of events is reproduced: frame, then the drops and alerts it caused, then audio outcomes as they
// arrived. Pure apart from CONFIG, which is changed while a replay runs and put back afterwards.
import { AlertPolicy } from '../alerts/policy'
import type { DropRecord } from '../alerts/policy'
import { CONFIG } from '../core/config'
import type { AlertEvent, AlertOutcome, FrameResult, TelemetryEvent } from '../core/types'
import { CLASSES } from '../detection/classes'
import { Tracker } from '../tracking/tracker'

type SessionEvent = Extract<TelemetryEvent, { kind: 'session' }>
type AlertRow = Extract<TelemetryEvent, { kind: 'alert' }>

/** How audio outcomes (started, finished, preempted) reach the policy during a replay. */
export type AudioMode = 'logged' | 'simulated'

export interface ReplayOptions {
  /** Values to change in CONFIG, in the same shape (for example { alerts: { urgentDistanceM: 2 } }). */
  overrides?: Record<string, unknown>
  /** Start from the CONFIG stored in the log instead of the current config.ts. */
  useLoggedConfig?: boolean
  /** "logged" re-applies the recorded outcomes (right when nothing changed); "simulated" estimates them. */
  audio?: AudioMode
}

export interface ReplayResult {
  /** The replayed log: session, frames, health, voice, and the alerts and drops this replay produced. */
  events: TelemetryEvent[]
  alerts: AlertRow[]
  drops: Extract<TelemetryEvent, { kind: 'drop' }>[]
  frames: number
  audio: AudioMode
}

// Speech takes roughly this long per character at rate 1 when estimating how long an alert occupies the audio.
const SIM_SPEECH_MS_PER_CHAR = 65

const DROP_OUTCOME: Partial<Record<DropRecord['reason'], AlertOutcome>> = {
  stale: 'dropped-stale',
  'track-gone': 'dropped-track-gone',
}

/** Read a .jsonl log. Blank lines are skipped; a line that is not valid JSON names its line number. */
export function parseLog(text: string): TelemetryEvent[] {
  const events: TelemetryEvent[] = []
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return
    try {
      events.push(JSON.parse(line) as TelemetryEvent)
    } catch {
      throw new Error(`Log line ${index + 1} is not valid JSON`)
    }
  })
  return events
}

export function serializeLog(events: readonly TelemetryEvent[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join('')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Write `patch` into `target` in place (objects merge, everything else is replaced). */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(target[key])) mergeInto(target[key], value)
    else target[key] = structuredClone(value)
  }
}

/** Make `target` equal `snapshot` again, in place, so modules holding CONFIG's sub-objects still see it. */
function restoreInto(target: Record<string, unknown>, snapshot: Record<string, unknown>): void {
  for (const key of Object.keys(target)) if (!(key in snapshot)) delete target[key]
  for (const [key, value] of Object.entries(snapshot)) {
    if (isObject(value) && isObject(target[key])) restoreInto(target[key], value)
    else target[key] = structuredClone(value)
  }
}

function confidenceThreshold(label: string): number {
  const table = CONFIG.detection.confidenceThreshold
  return table[label] ?? table.default
}

/** Run a log through tracker, geometry, and policy. Throws if the log has no session entry. */
export function replayLog(events: readonly TelemetryEvent[], options: ReplayOptions = {}): ReplayResult {
  const session = events.find((e): e is SessionEvent => e.kind === 'session')
  if (!session) throw new Error('The log has no session entry, so it cannot be replayed')
  const audio: AudioMode = options.audio ?? (options.overrides && Object.keys(options.overrides).length > 0 ? 'simulated' : 'logged')

  const configRef = CONFIG as unknown as Record<string, unknown>
  const original = structuredClone(configRef)
  try {
    if (options.useLoggedConfig) mergeInto(configRef, session.config)
    if (options.overrides) mergeInto(configRef, options.overrides)
    return run(events, session, audio, options)
  } finally {
    restoreInto(configRef, original)
  }
}

function run(events: readonly TelemetryEvent[], session: SessionEvent, audio: AudioMode, options: ReplayOptions): ReplayResult {
  const tracker = new Tracker(CLASSES)
  const policy = new AlertPolicy(CLASSES)
  const settings = session.settings

  // Logged outcomes name the live alert ids; the replay's ids can differ, so match alerts by order of emission.
  const loggedIds = events.filter((e): e is AlertRow => e.kind === 'alert' && e.outcome === 'queued').map((e) => e.alert.id)
  const replayIdOfLogged = new Map<string, string>()
  const replayedIds: string[] = []

  const out: TelemetryEvent[] = []
  const alerts: AlertRow[] = []
  const drops: ReplayResult['drops'] = []
  const simulated: { atMs: number; alert: AlertEvent }[] = []
  let frames = 0

  const notify = (id: string, outcome: AlertOutcome, timeMs: number) => policy.notifyOutcome(id, outcome, timeMs)
  const flushSimulated = (untilMs: number) => {
    simulated.sort((a, b) => a.atMs - b.atMs)
    while (simulated.length > 0 && simulated[0].atMs <= untilMs) {
      const { atMs, alert } = simulated.shift()!
      notify(alert.id, 'finished', atMs)
      out.push({ kind: 'alert', timeMs: atMs, alert, outcome: 'finished', latencyMs: null, toneStartMs: null, speechStartMs: null })
    }
  }

  for (const event of events) {
    switch (event.kind) {
      case 'session':
        out.push({ ...event, replay: { overrides: options.overrides ?? {}, audio, useLoggedConfig: options.useLoggedConfig ?? false } })
        break
      case 'run-state':
        out.push(event)
        if (event.state !== 'running') {
          tracker.reset()
          policy.reset()
          simulated.length = 0
        }
        break
      case 'frame': {
        frames += 1
        if (audio === 'simulated') flushSimulated(event.timeMs)
        out.push(event)
        const result: FrameResult = {
          frameId: event.frameId,
          captureTimeMs: event.captureTimeMs,
          receivedTimeMs: event.receivedTimeMs,
          frameWidth: event.frameWidth,
          frameHeight: event.frameHeight,
          inputSize: session.inputSize,
          backend: session.backend ?? 'wasm',
          timings: event.timings,
          meanLuma: event.meanLuma,
          // The log holds what passed the live thresholds, so a replay can raise a threshold but never lower it.
          detections: event.detections.filter((d) => d.confidence >= confidenceThreshold(d.label)),
        }
        const tracks = tracker.update(result, event.orientation, settings)
        const { emitted, drops: dropped } = policy.update(tracks, event.timeMs, event.captureTimeMs)
        for (const drop of dropped) {
          const row = { kind: 'drop' as const, timeMs: event.timeMs, alert: drop.alert, trackId: drop.trackId, reason: drop.reason }
          drops.push(row)
          out.push(row)
          const outcome = DROP_OUTCOME[drop.reason]
          if (outcome) notify(drop.alert.id, outcome, event.timeMs)
        }
        for (const { alert } of emitted) {
          const row: AlertRow = { kind: 'alert', timeMs: event.timeMs, alert, outcome: 'queued', latencyMs: null }
          alerts.push(row)
          out.push(row)
          const index = replayedIds.length
          replayedIds.push(alert.id)
          if (loggedIds[index] !== undefined) replayIdOfLogged.set(loggedIds[index], alert.id)
          if (audio === 'simulated') {
            const speechMs = alert.phrase.length * SIM_SPEECH_MS_PER_CHAR / Math.max(0.1, settings.speechRate)
            simulated.push({
              atMs: event.timeMs + CONFIG.audio.toneDurationMs + CONFIG.audio.toneToSpeechGapMs + speechMs,
              alert,
            })
          }
        }
        break
      }
      case 'alert': {
        if (event.outcome === 'queued' || audio !== 'logged') break
        const id = replayIdOfLogged.get(event.alert.id)
        if (id === undefined) break // the replay never sent this alert
        notify(id, event.outcome, event.timeMs)
        out.push({ ...event, alert: { ...event.alert, id } })
        break
      }
      case 'health':
      case 'voice':
      case 'error':
        out.push(event)
        break
      case 'orientation':
      case 'tracks':
      case 'drop':
        break // not inputs of a replay; the replay writes its own drops
    }
  }
  if (audio === 'simulated') flushSimulated(Infinity)
  return { events: out, alerts, drops, frames, audio }
}

/** The alerts the policy sent in a log (the "queued" entries), in order. */
export function loggedAlerts(events: readonly TelemetryEvent[]): AlertRow[] {
  return events.filter((e): e is AlertRow => e.kind === 'alert' && e.outcome === 'queued')
}

export interface AlertComparison {
  same: boolean
  logged: number
  replayed: number
  differences: string[]
}

/** Compare two lists of sent alerts by time, priority, object phrase, track, direction, and frame. */
export function compareAlerts(logged: readonly AlertRow[], replayed: readonly AlertRow[]): AlertComparison {
  const differences: string[] = []
  const count = Math.max(logged.length, replayed.length)
  for (let i = 0; i < count; i++) {
    const a = logged[i]
    const b = replayed[i]
    if (!a || !b) {
      differences.push(`#${i + 1}: ${a ? 'logged' : 'replayed'} has no such alert (${(a ?? b).alert.phrase} at ${(a ?? b).timeMs.toFixed(0)} ms)`)
      continue
    }
    const same =
      a.timeMs === b.timeMs &&
      a.alert.priority === b.alert.priority &&
      a.alert.phrase === b.alert.phrase &&
      a.alert.trackId === b.alert.trackId &&
      a.alert.frameTimeMs === b.alert.frameTimeMs &&
      (a.alert.pan === b.alert.pan || Math.abs((a.alert.pan ?? 0) - (b.alert.pan ?? 0)) < 1e-9)
    if (!same) {
      differences.push(
        `#${i + 1}: logged "${a.alert.phrase}" (${a.alert.priority}) at ${a.timeMs.toFixed(0)} ms, ` +
          `replayed "${b.alert.phrase}" (${b.alert.priority}) at ${b.timeMs.toFixed(0)} ms`,
      )
    }
  }
  return { same: differences.length === 0, logged: logged.length, replayed: replayed.length, differences }
}
