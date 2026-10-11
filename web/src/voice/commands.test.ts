import { describe, expect, test } from 'vitest'
import { CONFIG } from '../core/config'
import { parseCommand, parseFind, stepSpeechRate } from './commands'

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

  test('"stop" is not pause: it cancels Find', () => {
    for (const text of ['stop', 'please stop', 'cancel', 'never mind']) expect(parseCommand(text)).toBe('stop')
    expect(parseCommand('pause')).toBe('pause')
  })

  test('asking what is around is not a command: objects are never read out', () => {
    for (const text of ["What's around me?", 'what do you see around me', 'repeat that']) {
      expect(parseCommand(text)).toBe('unknown')
    }
  })
})

describe('Find commands', () => {
  test.each([
    ['find chair', 'chair'],
    ['find the exit', 'exit'],
    ['Find my keys.', 'keys'],
    ['find me a chair', 'chair'],
    ['locate the elevator', 'elevator'],
    ['look for a door', 'door'],
    ['search for trash can', 'trash can'],
    ['where is the exit', 'exit'],
    ["Where's the restroom sign?", 'restroom sign'],
    ['where are my glasses', 'glasses'],
    ['take me to the stairs', 'stairs'],
    ['take me to an elevator please', 'elevator'],
    ['please find the door', 'door'],
  ])('%s -> find %s', (text, target) => {
    expect(parseCommand(text)).toBe('find')
    expect(parseFind(text)).toBe(target)
  })

  test('text that is not a Find command gives no target', () => {
    for (const text of ['pause', 'where am i', 'take me home', 'find', 'find the', 'hello', '']) {
      expect(parseFind(text)).toBeNull()
    }
  })

  test('a target containing a command word is still a Find ("find the bus stop")', () => {
    expect(parseCommand('find the bus stop')).toBe('find')
    expect(parseFind('find the bus stop')).toBe('bus stop')
    expect(parseCommand('find the start sign')).toBe('find')
  })

  test('a target is capped at the configured length', () => {
    expect(parseFind(`find ${'a'.repeat(200)}`)!.length).toBe(CONFIG.find.maxTargetChars)
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
