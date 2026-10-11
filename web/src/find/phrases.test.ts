import { describe, expect, test } from 'vitest'
import {
  arrivedPhrase,
  capitalize,
  classifyDirection,
  directionPhrase,
  directionWords,
  FIND_PHRASES,
  foundPhrase,
  lookingFor,
  lostPhrase,
  notFoundPhrase,
  signPhrase,
  withArticle,
} from './phrases'

describe('classifyDirection', () => {
  test.each([
    [0, 'ahead'],
    [15, 'ahead'],
    [-15, 'ahead'],
    [15.1, 'slightly-right'],
    [-15.1, 'slightly-left'],
    [45, 'slightly-right'],
    [-45, 'slightly-left'],
    [45.1, 'right'],
    [-45.1, 'left'],
    [90, 'right'],
    [-135, 'left'],
    [135.1, 'behind'],
    [-135.1, 'behind'],
    [180, 'behind'],
  ] as const)('%d degrees -> %s', (bearing, direction) => {
    expect(classifyDirection(bearing)).toBe(direction)
  })
})

describe('the sentences', () => {
  test('the owner\'s fixed lines', () => {
    expect(FIND_PHRASES.privacy).toBe('Find sends camera photos to Google Gemini to locate things.')
    expect(FIND_PHRASES.notInView).toBe('Not in view. Turn slowly to your right.')
    expect(FIND_PHRASES.unavailable).toBe("Find isn't available right now.")
  })

  test('found, lost, arrived, and looking', () => {
    expect(foundPhrase('chair', 'ahead')).toBe('Chair found, ahead.')
    expect(foundPhrase('exit', 'behind')).toBe('Exit found, behind you.')
    expect(foundPhrase('door', 'slightly-left')).toBe('Door found, slightly left.')
    expect(foundPhrase('elevator', 'right')).toBe('Elevator found, to your right.')
    expect(lostPhrase('chair')).toBe('Lost the chair. Scanning.')
    expect(arrivedPhrase('chair')).toBe('Chair ahead, within reach.')
    expect(lookingFor('chair')).toBe('Looking for a chair.')
    expect(lookingFor('exit')).toBe('Looking for an exit.')
  })

  test('direction updates', () => {
    expect(directionPhrase('slightly-right')).toBe('Slightly right.')
    expect(directionPhrase('left')).toBe('To your left.')
    expect(directionWords('behind')).toBe('behind you')
  })

  test('articles and capitals', () => {
    expect(withArticle('umbrella')).toBe('an umbrella')
    expect(withArticle('trash can')).toBe('a trash can')
    expect(capitalize('')).toBe('')
    expect(capitalize('restroom sign')).toBe('Restroom sign')
  })
})

describe('signPhrase', () => {
  test.each([
    ['EXIT ->', 'A sign says exit, to the right.'],
    ['EXIT →', 'A sign says exit, to the right.'],
    ['<- Restrooms', 'A sign says restrooms, to the left.'],
    ['← Elevator', 'A sign says elevator, to the left.'],
    ['EXIT ↑', 'A sign says exit, ahead.'],
    ['Stairs', 'A sign says stairs.'],
    ['  Gate   4  =>', 'A sign says gate 4, to the right.'],
  ])('%s', (hint, expected) => {
    expect(signPhrase(hint)).toBe(expected)
  })

  test('an arrow with no words says nothing', () => {
    expect(signPhrase('->')).toBe('')
    expect(signPhrase('   ')).toBe('')
  })
})

describe('notFoundPhrase', () => {
  test('says what could not be found, never that it is not there', () => {
    expect(notFoundPhrase('chair', null)).toBe("I couldn't find a chair here. Try another spot or ask for something else.")
    expect(notFoundPhrase('exit', null)).toBe("I couldn't find an exit here. Try another spot or ask for something else.")
  })

  test('adds what a sign said, with its direction', () => {
    expect(notFoundPhrase('exit', 'EXIT ->')).toBe(
      "I couldn't find an exit here. Try another spot or ask for something else. A sign says exit, to the right.",
    )
  })

  test('a sign hint with nothing readable adds nothing', () => {
    expect(notFoundPhrase('exit', '->')).toBe("I couldn't find an exit here. Try another spot or ask for something else.")
  })
})
