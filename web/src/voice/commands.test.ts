import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { parseCommand, stepSpeechRate } from './commands'

describe('parseCommand', () => {
  test.each([
    ['Pause', 'pause'],
    ['hold on', 'pause'],
    ['Resume.', 'resume'],
    ['continue', 'resume'],
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

  test('"stop" is not pause: it is kept free for cancelling Find (R4)', () => {
    expect(parseCommand('stop')).toBe('unknown')
    expect(parseCommand('please stop')).toBe('unknown')
  })

  test('asking what is around is not a command: objects are never read out', () => {
    for (const text of ["What's around me?", 'what do you see around me', 'repeat that']) {
      expect(parseCommand(text)).toBe('unknown')
    }
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
