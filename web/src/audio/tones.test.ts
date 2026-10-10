import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { alertTone, listeningTone, panFromAngle, toneLengthMs, urgentPulseGapMs, warningTone } from './tones'

describe('panFromAngle', () => {
  test('center, edges, and beyond the frame', () => {
    expect(panFromAngle(0, 60)).toBe(0)
    expect(panFromAngle(-30, 60)).toBe(-1)
    expect(panFromAngle(15, 60)).toBeCloseTo(0.5)
    expect(panFromAngle(80, 60)).toBe(1)
    expect(panFromAngle(-80, 60)).toBe(-1)
  })

  test('bad input gives center rather than NaN', () => {
    expect(panFromAngle(Number.NaN, 60)).toBe(0)
    expect(panFromAngle(10, 0)).toBe(0)
  })
})

describe('urgentPulseGapMs', () => {
  const { urgentPulseGapMinMs: min, urgentPulseGapMaxMs: max, urgentPulseNearM: near } = CONFIG.audio
  const far = CONFIG.alerts.urgentDistanceM

  test('closer pulses faster, clamped at both ends', () => {
    expect(urgentPulseGapMs(far)).toBe(max)
    expect(urgentPulseGapMs(far + 5)).toBe(max)
    expect(urgentPulseGapMs(near)).toBe(min)
    expect(urgentPulseGapMs(0)).toBe(min)
    expect(urgentPulseGapMs((near + far) / 2)).toBeCloseTo((min + max) / 2)
  })

  test('unknown distance pulses at the fastest rate', () => {
    expect(urgentPulseGapMs(null)).toBe(min)
    expect(urgentPulseGapMs(Number.NaN)).toBe(min)
  })
})

describe('alertTone', () => {
  test('urgent is several high pulses, closer is shorter overall', () => {
    const near = alertTone('urgent', -0.5, 0.5)
    const far = alertTone('urgent', -0.5, 1.5)
    expect(near.notes).toHaveLength(CONFIG.audio.urgentPulseCount)
    expect(near.notes.every((n) => n.hz === CONFIG.audio.urgentToneHz)).toBe(true)
    expect(near.pan).toBe(-0.5)
    expect(toneLengthMs(near)).toBeLessThan(toneLengthMs(far))
  })

  test('normal is one mid tone, info one softer low tone', () => {
    const normal = alertTone('normal', 0.3, 2)
    const info = alertTone('info', 0, null)
    expect(normal.notes).toEqual([{ offsetMs: 0, durationMs: CONFIG.audio.toneDurationMs, hz: CONFIG.audio.normalToneHz, gain: 1 }])
    expect(info.notes).toHaveLength(1)
    expect(info.notes[0].hz).toBeLessThan(normal.notes[0].hz)
    expect(info.notes[0].gain).toBeLessThan(1)
  })

  test('pan is clamped', () => {
    expect(alertTone('normal', 3, 2).pan).toBe(1)
    expect(alertTone('normal', Number.NaN, 2).pan).toBe(0)
  })

  test('the warning is two different centered tones', () => {
    const warning = warningTone()
    expect(warning.pan).toBe(0)
    expect(warning.notes).toHaveLength(2)
    expect(warning.notes[0].hz).not.toBe(warning.notes[1].hz)
  })
})

describe('listeningTone', () => {
  test('rises when listening starts and falls when it stops, centered', () => {
    const start = listeningTone('start')
    const stop = listeningTone('stop')
    expect(start.pan).toBe(0)
    expect(start.notes[0].hz).toBeLessThan(start.notes[1].hz)
    expect(stop.notes[0].hz).toBeGreaterThan(stop.notes[1].hz)
  })

  test('differs from the warning and alert tones', () => {
    const hz = listeningTone('start').notes.map((n) => n.hz)
    expect(hz).not.toEqual(warningTone().notes.map((n) => n.hz))
    expect(hz).not.toContain(CONFIG.audio.normalToneHz)
  })
})
