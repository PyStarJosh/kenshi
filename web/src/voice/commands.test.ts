import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { parseCommand, stepSpeechRate } from './commands'

describe('parseCommand', () => {
  test.each([
    ["What's around me?", 'whats-around'],
    ['around', 'whats-around'],
    ["what's here", 'whats-around'],
    ['Pause', 'pause'],
    ['please stop', 'pause'],
    ['Resume.', 'resume'],
    ['continue', 'resume'],
    ['repeat that', 'repeat'],
    ['say that again', 'repeat'],
    ['slower', 'slower'],
    ['slow down please', 'slower'],
    ['faster', 'faster'],
    ['speed up', 'faster'],
    ['help', 'help'],
    ['what can I say', 'help'],
  ])('%s -> %s', (text, intent) => {
    expect(parseCommand(text)).toBe(intent)
  })

  test('unknown or empty text is unknown', () => {
    expect(parseCommand('banana')).toBe('unknown')
    expect(parseCommand('')).toBe('unknown')
    expect(parseCommand('   ')).toBe('unknown')
  })

  test('"what do you see around me" is the around command', () => {
    expect(parseCommand('what do you see around me')).toBe('whats-around')
  })
})

describe('stepSpeechRate', () => {
  test('steps by the configured amount without drift', () => {
    const { speechRateStep } = CONFIG.audio
    expect(stepSpeechRate(1, 'faster')).toBeCloseTo(1 + speechRateStep)
    expect(stepSpeechRate(stepSpeechRate(1, 'slower'), 'slower')).toBeCloseTo(1 - 2 * speechRateStep)
  })

  test('stays within the allowed range', () => {
    expect(stepSpeechRate(CONFIG.audio.speechRateMax, 'faster')).toBe(CONFIG.audio.speechRateMax)
    expect(stepSpeechRate(CONFIG.audio.speechRateMin, 'slower')).toBe(CONFIG.audio.speechRateMin)
  })
})
