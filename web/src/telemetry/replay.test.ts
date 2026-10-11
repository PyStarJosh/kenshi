import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import type { TelemetryEvent } from '../core/types'
import { simulateWalk } from './fixtureWalk'
import { compareAlerts, loggedAlerts, parseLog, replayLog, serializeLog } from './replay'
import fixtureText from '../../../field-tests/fixture/walk-fixture.jsonl?raw'


const fixtureEvents = () => parseLog(fixtureText)

describe('replay with unchanged settings', () => {
  test('reproduces the alerts of a walk run through the live pipeline', () => {
    const walk = simulateWalk()
    const result = replayLog(walk.events, { useLoggedConfig: true })
    const comparison = compareAlerts(loggedAlerts(walk.events), result.alerts)
    expect(comparison.differences).toEqual([])
    expect(comparison.logged).toBeGreaterThanOrEqual(3)
    expect(result.audio).toBe('logged')
  })

  test('reproduces the alerts of the committed fixture log', () => {
    const events = fixtureEvents()
    const result = replayLog(events, { useLoggedConfig: true })
    const comparison = compareAlerts(loggedAlerts(events), result.alerts)
    expect(comparison.differences).toEqual([])
    expect(comparison.logged).toBe(4)
    expect(result.frames).toBe(events.filter((e) => e.kind === 'frame').length)
  })

  test('also reproduces the drops before audio and the outcomes the policy was told about', () => {
    const events = fixtureEvents()
    const result = replayLog(events, { useLoggedConfig: true })
    const logged = events.filter((e) => e.kind === 'drop')
    expect(result.drops.map((d) => [d.timeMs, d.reason, d.trackId])).toEqual(logged.map((d) => [d.timeMs, d.reason, d.trackId]))
    const outcomes = (list: TelemetryEvent[]) => list.filter((e) => e.kind === 'alert' && e.outcome !== 'queued').map((e) => (e as { outcome: string }).outcome)
    expect(outcomes(result.events)).toEqual(outcomes(events))
  })

  test('writes a log that carries over the frame timings and the audio times for the evaluation', () => {
    const result = replayLog(fixtureEvents(), { useLoggedConfig: true })
    const text = serializeLog(result.events)
    const again = parseLog(text)
    expect(again).toHaveLength(result.events.length)
    expect(again[0]).toMatchObject({ kind: 'session', replay: { audio: 'logged', overrides: {} } })
    expect(again.some((e) => e.kind === 'alert' && e.speechStartMs != null)).toBe(true)
    expect(again.filter((e) => e.kind === 'frame').length).toBe(result.frames)
  })

  test('leaves CONFIG exactly as it found it', () => {
    const before = structuredClone(CONFIG)
    replayLog(fixtureEvents(), { useLoggedConfig: true, overrides: { alerts: { urgentDistanceM: 9 }, detection: { confidenceThreshold: { extra: 1 } } } })
    expect(CONFIG).toEqual(before)
  })
})

describe('replay with other settings', () => {
  test('a higher confidence threshold removes the alerts it should', () => {
    const events = fixtureEvents()
    const result = replayLog(events, { useLoggedConfig: true, overrides: { detection: { confidenceThreshold: { default: 0.99, person: 0.99, backpack: 0.99, chair: 0.99 } } } })
    expect(result.alerts).toHaveLength(0)
    expect(compareAlerts(loggedAlerts(events), result.alerts).same).toBe(false)
  })

  test('a larger corridor depth announces the backpack earlier', () => {
    const events = fixtureEvents()
    const base = replayLog(events, { useLoggedConfig: true })
    const wide = replayLog(events, { useLoggedConfig: true, overrides: { geometry: { corridorDepthM: 5.5 } } })
    const first = (r: typeof base) => r.alerts.find((a) => a.alert.phrase.startsWith('Backpack'))!.timeMs
    expect(first(wide)).toBeLessThan(first(base))
  })

  test('with overrides the audio is simulated, and every alert is reported finished so the next can go', () => {
    const events = fixtureEvents()
    const result = replayLog(events, { useLoggedConfig: true, overrides: { alerts: { minGapMs: 800 } } })
    expect(result.audio).toBe('simulated')
    expect(result.alerts.length).toBeGreaterThanOrEqual(3)
    const finished = result.events.filter((e) => e.kind === 'alert' && e.outcome === 'finished')
    // Only the alert still being spoken when detection was paused is cut off (a pause resets the policy).
    expect(finished.length).toBe(result.alerts.length - 1)
    // Simulated outcomes carry no tone or speech times: nothing here was heard.
    expect(finished.every((e) => e.kind === 'alert' && e.speechStartMs === null)).toBe(true)
  })

  test('audio can be forced either way', () => {
    const events = fixtureEvents()
    expect(replayLog(events, { useLoggedConfig: true, audio: 'simulated' }).audio).toBe('simulated')
    expect(replayLog(events, { overrides: { alerts: {} }, audio: 'logged' }).audio).toBe('logged')
  })
})

describe('log files', () => {
  test('a line that is not JSON is reported with its number', () => {
    expect(() => parseLog('{"kind":"error"}\nnot json\n')).toThrow('Log line 2')
  })

  test('blank lines are skipped', () => {
    expect(parseLog('\n{"kind":"error"}\n\n')).toHaveLength(1)
  })

  test('a log without a session entry cannot be replayed', () => {
    expect(() => replayLog([{ kind: 'error', timeMs: 0, source: 'x', message: 'y' }])).toThrow('no session entry')
  })

  test('compareAlerts names the first alert that differs', () => {
    const events = fixtureEvents()
    const alerts = loggedAlerts(events)
    const changed = alerts.map((a, i) => (i === 1 ? { ...a, alert: { ...a.alert, phrase: 'Other' } } : a))
    const comparison = compareAlerts(alerts, changed)
    expect(comparison.same).toBe(false)
    expect(comparison.differences[0]).toContain('#2')
    expect(compareAlerts(alerts, alerts.slice(0, 2)).differences[0]).toContain('#3')
  })
})
